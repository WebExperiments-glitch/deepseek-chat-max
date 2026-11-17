import { openDB, type DBSchema } from './idb.js'
import { getJson, postJson, postRaw, putBlob } from '../api/localServer.js'
import { readStorage, writeStorage } from './storage.js'

/**
 * 把浏览器里的旧数据搬到本机 Node + SQLite。
 *
 * 两条来源都处理：
 * 1. 上一版的 sql.js 快照（chat-demo-sql）：整体上传，服务端 ATTACH 后复制；
 * 2. 更早的 IndexedDB（chat-demo / chat-demo-memory）：会话、附件、记忆逐项上传。
 *
 * 旧库一律保留，迁移失败可以重试；服务端按 id 覆盖写入，重复执行也安全。
 */

const FLAG = 'chat-demo:server-migrated'

interface SnapshotDB extends DBSchema {
  database: { key: string; value: Uint8Array }
}

type LegacySession = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: unknown[]
}

type LegacyMemory = Record<string, unknown> & { id: string }

let task: Promise<void> | null = null

const databaseExists = async (name: string): Promise<boolean> => {
  if (typeof indexedDB.databases !== 'function') {
    return true
  }
  try {
    return (await indexedDB.databases()).some((item) => item.name === name)
  } catch {
    return true
  }
}

const readSnapshot = async (): Promise<Uint8Array | null> => {
  if (!(await databaseExists('chat-demo-sql'))) {
    return null
  }
  const db = await openDB<SnapshotDB>('chat-demo-sql')
  try {
    return (await db.get('database', 'main')) ?? null
  } catch {
    return null
  } finally {
    db.close()
  }
}

const readLegacy = async (): Promise<{
  sessions: LegacySession[]
  files: { id: string; blob: Blob }[]
  memories: LegacyMemory[]
}> => {
  const sessions: LegacySession[] = []
  const files: { id: string; blob: Blob }[] = []
  const memories: LegacyMemory[] = []

  if (await databaseExists('chat-demo')) {
    const db = await openDB('chat-demo')
    try {
      if (db.objectStoreNames.contains('sessions')) {
        sessions.push(...((await db.getAll('sessions')) as LegacySession[]))
      }
      if (db.objectStoreNames.contains('files')) {
        files.push(...((await db.getAll('files')) as { id: string; blob: Blob }[]))
      }
    } finally {
      db.close()
    }
  }

  if (await databaseExists('chat-demo-memory')) {
    const db = await openDB('chat-demo-memory')
    try {
      if (db.objectStoreNames.contains('memories')) {
        memories.push(...((await db.getAll('memories')) as LegacyMemory[]))
      }
    } finally {
      db.close()
    }
  }

  return { sessions, files, memories }
}

const run = async (): Promise<void> => {
  if (readStorage(FLAG) === '1') {
    return
  }
  const status = await getJson<{ imported: boolean }>('/api/migrate/status')
  if (status.imported) {
    writeStorage(FLAG, '1')
    return
  }

  const snapshot = await readSnapshot()
  if (snapshot) {
    await postRaw('/api/migrate/legacy', snapshot)
  }

  const legacy = await readLegacy()
  for (const file of legacy.files) {
    await putBlob(`/api/files/${encodeURIComponent(file.id)}`, file.blob)
  }
  if (legacy.sessions.length > 0 || legacy.memories.length > 0) {
    await postJson('/api/migrate/records', {
      sessions: legacy.sessions,
      memories: legacy.memories,
    })
  }

  writeStorage(FLAG, '1')
}

/** 首次访问时执行一次；失败不写标记，下次启动会重试 */
export const ensureServerMigrated = (): Promise<void> => (task ??= run())
