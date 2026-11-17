import type { Database } from 'sql.js'
import { sqlAll, sqlGet, sqlTransaction } from '../platform/sqlite.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/**
 * 会话与附件的本地存储。
 *
 * 底层是浏览器内的 SQLite：sessions 存会话 JSON 与列表字段，files 存附件原件。
 * 会话正文保持 JSON 的原因见 sqlSchema.ts：分支树和消息块的顺序仍由上层维护，
 * 这里只负责原子读写；列表查询只取四个列，不会把全部消息读进内存。
 *
 * 文件原件按附件本地 id 存储，所有引用同一 id 的消息共用一份；
 * 用于缩略图、打开查看，以及没有 serverId 时补传。
 */
export type StoredFile = {
  id: string
  blob: Blob
}

type SessionRow = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

const fileIdsOf = (session: Session): string[] => [
  ...new Set(
    session.messages.flatMap((message) =>
      message.role === 'user' ? message.files.map((file) => file.id) : []
    )
  ),
]

const writeSession = (
  db: Database,
  table: 'sessions' | 'staging_sessions',
  session: Session
) => {
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

const encodeFile = async (file: StoredFile) => ({
  id: file.id,
  mimeType: file.blob.type,
  bytes: new Uint8Array(await file.blob.arrayBuffer()),
})

const writeFile = (db: Database, table: 'files' | 'staging_files', file: {
  id: string
  mimeType: string
  bytes: Uint8Array
}) => {
  db.run(`INSERT OR REPLACE INTO ${table} (id, mimeType, data) VALUES (?, ?, ?)`, [
    file.id,
    file.mimeType,
    file.bytes,
  ])
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (
    await sqlAll<SessionRow>(
      'SELECT id, title, createdAt, updatedAt FROM sessions ORDER BY updatedAt DESC'
    )
  ).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> => {
  const row = await sqlGet<{ payload: string }>('SELECT payload FROM sessions WHERE id = ?', [id])
  if (!row) {
    return undefined
  }
  try {
    return JSON.parse(row.payload) as Session
  } catch {
    return undefined
  }
}

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const encoded = await Promise.all(files.map(encodeFile))
  await sqlTransaction((db) => {
    writeSession(db, 'sessions', session)
    for (const file of encoded) {
      writeFile(db, 'files', file)
    }
  })
}

/** 未打开的会话也可重命名，只更新标题列与会话 JSON。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  await sqlTransaction((db) => {
    const result = db.exec('SELECT payload FROM sessions WHERE id = ?', [id])
    const payload = result[0]?.values[0]?.[0]
    if (typeof payload !== 'string') {
      return
    }
    const session = JSON.parse(payload) as Session
    session.title = title
    db.run('UPDATE sessions SET title = ?, payload = ? WHERE id = ?', [
      title,
      JSON.stringify(session),
      id,
    ])
  })
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  await sqlTransaction((db) => {
    const own = db.exec('SELECT fileIds FROM sessions WHERE id = ?', [sessionId])
    const raw = own[0]?.values[0]?.[0]
    let ids: string[] = []
    if (typeof raw === 'string') {
      try {
        ids = JSON.parse(raw) as string[]
      } catch {
        ids = []
      }
    }
    db.run('DELETE FROM sessions WHERE id = ?', [sessionId])
    if (ids.length === 0) {
      return
    }
    const referenced = new Set<string>()
    const remaining = db.exec('SELECT fileIds FROM sessions')
    for (const value of remaining[0]?.values ?? []) {
      try {
        for (const id of JSON.parse(String(value[0])) as string[]) {
          referenced.add(id)
        }
      } catch {
        // 摘要字段损坏时跳过，不影响删除会话本身
      }
    }
    for (const id of ids) {
      if (!referenced.has(id)) {
        db.run('DELETE FROM files WHERE id = ?', [id])
      }
    }
  })
}

export const saveFiles = async (files: StoredFile[]): Promise<void> => {
  const encoded = await Promise.all(files.map(encodeFile))
  await sqlTransaction((db) => {
    for (const file of encoded) {
      writeFile(db, 'files', file)
    }
  })
}

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const row = await sqlGet<{ mimeType: string; data: Uint8Array }>(
    'SELECT mimeType, data FROM files WHERE id = ?',
    [id]
  )
  if (!row) {
    return undefined
  }
  // 复制一份，避免 Blob 持有 WASM 内存视图
  return new Blob([new Uint8Array(row.data)], { type: row.mimeType })
}

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  await sqlTransaction((db) => {
    db.run('DELETE FROM staging_sessions')
    db.run('DELETE FROM staging_files')
  })
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await sqlTransaction((db) => writeSession(db, 'staging_sessions', session))
}

export const saveStagingFiles = async (files: StoredFile[]): Promise<void> => {
  const encoded = await Promise.all(files.map(encodeFile))
  await sqlTransaction((db) => {
    for (const file of encoded) {
      writeFile(db, 'staging_files', file)
    }
  })
}

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  await sqlTransaction((db) => {
    const result = db.exec('SELECT payload FROM staging_sessions')
    for (const value of result[0]?.values ?? []) {
      if (typeof value[0] !== 'string') {
        continue
      }
      const session = JSON.parse(value[0]) as Session
      let changed = false
      for (const message of session.messages) {
        if (message.role !== 'user') {
          continue
        }
        for (const file of message.files) {
          const type = types.get(file.id) ?? ''
          if (file.mimeType !== type) {
            file.mimeType = type
            changed = true
          }
        }
      }
      if (changed) {
        db.run('UPDATE staging_sessions SET payload = ? WHERE id = ?', [
          JSON.stringify(session),
          session.id,
        ])
      }
    }
  })
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话与原件，并清空暂存。
 * 返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
 */
export const commitStaging = async (): Promise<SessionSummary[]> =>
  sqlTransaction((db) => {
    const summaries: SessionSummary[] = []
    const result = db.exec('SELECT id, title, createdAt, updatedAt FROM staging_sessions')
    for (const value of result[0]?.values ?? []) {
      summaries.push(
        toSessionSummary({
          id: String(value[0]),
          title: String(value[1]),
          createdAt: Number(value[2]),
          updatedAt: Number(value[3]),
        })
      )
    }
    db.run('DELETE FROM sessions')
    db.run('DELETE FROM files')
    db.run(
      `INSERT INTO sessions (id, title, createdAt, updatedAt, fileIds, payload)
       SELECT id, title, createdAt, updatedAt, fileIds, payload FROM staging_sessions`
    )
    db.run('INSERT INTO files (id, mimeType, data) SELECT id, mimeType, data FROM staging_files')
    db.run('DELETE FROM staging_sessions')
    db.run('DELETE FROM staging_files')
    return summaries
  })

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
