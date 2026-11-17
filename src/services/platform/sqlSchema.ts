/**
 * 本地 SQLite 的表结构。
 *
 * 会话正文仍然以 JSON 存在 payload 列里：分支、消息块和压缩记录的读写逻辑都在上层，
 * 拆成多表反而要在两处维护同一份顺序与树结构。列表需要的字段单独建列，避免加载全部消息。
 * 附件原件以 BLOB 存入 files，记忆按字段展开，方便后续直接写 SQL 查询。
 */

export const SCHEMA_VERSION = 1

export const SCHEMA_SQL = `
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
