import { describe, expect, it } from 'vitest'
import {
  bytesToBlob,
  handleBrowserRequest,
  makeSearchResults,
  parseFileBatch,
  toSessionSummary,
  type SessionRow,
} from './browserBackend.js'
import type { Session } from '../chat/types.js'

/**
 * 纯逻辑单测。
 *
 * 仓库未安装 fake-indexeddb，vitest 的 environment 是 node，没有全局 indexedDB，
 * 因此「空库 GET /sessions」「PUT → GET 读回」「DELETE → 404」这三个需要真实 IndexedDB
 * 的用例以 it.skip 形式保留在文件末尾（安装 fake-indexeddb 后取消 skip 即可）。
 * 这里覆盖不依赖 IndexedDB 的摘要、二进制帧、搜索与 Blob 转换逻辑。
 */

const session = (id: string, updatedAt: number, title = '标题'): Session => ({
  id,
  title,
  createdAt: 1,
  updatedAt,
  messages: [],
})

const row = (id: string, updatedAt: number): SessionRow => ({
  id,
  title: `会话 ${id}`,
  createdAt: 1,
  updatedAt,
  fileIds: [],
  payload: session(id, updatedAt),
  pinned: false,
  folderId: null,
})

describe('browserBackend 纯逻辑', () => {
  it('列表摘要只含元数据，不含会话正文', () => {
    const full = row('a', 2)
    full.payload = {
      ...session('a', 2),
      messages: [{ id: 'm1', role: 'user', content: '正文', files: [], createdAt: 1 }],
    }
    full.pinned = true
    full.folderId = 'folder-1'
    expect(toSessionSummary(full)).toEqual({
      id: 'a',
      title: '会话 a',
      createdAt: 1,
      updatedAt: 2,
      pinned: true,
      folderId: 'folder-1',
    })
    expect(toSessionSummary(full)).not.toHaveProperty('payload')
  })

  it('解析 postFilesBatch 的紧凑二进制帧（含中文 id 与 MIME）', async () => {
    const encoder = new TextEncoder()
    const parts = [
      { id: '图片一', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) },
      { id: 'f2', mimeType: 'text/plain', data: new Uint8Array([4, 5]) },
    ].map((part) => ({
      id: encoder.encode(part.id),
      mime: encoder.encode(part.mimeType),
      data: part.data,
    }))
    let total = 0
    for (const part of parts) {
      total += 12 + part.id.length + part.mime.length + part.data.length
    }
    const buffer = new ArrayBuffer(total)
    const view = new DataView(buffer)
    const output = new Uint8Array(buffer)
    let offset = 0
    for (const part of parts) {
      view.setUint32(offset, part.id.length, true)
      view.setUint32(offset + 4, part.mime.length, true)
      view.setUint32(offset + 8, part.data.length, true)
      offset += 12
      output.set(part.id, offset)
      offset += part.id.length
      output.set(part.mime, offset)
      offset += part.mime.length
      output.set(part.data, offset)
      offset += part.data.length
    }
    const parsed = parseFileBatch(new Uint8Array(buffer))
    expect(parsed.map((file) => ({ id: file.id, mimeType: file.mimeType }))).toEqual([
      { id: '图片一', mimeType: 'image/png' },
      { id: 'f2', mimeType: 'text/plain' },
    ])
    const [firstFile, secondFile] = parsed
    expect(firstFile && [...firstFile.data]).toEqual([1, 2, 3])
    expect(secondFile && [...secondFile.data]).toEqual([4, 5])
    // 截断的帧必须报错，避免把半条记录写进 files store
    expect(() => parseFileBatch(new Uint8Array(buffer, 0, 8))).toThrow()
  })

  it('搜索支持中文子串匹配，返回三段摘要并按更新时间排序', () => {
    const withMessage = (id: string, updatedAt: number, text: string): SessionRow => {
      const item = row(id, updatedAt)
      item.payload = {
        ...session(id, updatedAt),
        messages: [
          { id: `${id}-m`, role: 'user', content: text, files: [], createdAt: 1 },
          {
            id: `${id}-a`,
            role: 'assistant',
            createdAt: 2,
            model: null,
            prefix: false,
            status: 'done',
            blocks: [{ type: 'text', text: '无关回答' }],
          },
        ],
      }
      return item
    }
    const results = makeSearchResults(
      [withMessage('old', 1, '这是一段中文内容，包含深度求索关键词。'), withMessage('new', 9, '另一段提到深度求索的文本。')],
      '深度求索',
      10
    )
    const [first, second] = results
    expect(results).toHaveLength(2)
    expect(first?.sessionId).toBe('new')
    expect(first?.match).toBe('深度求索')
    expect(first?.before).toContain('提到')
    expect(`${second?.before}${second?.match}${second?.after}`).toContain('中文内容')
    expect(makeSearchResults([], '深度求索')).toEqual([])
  })

  it('bytesToBlob 复制字节，不共享底层缓冲区', async () => {
    const source = new Uint8Array([7, 8, 9])
    const blob = bytesToBlob(source, 'image/png')
    source[0] = 0
    expect(blob.type).toBe('image/png')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([7, 8, 9])
  })

  // 以下三个用例需要真实 IndexedDB。当前仓库没有 fake-indexeddb，环境是 node，
  // 安装并注入全局 indexedDB 后取消 skip 即可覆盖端到端路由语义。
  it.skip('空库时 GET /api/sessions 返回 {sessions: []}', async () => {
    const response = await handleBrowserRequest('/api/sessions')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessions: [] })
  })

  it.skip('PUT session 后 GET 能读回', async () => {
    const value = session('s1', 1)
    await handleBrowserRequest('/api/sessions/s1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: value }),
    })
    const response = await handleBrowserRequest('/api/sessions/s1')
    expect(await response.json()).toEqual(value)
  })

  it.skip('DELETE 后 GET 返回 404', async () => {
    await handleBrowserRequest('/api/sessions/s1', { method: 'DELETE' })
    const response = await handleBrowserRequest('/api/sessions/s1')
    expect(response.status).toBe(404)
  })
})
