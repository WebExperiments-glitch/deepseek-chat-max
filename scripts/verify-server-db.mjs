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
  assert.equal(db.setSessionPinned('s1', true), 'ok')
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

test('归档导入保留置顶与文件夹归属', () => {
  db.createFolder({ id: 'import-folder', name: '导入归档', createdAt: 1 })
  db.clearStaging()
  db.putStagingSession({
    ...session('imported', '导入会话'),
    pinned: true,
    folderId: 'import-folder',
  })
  const summaries = db.commitStaging()
  const summary = summaries.find((item) => item.id === 'imported')
  assert.equal(summary.pinned, true)
  assert.equal(summary.folderId, 'import-folder')
  const listed = db.listSessions().find((item) => item.id === 'imported')
  assert.equal(listed.pinned, true)
  assert.equal(listed.folderId, 'import-folder')
  // 清理置顶状态，避免占用后续「置顶上限」用例的名额
  db.setSessionPinned('imported', false)
  db.deleteSession('imported')
  db.deleteFolder('import-folder')
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

test('全文搜索命中用户与助手正文，不索引思考块', () => {
  db.putSession({
    id: 'search-1',
    title: '搜索测试',
    createdAt: 1,
    updatedAt: 3,
    messages: [
      { id: 'u1', role: 'user', content: '请解释量子纠缠', files: [], createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        blocks: [
          { type: 'thinking', thinking: '内部推理不应被搜索' },
          { type: 'text', text: '量子纠缠是一种关联现象' },
        ],
        createdAt: 2,
      },
    ],
  })
  const results = db.searchMessages('量子纠缠')
  assert.ok(results.some((item) => item.messageId === 'u1'))
  assert.ok(results.some((item) => item.messageId === 'a1' && item.match === '量子纠缠'))
  assert.equal(db.searchMessages('内部推理').length, 0)
})

test('分享快照独立保存，删除原会话后链接失效', () => {
  db.putSession(session('share-src', '分享测试'))
  const share = db.createShare({
    id: 'shtest',
    sessionId: 'share-src',
    title: '分享测试',
    messages: [{ id: 'u1', role: 'user', content: '你好', createdAt: 1 }],
    createdAt: 5,
  })
  assert.equal(share.count, 1)
  assert.equal(db.getShare('shtest').messages[0].content, '你好')
  assert.equal(db.listShares().length, 1)
  db.deleteSession('share-src')
  assert.equal(db.getShare('shtest'), null)
  assert.equal(db.listShares().length, 0)
})

test('置顶达到上限后拒绝新的置顶', () => {
  for (let index = 0; index < db.PIN_LIMIT; index += 1) {
    db.putSession(session(`pin-${index}`, `置顶 ${index}`))
    assert.equal(db.setSessionPinned(`pin-${index}`, true), 'ok')
  }
  db.putSession(session('pin-extra', '超出上限'))
  assert.equal(db.setSessionPinned('pin-extra', true), 'limit')
  assert.equal(db.setSessionPinned('pin-0', true), 'ok')
})

test('文件夹归档不会被保存正文覆盖，删除后回到未归档', () => {
  db.createFolder({ id: 'folder-1', name: '工作', createdAt: 1 })
  db.putSession(session('folder-session', '归档会话'))
  assert.equal(db.setSessionFolder('folder-session', 'folder-1'), 'ok')
  assert.equal(
    db.listSessions().find((item) => item.id === 'folder-session').folderId,
    'folder-1'
  )

  // 保存正文（保存消息、重命名）不应清空 folderId
  db.putSession(session('folder-session', '改名后'))
  assert.equal(
    db.listSessions().find((item) => item.id === 'folder-session').folderId,
    'folder-1'
  )
  assert.equal(db.renameFolder('folder-1', '工作资料'), true)
  assert.equal(db.listFolders()[0].name, '工作资料')
  assert.equal(db.setSessionFolder('folder-session', 'missing'), 'folder-missing')

  assert.equal(db.deleteFolder('folder-1'), true)
  assert.equal(
    db.listSessions().find((item) => item.id === 'folder-session').folderId,
    null
  )
  assert.equal(db.listFolders().length, 0)
})

test.after(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})
