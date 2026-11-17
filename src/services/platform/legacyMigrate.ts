import type { Database } from 'sql.js'
import { openDB } from './idb.js'

/**
 * 把旧的 IndexedDB 数据搬到 SQLite。
 *
 * 只读取正式库，不删除旧库：迁移失败或新库损坏时，用户仍可以把旧库当作回滚点。
 * 迁移只做一次，成功后写 meta 标记；失败不写标记，下次启动会重试。
 */

type LegacySession = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: { role: string; files?: { id: string }[] }[]
}

type LegacyFile = { id: string; blob: Blob }

type LegacyMemory = {
  id: string
  sourceSessionId: string
  kind: string
  text: string
  keywords: string[]
  stability: number
  difficulty: number
  reps: number
  lapses: number
  createdAt: number
  lastReviewAt: number
  sourceMessageIds: string[]
  pinned: boolean
  archived: boolean
  manual: boolean
  importance: number
}

const MIGRATED_KEY = 'legacy_migrated'

const hasMigrated = (db: Database): boolean => {
  const result = db.exec(`SELECT value FROM meta WHERE key = '${MIGRATED_KEY}'`)
  return result.length > 0 && result[0].values.length > 0
}

/** 先判断数据库是否存在，避免只为探测就新建一个空库 */
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

const fileIdsOf = (session: LegacySession): string[] => [
  ...new Set(
    session.messages.flatMap((message) =>
      message.role === 'user' ? (message.files ?? []).map((file) => file.id) : []
    )
  ),
]

const readLegacySessions = async (): Promise<{ sessions: LegacySession[]; files: LegacyFile[] }> => {
  if (!(await databaseExists('chat-demo'))) {
    return { sessions: [], files: [] }
  }
  const db = await openDB('chat-demo')
  try {
    const sessions = db.objectStoreNames.contains('sessions')
      ? ((await db.getAll('sessions')) as LegacySession[])
      : []
    const files = db.objectStoreNames.contains('files')
      ? ((await db.getAll('files')) as LegacyFile[])
      : []
    return { sessions, files }
  } finally {
    db.close()
  }
}

const readLegacyMemories = async (): Promise<LegacyMemory[]> => {
  if (!(await databaseExists('chat-demo-memory'))) {
    return []
  }
  const db = await openDB('chat-demo-memory')
  try {
    return db.objectStoreNames.contains('memories')
      ? ((await db.getAll('memories')) as LegacyMemory[])
      : []
  } finally {
    db.close()
  }
}

const insertSession = (db: Database, table: 'sessions' | 'staging_sessions', session: LegacySession) => {
  db.run(
    `INSERT OR REPLACE INTO ${table} (id, title, createdAt, updatedAt, fileIds, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      session.id,
      session.title,
      session.createdAt,
      session.updatedAt,
      JSON.stringify(fileIdsOf(session)),
      JSON.stringify(session),
    ]
  )
}

const insertMemory = (db: Database, memory: LegacyMemory) => {
  db.run(
    `INSERT OR REPLACE INTO memories
      (id, sourceSessionId, kind, text, keywords, stability, difficulty, reps, lapses,
       createdAt, lastReviewAt, sourceMessageIds, pinned, archived, manual, importance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      memory.id,
      memory.sourceSessionId,
      memory.kind,
      memory.text,
      JSON.stringify(memory.keywords ?? []),
      memory.stability,
      memory.difficulty,
      memory.reps,
      memory.lapses,
      memory.createdAt,
      memory.lastReviewAt,
      JSON.stringify(memory.sourceMessageIds ?? []),
      memory.pinned ? 1 : 0,
      memory.archived ? 1 : 0,
      memory.manual ? 1 : 0,
      memory.importance,
    ]
  )
}

export const runLegacyMigration = async (db: Database): Promise<void> => {
  if (hasMigrated(db)) {
    return
  }
  try {
    const [{ sessions, files }, memories] = await Promise.all([
      readLegacySessions(),
      readLegacyMemories(),
    ])
    // Blob 读取是异步的，先全部转换完再进同步事务
    const encodedFiles = await Promise.all(
      files.map(async (file) => ({
        id: file.id,
        mimeType: file.blob.type,
        bytes: new Uint8Array(await file.blob.arrayBuffer()),
      }))
    )

    db.run('BEGIN')
    try {
      for (const session of sessions) {
        insertSession(db, 'sessions', session)
      }
      for (const file of encodedFiles) {
        db.run('INSERT OR REPLACE INTO files (id, mimeType, data) VALUES (?, ?, ?)', [
          file.id,
          file.mimeType,
          file.bytes,
        ])
      }
      for (const memory of memories) {
        insertMemory(db, memory)
      }
      db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('${MIGRATED_KEY}', '1')`)
      db.run('COMMIT')
    } catch (error) {
      db.run('ROLLBACK')
      throw error
    }
  } catch (error) {
    // 迁移失败不阻断使用：新库照常为空启动，下次打开再试
    // eslint-disable-next-line no-console
    console.error('[sqlite] legacy migration failed', error)
  }
}
