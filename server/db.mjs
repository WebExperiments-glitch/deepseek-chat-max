import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 本地 SQLite 数据层。
 *
 * 服务只绑定本机，浏览器通过 /api 读写同一个数据库文件。
 * 会话正文仍以 JSON 存在 payload 列：分支树和消息块顺序由前端维护，
 * 服务端只负责原子读写；列表字段单独建列，避免列表接口加载全部消息。
 */

const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data')
const DB_FILE = process.env.DB_FILE ?? path.join(DATA_DIR, 'chat-demo.db')

mkdirSync(DATA_DIR, { recursive: true })

const db = new DatabaseSync(DB_FILE)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  fileIds TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updatedAt DESC);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  mimeType TEXT NOT NULL,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS staging_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  fileIds TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staging_files (
  id TEXT PRIMARY KEY,
  mimeType TEXT NOT NULL,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  sourceSessionId TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  keywords TEXT NOT NULL,
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  reps INTEGER NOT NULL,
  lapses INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  lastReviewAt INTEGER NOT NULL,
  sourceMessageIds TEXT NOT NULL,
  pinned INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  manual INTEGER NOT NULL,
  importance REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_created ON memories(createdAt);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

db.exec(SCHEMA)

const fileIdsOf = (session) => [
  ...new Set(
    (session.messages ?? []).flatMap((message) =>
      message.role === 'user' ? (message.files ?? []).map((file) => file.id) : []
    )
  ),
]

const parseArray = (raw) => {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

const transaction = (task) => {
  db.exec('BEGIN')
  try {
    const result = task()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const writeSession = (table, session) => {
  db.prepare(
    `INSERT OR REPLACE INTO ${table} (id, title, createdAt, updatedAt, fileIds, payload)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.title,
    session.createdAt,
    session.updatedAt,
    JSON.stringify(fileIdsOf(session)),
    JSON.stringify(session)
  )
}

const writeFile = (table, id, mimeType, data) => {
  db.prepare(`INSERT OR REPLACE INTO ${table} (id, mimeType, data) VALUES (?, ?, ?)`).run(
    id,
    mimeType,
    data
  )
}

export const listSessions = () =>
  db
    .prepare('SELECT id, title, createdAt, updatedAt FROM sessions ORDER BY updatedAt DESC')
    .all()

export const getSession = (id) => {
  const row = db.prepare('SELECT payload FROM sessions WHERE id = ?').get(id)
  if (!row) {
    return null
  }
  try {
    return JSON.parse(row.payload)
  } catch {
    return null
  }
}

export const putSession = (session) => {
  writeSession('sessions', session)
}

export const renameSession = (id, title) => {
  const row = db.prepare('SELECT payload FROM sessions WHERE id = ?').get(id)
  if (!row) {
    return false
  }
  const session = JSON.parse(row.payload)
  session.title = title
  db.prepare('UPDATE sessions SET title = ?, payload = ? WHERE id = ?').run(
    title,
    JSON.stringify(session),
    id
  )
  return true
}

export const deleteSession = (id) =>
  transaction(() => {
    const row = db.prepare('SELECT fileIds FROM sessions WHERE id = ?').get(id)
    const own = row ? parseArray(row.fileIds) : []
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    if (own.length === 0) {
      return
    }
    const referenced = new Set()
    for (const item of db.prepare('SELECT fileIds FROM sessions').all()) {
      for (const fileId of parseArray(item.fileIds)) {
        referenced.add(fileId)
      }
    }
    for (const fileId of own) {
      if (!referenced.has(fileId)) {
        db.prepare('DELETE FROM files WHERE id = ?').run(fileId)
      }
    }
  })

export const putFiles = (files) =>
  transaction(() => {
    for (const file of files) {
      writeFile('files', file.id, file.mimeType, file.data)
      if (file.staging) {
        writeFile('staging_files', file.id, file.mimeType, file.data)
      }
    }
  })

export const getFile = (id) =>
  db.prepare('SELECT mimeType, data FROM files WHERE id = ?').get(id) ?? null

export const clearStaging = () =>
  transaction(() => {
    db.prepare('DELETE FROM staging_sessions').run()
    db.prepare('DELETE FROM staging_files').run()
  })

export const putStagingSession = (session) => {
  writeSession('staging_sessions', session)
}

export const updateStagingFileTypes = (types) =>
  transaction(() => {
    const map = new Map(types)
    for (const row of db.prepare('SELECT payload FROM staging_sessions').all()) {
      const session = JSON.parse(row.payload)
      let changed = false
      for (const message of session.messages ?? []) {
        if (message.role !== 'user') {
          continue
        }
        for (const file of message.files ?? []) {
          const type = map.get(file.id) ?? ''
          if (file.mimeType !== type) {
            file.mimeType = type
            changed = true
          }
        }
      }
      if (changed) {
        db.prepare('UPDATE staging_sessions SET payload = ? WHERE id = ?').run(
          JSON.stringify(session),
          session.id
        )
      }
    }
  })

export const commitStaging = () =>
  transaction(() => {
    const summaries = db
      .prepare('SELECT id, title, createdAt, updatedAt FROM staging_sessions')
      .all()
    db.prepare('DELETE FROM sessions').run()
    db.prepare('DELETE FROM files').run()
    db.prepare(
      `INSERT INTO sessions (id, title, createdAt, updatedAt, fileIds, payload)
       SELECT id, title, createdAt, updatedAt, fileIds, payload FROM staging_sessions`
    ).run()
    db.prepare(
      'INSERT INTO files (id, mimeType, data) SELECT id, mimeType, data FROM staging_files'
    ).run()
    db.prepare('DELETE FROM staging_sessions').run()
    db.prepare('DELETE FROM staging_files').run()
    return summaries
  })

const toMemory = (row) => ({
  id: row.id,
  sourceSessionId: row.sourceSessionId,
  kind: row.kind,
  text: row.text,
  keywords: parseArray(row.keywords),
  stability: row.stability,
  difficulty: row.difficulty,
  reps: row.reps,
  lapses: row.lapses,
  createdAt: row.createdAt,
  lastReviewAt: row.lastReviewAt,
  sourceMessageIds: parseArray(row.sourceMessageIds),
  pinned: row.pinned === 1,
  archived: row.archived === 1,
  manual: row.manual === 1,
  importance: row.importance,
})

export const listMemories = () =>
  db.prepare('SELECT * FROM memories ORDER BY createdAt ASC').all().map(toMemory)

const writeMemory = (entry) => {
  db.prepare(
    `INSERT OR REPLACE INTO memories
      (id, sourceSessionId, kind, text, keywords, stability, difficulty, reps, lapses,
       createdAt, lastReviewAt, sourceMessageIds, pinned, archived, manual, importance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.id,
    entry.sourceSessionId,
    entry.kind,
    entry.text,
    JSON.stringify(entry.keywords ?? []),
    entry.stability,
    entry.difficulty,
    entry.reps,
    entry.lapses,
    entry.createdAt,
    entry.lastReviewAt,
    JSON.stringify(entry.sourceMessageIds ?? []),
    entry.pinned ? 1 : 0,
    entry.archived ? 1 : 0,
    entry.manual ? 1 : 0,
    entry.importance
  )
}

export const putMemories = (entries) =>
  transaction(() => {
    for (const entry of entries) {
      writeMemory(entry)
    }
  })

export const deleteMemory = (id) => {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id)
}

export const clearMemories = () => {
  db.prepare('DELETE FROM memories').run()
}

export const getMeta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value

export const setMeta = (key, value) => {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
}

const hasTable = (schema, table) =>
  Boolean(
    db
      .prepare(`SELECT 1 AS ok FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table)
  )

/** 把浏览器 sql.js 导出的快照整体导入；表结构一致，直接 ATTACH 后复制 */
export const importSnapshot = (bytes) => {
  if (bytes.length < 16 || bytes.subarray(0, 15).toString('utf8') !== 'SQLite format 3') {
    throw new Error('not a SQLite database')
  }
  const tmp = path.join(DATA_DIR, `legacy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
  writeFileSync(tmp, bytes)
  const escaped = tmp.replace(/'/g, "''")
  db.exec(`ATTACH DATABASE '${escaped}' AS legacy`)
  try {
    for (const table of ['sessions', 'files', 'memories']) {
      if (!hasTable('legacy', table)) {
        continue
      }
      db.exec(
        `INSERT OR REPLACE INTO ${table} SELECT * FROM legacy.${table}`
      )
    }
    setMeta('legacy_imported', '1')
  } finally {
    db.exec('DETACH DATABASE legacy')
    unlinkSync(tmp)
  }
}

/** 旧 IndexedDB 记录导入：会话、记忆与已上传的附件 */
export const importRecords = ({ sessions = [], memories = [] }) =>
  transaction(() => {
    for (const session of sessions) {
      writeSession('sessions', session)
    }
    for (const memory of memories) {
      writeMemory(memory)
    }
    setMeta('legacy_imported', '1')
  })

export const stats = () => ({
  sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
  files: db.prepare('SELECT COUNT(*) AS n FROM files').get().n,
  memories: db.prepare('SELECT COUNT(*) AS n FROM memories').get().n,
})

export const dbFile = DB_FILE

/** 关闭数据库；测试或进程退出前调用，确保 WAL 文件释放 */
export const closeDb = () => {
  db.close()
}
