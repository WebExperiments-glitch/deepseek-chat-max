#!/usr/bin/env node
/**
 * SQLite 表结构与读写回归测试。
 *
 * 直接用 Node 自带的 test runner，不额外引入测试框架；
 * sql.js 在 Node 里同样能跑，因此可以把 schema、BLOB 和 JSON 往返都覆盖到。
 * 运行：pnpm test:sql
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import initSqlJs from 'sql.js'
import { SCHEMA_SQL } from '../src/services/platform/sqlSchema.ts'

const SQL = await initSqlJs({
  locateFile: (file) =>
    fileURLToPath(new URL(`../node_modules/sql.js/dist/${file}`, import.meta.url)),
})

const open = () => {
  const db = new SQL.Database()
  db.run(SCHEMA_SQL)
  return db
}

const all = (db, sql, params = []) => {
  const result = db.exec(sql, params)
  if (result.length === 0) {
    return []
  }
  const { columns, values } = result[0]
  return values.map((value) => Object.fromEntries(columns.map((column, index) => [column, value[index]])))
}

test('创建全部表', () => {
  const db = open()
  const names = all(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name)
  for (const table of [
    'sessions',
    'files',
    'staging_sessions',
    'staging_files',
    'memories',
    'meta',
  ]) {
    assert.ok(names.includes(table), `缺少表 ${table}`)
  }
  db.close()
})

test('会话 JSON 与 fileIds 往返', () => {
  const db = open()
  const session = {
    id: 's1',
    title: '测试会话',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ role: 'user', files: [{ id: 'f1' }] }],
  }
  const params = [
    session.id,
    session.title,
    session.createdAt,
    session.updatedAt,
    JSON.stringify(['f1']),
    JSON.stringify(session),
  ]
  const sql = `INSERT OR REPLACE INTO sessions
    (id, title, createdAt, updatedAt, fileIds, payload) VALUES (?, ?, ?, ?, ?, ?)`
  db.run(sql, params)
  db.run(sql, [...params.slice(0, 1), '改名', ...params.slice(2)])

  const row = all(db, 'SELECT * FROM sessions WHERE id = ?', ['s1'])[0]
  assert.equal(row.title, '改名')
  assert.deepEqual(JSON.parse(row.fileIds), ['f1'])
  assert.equal(JSON.parse(row.payload).messages[0].files[0].id, 'f1')
  db.close()
})

test('附件 BLOB 往返', () => {
  const db = open()
  const bytes = new Uint8Array([1, 2, 3, 255])
  db.run('INSERT INTO files (id, mimeType, data) VALUES (?, ?, ?)', ['f1', 'image/png', bytes])

  const row = all(db, 'SELECT mimeType, data FROM files WHERE id = ?', ['f1'])[0]
  assert.equal(row.mimeType, 'image/png')
  assert.deepEqual(Array.from(row.data), [1, 2, 3, 255])
  db.close()
})

test('记忆字段与 JSON 数组往返', () => {
  const db = open()
  db.run(
    `INSERT INTO memories
      (id, sourceSessionId, kind, text, keywords, stability, difficulty, reps, lapses,
       createdAt, lastReviewAt, sourceMessageIds, pinned, archived, manual, importance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'm1',
      's1',
      'preference',
      '用户喜欢简洁的回答',
      JSON.stringify(['简洁', '回答']),
      3.5,
      0.4,
      2,
      0,
      10,
      20,
      JSON.stringify(['msg1']),
      1,
      0,
      0,
      0.8,
    ]
  )

  const row = all(db, 'SELECT * FROM memories WHERE id = ?', ['m1'])[0]
  assert.deepEqual(JSON.parse(row.keywords), ['简洁', '回答'])
  assert.deepEqual(JSON.parse(row.sourceMessageIds), ['msg1'])
  assert.equal(row.pinned, 1)
  assert.equal(row.stability, 3.5)
  db.close()
})

test('导出的字节是合法 SQLite 文件', () => {
  const db = open()
  const bytes = db.export()
  const header = new TextDecoder().decode(bytes.slice(0, 15))
  assert.equal(header, 'SQLite format 3')
  assert.ok(bytes.byteLength > 0)
  db.close()
})
