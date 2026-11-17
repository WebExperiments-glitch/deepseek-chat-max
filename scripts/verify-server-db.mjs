#!/usr/bin/env node
/**
 * 本地 SQLite 数据层回归测试。
 * 用 Node 自带 test runner，在临时目录建库，不碰真实 data/chat-demo.db。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-demo-db-'))
process.env.DATA_DIR = dir

const db = await import('../server/db.mjs')

const session = (id, title, fileIds = []) => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 2,
  messages: fileIds.map((fileId, index) => ({
    id: `m-${id}-${index}`,
    role: 'user',
    content: '你好',
    files: [{ id: fileId }],
    createdAt: 1,
  })),
})

test('会话读写与重命名', () => {
  db.putSession(session('s1', '旧标题'))
  assert.equal(db.getSession('s1').title, '旧标题')
  assert.deepEqual(db.listSessions().map((item) => item.id), ['s1'])

  db.renameSession('s1', '新标题')
  assert.equal(db.getSession('s1').title, '新标题')
  assert.equal(db.listSessions()[0].title, '新标题')
})

test('会话置顶只影响排序且不会被保存覆盖', () => {
  db.putSession(session('s1', '旧标题'))
  db.putSession(session('s2', '新标题'))
  assert.equal(db.setSessionPinned('s1', true), true)
  assert.deepEqual(db.listSessions().map((item) => item.id), ['s1', 's2'])
  assert.equal(db.listSessions()[0].pinned, true)

  // 再次保存会话正文不应把 pinned 重置
  db.putSession(session('s1', '改名后'))
  assert.equal(db.listSessions()[0].pinned, true)
  db.setSessionPinned('s1', false)
  assert.equal(db.listSessions()[0].pinned, false)
  db.deleteSession('s2')
})

test('附件二进制往返与删除回收', () => {
  db.putSession(session('s1', '带附件', ['f1']))
  db.putFiles([{ id: 'f1', mimeType: 'text/plain', data: Buffer.from('hello') }])
  const file = db.getFile('f1')
  assert.equal(file.mimeType, 'text/plain')
  assert.equal(Buffer.from(file.data).toString(), 'hello')

  db.deleteSession('s1')
  assert.equal(db.getSession('s1'), null)
  assert.equal(db.getFile('f1'), null)
  assert.deepEqual(db.stats(), { sessions: 0, files: 0, memories: 0 })
})

test('记忆批量写入与清空', () => {
  db.putMemories([
    {
      id: 'mem1',
      sourceSessionId: 's1',
      kind: 'preference',
      text: '喜欢简洁',
      keywords: ['简洁'],
      stability: 1,
      difficulty: 0.3,
      reps: 0,
      lapses: 0,
      createdAt: 1,
      lastReviewAt: 1,
      sourceMessageIds: [],
      pinned: false,
      archived: false,
      manual: false,
      importance: 0.5,
    },
  ])
  assert.equal(db.listMemories().length, 1)
  assert.deepEqual(db.listMemories()[0].keywords, ['简洁'])
  db.deleteMemory('mem1')
  assert.equal(db.listMemories().length, 0)
})

test('导入暂存原子替换正式数据', () => {
  db.putSession(session('old', '旧会话'))
  db.putStagingSession(session('new', '新会话', ['f2']))
  db.putFiles([{ id: 'f2', mimeType: 'text/plain', data: Buffer.from('staged'), staging: true }])
  const summaries = db.commitStaging()
  assert.deepEqual(summaries.map((item) => item.id), ['new'])
  assert.equal(db.getSession('old'), null)
  assert.equal(db.getSession('new').title, '新会话')
  assert.equal(Buffer.from(db.getFile('f2').data).toString(), 'staged')
})

test('旧记录导入', () => {
  db.clearMemories()
  db.importRecords({
    sessions: [session('legacy', '导入会话')],
    memories: [],
  })
  assert.equal(db.getSession('legacy').title, '导入会话')
  assert.equal(db.getMeta('legacy_imported'), '1')
})

test.after(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})
