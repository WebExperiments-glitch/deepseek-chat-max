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
  payload TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updatedAt DESC);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  mimeType TEXT NOT NULL,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS folders_created ON folders(createdAt ASC);

CREATE TABLE IF NOT EXISTS staging_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  fileIds TEXT NOT NULL,
  payload TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shares_created ON shares(createdAt DESC);
`

db.exec(SCHEMA)

// 全文索引：优先 trigram（中文按子串命中），老版本 SQLite 回退到 unicode61
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      sessionId UNINDEXED,
      messageId UNINDEXED,
      role UNINDEXED,
      title UNINDEXED,
      content,
      createdAt UNINDEXED,
      tokenize = 'trigram'
    )
  `)
} catch {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      sessionId UNINDEXED,
      messageId UNINDEXED,
      role UNINDEXED,
      title UNINDEXED,
      content,
      createdAt UNINDEXED
    )
  `)
}

// 旧库补列：CREATE TABLE IF NOT EXISTS 不会修改已有表
for (const table of ['sessions', 'staging_sessions']) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!columns.some((column) => column.name === 'pinned')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columns.some((column) => column.name === 'folderId')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN folderId TEXT`)
  }
}

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

/** 会话正文里参与搜索的文字：用户取正文，助手取所有文本块（不含思考与工具块） */
const searchableText = (message) => {
  if (message.role === 'user') {
    return typeof message.content === 'string' ? message.content : ''
  }
  if (!Array.isArray(message.blocks)) {
    return ''
  }
  return message.blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

const indexSession = (session) => {
  db.prepare('DELETE FROM messages_fts WHERE sessionId = ?').run(session.id)
  const insert = db.prepare(
    `INSERT INTO messages_fts (sessionId, messageId, role, title, content, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  for (const message of session.messages ?? []) {
    if (!message || typeof message.id !== 'string') {
      continue
    }
    const text = searchableText(message).trim()
    if (!text) {
      continue
    }
    insert.run(
      session.id,
      message.id,
      message.role === 'user' ? 'user' : 'assistant',
      session.title ?? '',
      text,
      Number(message.createdAt) || 0
    )
  }
}

/** 旧库第一次启动新版本时补建索引 */
const backfillSearchIndex = () => {
  if (db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get().n > 0) {
    return
  }
  for (const row of db.prepare('SELECT payload FROM sessions').all()) {
    try {
      indexSession(JSON.parse(row.payload))
    } catch {
      // 单条损坏不影响其他会话
    }
  }
}

backfillSearchIndex()

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

const splitSnippet = (snippet) => {
  const [before = '', rest = ''] = String(snippet).split('\u0001')
  const [match = '', after = ''] = rest.split('\u0002')
  return { before, match, after }
}

const likeSnippet = (content, query) => {
  const index = content.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) {
    return { before: '', match: query, after: '' }
  }
  const start = Math.max(0, index - 30)
  const end = Math.min(content.length, index + query.length + 60)
  return {
    before: `${start > 0 ? '…' : ''}${content.slice(start, index)}`,
    match: content.slice(index, index + query.length),
    after: `${content.slice(index + query.length, end)}${end < content.length ? '…' : ''}`,
  }
}

/**
 * 全文搜索：>=3 个字符走 FTS5 trigram，短查询退回 LIKE。
 * 返回命中消息和可直接渲染的三段摘要，按会话最近更新时间排序。
 */
export const searchMessages = (rawQuery, limit = 30) => {
  const query = String(rawQuery ?? '').trim()
  if (!query) {
    return []
  }
  const size = Math.min(100, Math.max(1, Number(limit) || 30))
  if (query.length >= 3) {
    try {
      const rows = db
        .prepare(
          `SELECT messages_fts.sessionId AS sessionId, messages_fts.messageId AS messageId,
                  messages_fts.role AS role, sessions.title AS title,
                  snippet(messages_fts, 4, char(1), char(2), '…', 16) AS snippet,
                  sessions.updatedAt AS updatedAt
           FROM messages_fts JOIN sessions ON sessions.id = messages_fts.sessionId
           WHERE messages_fts MATCH ?
           ORDER BY sessions.updatedAt DESC, messages_fts.createdAt ASC
           LIMIT ?`
        )
        .all(`"${query.replace(/"/g, '""')}"`, size)
      return rows.map((row) => ({ ...row, ...splitSnippet(row.snippet) }))
    } catch {
      // 查询语法异常时退回 LIKE
    }
  }
  return db
    .prepare(
      `SELECT messages_fts.sessionId AS sessionId, messages_fts.messageId AS messageId,
              messages_fts.role AS role, sessions.title AS title,
              messages_fts.content AS content, sessions.updatedAt AS updatedAt
       FROM messages_fts JOIN sessions ON sessions.id = messages_fts.sessionId
       WHERE messages_fts.content LIKE ? ESCAPE '\\'
       ORDER BY sessions.updatedAt DESC, messages_fts.createdAt ASC
       LIMIT ?`
    )
    .all(`%${escapeLike(query)}%`, size)
    .map(({ content, ...row }) => ({ ...row, ...likeSnippet(content, query) }))
}

