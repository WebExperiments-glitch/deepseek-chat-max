/** 端到端验证批量暂存端点：临时 DB + 独立端口，测试完自动清理，不碰真实数据。 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'

const tmpRoot = process.env.TEMP ?? 'C:/Users/30500/AppData/Local/Temp/opencode'
const dir = mkdtempSync(path.join(tmpRoot, 'chat-batch-'))
const dbFile = path.join(dir, 'test.db')
const port = 18999
const base = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_FILE: dbFile },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
child.stdout.on('data', (d) => (logs += d))
child.stderr.on('data', (d) => (logs += d))

const waitReady = async () => {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/sessions`)
      if (r.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('server did not start:\n' + logs)
}

const encodeBatch = (files) => {
  const encoder = new TextEncoder()
  const parts = files.map((f) => ({
    id: encoder.encode(f.id),
    mime: encoder.encode(f.mimeType),
    data: new Uint8Array(f.data),
  }))
  const total = parts.reduce((n, p) => n + 12 + p.id.length + p.mime.length + p.data.length, 0)
  const buf = new ArrayBuffer(total)
  const view = new DataView(buf)
  const out = new Uint8Array(buf)
  let off = 0
  for (const p of parts) {
    view.setUint32(off, p.id.length, true); off += 4
    view.setUint32(off, p.mime.length, true); off += 4
    view.setUint32(off, p.data.length, true); off += 4
    out.set(p.id, off); off += p.id.length
    out.set(p.mime, off); off += p.mime.length
    out.set(p.data, off); off += p.data.length
  }
  return buf
}

try {
  await waitReady()

  // 1) 批量写图片（含二进制 payload 与 webp MIME）
  const imageA = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3])
  const imageB = Uint8Array.from([1, 2, 3, 4, 5])
  const batch = encodeBatch([
    { id: 'img-a', mimeType: 'image/webp', data: imageA },
    { id: 'img-b', mimeType: 'image/png', data: imageB },
  ])
  const fileResp = await fetch(`${base}/api/staging/files/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Blob([batch]),
  })
  assert.equal(fileResp.status, 200, await fileResp.text())

  // 2) 批量写会话（引用 img-a）
  const session = {
    id: 'sess-1', title: '批量测试', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', pinned: false, folderId: null,
    messages: [{ id: 1, role: 'user', files: [{ id: 'img-a' }] }],
  }
  const sessResp = await fetch(`${base}/api/staging/sessions/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessions: [session] }),
  })
  assert.equal(sessResp.status, 200, await sessResp.text())

  // 3) 提交（临时 DB，安全）
  const commitResp = await fetch(`${base}/api/staging/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(commitResp.status, 200, await commitResp.text())

  // 4) 回读校验：会话落库、图片字节完整、MIME 正确
  const s = await (await fetch(`${base}/api/sessions/sess-1`)).json()
  assert.equal(s.title, '批量测试')
  const a = await fetch(`${base}/api/files/img-a`)
  assert.equal(a.headers.get('content-type'), 'image/webp')
  assert.deepEqual(new Uint8Array(await a.arrayBuffer()), imageA)
  const b = await fetch(`${base}/api/files/img-b`)
  assert.deepEqual(new Uint8Array(await b.arrayBuffer()), imageB)

  console.log('批量暂存端点端到端验证通过（会话 + 图片 + 提交 + 回读）')
} finally {
  child.kill()
  await once(child, 'exit')
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows 上文件句柄可能尚未释放，临时目录残留无碍验证结果。
  }
}