const writeSession = (table, session) => {
  const params = [
    session.id,
    session.title,
    session.createdAt,
    session.updatedAt,
    JSON.stringify(fileIdsOf(session)),
    JSON.stringify(session),
  ]
  if (table === 'staging_sessions') {
    // 归档导入必须保留置顶与文件夹归属；否则 replaceHistory 提交后列表会丢失这两项元数据。
    db.prepare(
      `INSERT OR REPLACE INTO ${table} (id, title, createdAt, updatedAt, fileIds, payload, pinned, folderId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...params, session.pinned ? 1 : 0, session.folderId ?? null)
    return
  }
  db.prepare(
    `INSERT INTO sessions (id, title, createdAt, updatedAt, fileIds, payload, folderId)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       createdAt = excluded.createdAt,
       updatedAt = excluded.updatedAt,
       fileIds = excluded.fileIds,
       payload = excluded.payload`
  ).run(...params, session.folderId ?? null)
  indexSession(session)
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
    .prepare(
      'SELECT id, title, createdAt, updatedAt, pinned, folderId FROM sessions ORDER BY pinned DESC, updatedAt DESC'
    )
    .all()
    .map((row) => ({
      ...row,
      pinned: row.pinned === 1,
      folderId: row.folderId ?? null,
    }))

/** 每个账号最多置顶的会话数；官方服务端限制，本地按同一语义执行 */
export const PIN_LIMIT = 10

export const countPinnedSessions = () =>
  db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE pinned = 1').get().n

/**
 * 置顶只影响列表排序，不改会话正文。
 * 返回 ok / missing / limit，调用方据此决定是否提示。
 */
export const setSessionPinned = (id, pinned) => {
  const row = db.prepare('SELECT pinned FROM sessions WHERE id = ?').get(id)
  if (!row) {
    return 'missing'
  }
  if (pinned && row.pinned !== 1 && countPinnedSessions() >= PIN_LIMIT) {
    return 'limit'
  }
  db.prepare('UPDATE sessions SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
  return 'ok'
}

/** 会话文件夹：只影响列表归档，不参与请求 */
export const listFolders = () =>
  db.prepare('SELECT id, name, createdAt FROM folders ORDER BY createdAt ASC').all()

export const createFolder = ({ id, name, createdAt }) => {
  db.prepare('INSERT INTO folders (id, name, createdAt) VALUES (?, ?, ?)').run(id, name, createdAt)
  return { id, name, createdAt }
}

export const renameFolder = (id, name) =>
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id).changes > 0

/** 删除文件夹只清空会话的归档关系，不删除会话 */
export const deleteFolder = (id) =>
  transaction(() => {
    db.prepare('UPDATE sessions SET folderId = NULL WHERE folderId = ?').run(id)
    return db.prepare('DELETE FROM folders WHERE id = ?').run(id).changes > 0
  })

/** 返回 ok / missing（会话不存在）/ folder-missing（目标文件夹不存在） */
export const setSessionFolder = (id, folderId) => {
  if (!db.prepare('SELECT 1 AS ok FROM sessions WHERE id = ?').get(id)) {
    return 'missing'
  }
  if (folderId !== null && !db.prepare('SELECT 1 AS ok FROM folders WHERE id = ?').get(folderId)) {
    return 'folder-missing'
  }
  db.prepare('UPDATE sessions SET folderId = ? WHERE id = ?').run(folderId, id)
  return 'ok'
}

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
    db.prepare('DELETE FROM messages_fts WHERE sessionId = ?').run(id)
    // 删除会话后，由它生成的分享链接同时失效
    db.prepare('DELETE FROM shares WHERE sessionId = ?').run(id)
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
      // staging 阶段只写暂存表：正式 files 表要等 commit 时整体替换，
      // 避免同一份 BLOB 写两遍（大归档下可省数百 MB 写入放大）。
      if (file.staging) {
        writeFile('staging_files', file.id, file.mimeType, file.data)
      } else {
        writeFile('files', file.id, file.mimeType, file.data)
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

/** 批量写入暂存会话：一次事务 + 一条预编译语句，避免逐会话的 HTTP 与事务开销。 */
export const putStagingSessions = (sessions) =>
  transaction(() => {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO staging_sessions (id, title, createdAt, updatedAt, fileIds, payload, pinned, folderId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const session of sessions) {
      stmt.run(
        session.id,
        session.title,
        session.createdAt,
        session.updatedAt,
        JSON.stringify(fileIdsOf(session)),
        JSON.stringify(session),
        session.pinned ? 1 : 0,
        session.folderId ?? null
      )
    }
  })

/** 批量写入暂存原件：一次事务 + 一条预编译语句。 */
export const putStagingFiles = (files) =>
  transaction(() => {
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO staging_files (id, mimeType, data) VALUES (?, ?, ?)'
    )
    for (const file of files) {
      stmt.run(file.id, file.mimeType, file.data)
    }
  })

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
      .prepare('SELECT id, title, createdAt, updatedAt, pinned, folderId FROM staging_sessions')
      .all()
      .map((row) => ({
        ...row,
        pinned: row.pinned === 1,
        folderId: row.folderId ?? null,
      }))
    // 表交换：直接把暂存表改名为正式表，避免把上百 MB 的 BLOB 复制两遍
    // （DELETE files + INSERT SELECT 曾导致大归档提交极慢并撞上 HTTP 超时）。
    db.prepare('DROP INDEX IF EXISTS sessions_updated').run()
    db.prepare('DROP TABLE sessions').run()
    db.prepare('DROP TABLE files').run()
    db.prepare('ALTER TABLE staging_sessions RENAME TO sessions').run()
    db.prepare('ALTER TABLE staging_files RENAME TO files').run()
    db.prepare('CREATE INDEX sessions_updated ON sessions(updatedAt DESC)').run()
    // 交换后暂存表已被改名取走，重建空表供下一次导入使用。
    db.prepare(`CREATE TABLE staging_sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL, fileIds TEXT NOT NULL, payload TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0, folderId TEXT)`).run()
    db.prepare(`CREATE TABLE staging_files (
      id TEXT PRIMARY KEY, mimeType TEXT NOT NULL, data BLOB NOT NULL)`).run()
    db.prepare('DELETE FROM shares').run()
    // 清空旧索引即可，历史被整体替换。重建 FTS 很慢（数万条中文 trigram），
    // 绝不能放在本事务里——否则大归档提交会超时回滚，数据永远落不了地。
    // 索引由 rebuildSearchIndex() 分批在后台重建，不影响会话立即可见。
    db.prepare('DELETE FROM messages_fts').run()
    return summaries
  })

/**
 * 分批重建全文索引。每批一个独立事务，可随时中断，已建部分保留；
 * 再次调用只补未建索引的会话（messages_fts 中已有记录的跳过）。
 */
export const rebuildSearchIndex = (batchSize = 300) => {
  let built = 0
  let cursor = ''
  for (;;) {
    const rows = db
      .prepare(
        'SELECT id, payload FROM sessions WHERE id > ? ORDER BY id LIMIT ?'
      )
      .all(cursor, batchSize)
    if (rows.length === 0) {
      break
    }
    transaction(() => {
      const has = db.prepare('SELECT 1 FROM messages_fts WHERE sessionId = ? LIMIT 1')
      for (const row of rows) {
        if (has.get(row.id)) {
          continue
        }
        try {
          indexSession(JSON.parse(row.payload))
          built++
        } catch {
          // 单条损坏不影响其他会话
        }
      }
    })
    cursor = rows[rows.length - 1].id
  }
  return built
}

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

const reindexSessions = () => {
  db.prepare('DELETE FROM messages_fts').run()
  for (const row of db.prepare('SELECT payload FROM sessions').all()) {
    try {
      indexSession(JSON.parse(row.payload))
    } catch {
      // 单条损坏不影响其他会话
    }
  }
}

const columnsOf = (schema, table) =>
  db
    .prepare(`PRAGMA ${schema}.table_info(${table})`)
    .all()
    .map((column) => column.name)

/** 把浏览器 sql.js 导出的快照整体导入；只复制两边都有的列，旧快照缺的新列走默认值 */
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
      const source = new Set(columnsOf('legacy', table))
      const shared = columnsOf('main', table).filter((name) => source.has(name))
      if (shared.length === 0) {
        continue
      }
      db.exec(
        `INSERT OR REPLACE INTO ${table} (${shared.join(',')})
         SELECT ${shared.join(',')} FROM legacy.${table}`
      )
    }
    reindexSessions()
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
    reindexSessions()
    setMeta('legacy_imported', '1')
  })

/** 分享快照：创建时固化消息，之后删除或修改原会话不影响已发出的链接 */
export const createShare = ({ id, sessionId, title, messages, createdAt }) => {
  db.prepare(
    'INSERT INTO shares (id, sessionId, title, payload, createdAt) VALUES (?, ?, ?, ?, ?)'
  ).run(id, sessionId, title, JSON.stringify({ title, createdAt, messages }), createdAt)
  return { id, sessionId, title, createdAt, count: messages.length }
}

const shareRow = (row) => {
  let payload = { title: row.title, createdAt: row.createdAt, messages: [] }
  try {
    payload = JSON.parse(row.payload)
  } catch {
    // 损坏时只返回标题
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    title: row.title,
    createdAt: row.createdAt,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
  }
}

export const listShares = () =>
  db
    .prepare('SELECT id, sessionId, title, payload, createdAt FROM shares ORDER BY createdAt DESC')
    .all()
    .map((row) => {
      const share = shareRow(row)
      return {
        id: share.id,
        sessionId: share.sessionId,
        title: share.title,
        createdAt: share.createdAt,
        count: share.messages.length,
      }
    })

export const getShare = (id) => {
  const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(id)
  return row ? shareRow(row) : null
}

export const deleteShare = (id) => {
  db.prepare('DELETE FROM shares WHERE id = ?').run(id)
}

export const stats = () => ({
  sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
  files: db.prepare('SELECT COUNT(*) AS n FROM files').get().n,
  memories: db.prepare('SELECT COUNT(*) AS n FROM memories').get().n,
})

/**
 * 用量汇总：遍历会话正文里的 usage，按会话聚合缓存命中。
 * 命中率 = 命中读取 ÷ 输入总量（未命中 + 命中读取 + 写入缓存）。
 */
export const usageSummary = () => {
  const sessions = []
  const totals = {
    requests: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  }
  for (const row of db
    .prepare('SELECT id, title, updatedAt, payload FROM sessions ORDER BY updatedAt DESC')
    .all()) {
    let inputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let outputTokens = 0
    let requests = 0
    try {
      const session = JSON.parse(row.payload)
      for (const message of session.messages ?? []) {
        const usage = message?.usage
        if (!usage) {
          continue
        }
        requests += 1
        inputTokens += Number(usage.input_tokens) || 0
        cacheReadTokens += Number(usage.cache_read_input_tokens) || 0
        cacheWriteTokens += Number(usage.cache_creation_input_tokens) || 0
        outputTokens += Number(usage.output_tokens) || 0
      }
    } catch {
      // 单条损坏不影响其他会话
    }
    if (requests === 0) {
      continue
    }
    const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
    sessions.push({
      id: row.id,
      title: row.title ?? '',
      updatedAt: row.updatedAt,
      requests,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      promptTokens,
      cacheHitRate: promptTokens > 0 ? cacheReadTokens / promptTokens : 0,
    })
    totals.requests += requests
    totals.inputTokens += inputTokens
    totals.cacheReadTokens += cacheReadTokens
    totals.cacheWriteTokens += cacheWriteTokens
    totals.outputTokens += outputTokens
  }
  const promptTokens =
    totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  return {
    totals: {
      ...totals,
      promptTokens,
      cacheHitRate: promptTokens > 0 ? totals.cacheReadTokens / promptTokens : 0,
    },
    sessions,
  }
}

export const dbFile = DB_FILE

/** 关闭数据库；测试或进程退出前调用，确保 WAL 文件释放 */
export const closeDb = () => {
  db.close()
}
