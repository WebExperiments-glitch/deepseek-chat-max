import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  clearMemories,
  clearStaging,
  commitStaging,
  createFolder,
  createShare,
  dbFile,
  deleteFolder,
  deleteMemory,
  deleteSession,
  deleteShare,
  getFile,
  getMeta,
  getSession,
  getShare,
  importRecords,
  importSnapshot,
  listFolders,
  listMemories,
  listShares,
  listSessions,
  putFiles,
  putMemories,
  putSession,
  putStagingFiles,
  putStagingSession,
  putStagingSessions,
  renameFolder,
  renameSession,
  searchMessages,
  setSessionFolder,
  setSessionPinned,
  stats,
  updateStagingFileTypes,
  usageSummary,
} from './db.mjs'

/**
 * 本地聊天服务：静态页面 + SQLite REST API。
 *
 * 只绑定 127.0.0.1，浏览器和数据库在同一台机器上，不需要鉴权。
 * 开发时 Rspack 把 /api 代理到这里；生产时这个进程同时托管 dist。
 */

const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 8787)
const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist')
const MAX_JSON = 20 * 1024 * 1024
const MAX_BLOB = 80 * 1024 * 1024
const MAX_SESSION_BATCH = 48 * 1024 * 1024
const MAX_FILE_BATCH = 96 * 1024 * 1024

/**
 * 通用服务商代理：浏览器直连多数模型网关会被 CORS 拦（鉴权失败响应尤其没有 CORS 头）。
 * 本地服务把 /provider/:id/<rest> 转发到该 provider 的真实端点，透传鉴权头与请求体，
 * 并流式回传响应（含 SSE）。目标端点来自随仓库的 provider-catalog.json（models.dev 生成）。
 */
let PROVIDER_CATALOG = []
try {
  PROVIDER_CATALOG = JSON.parse(readFileSync(path.join(import.meta.dirname, 'provider-catalog.json'), 'utf8'))
} catch {
  // 清单缺失时代理不可用，不影响其他功能
}

const proxyProvider = async (req, res, pathname) => {
  // pathname: /provider/<id>/<rest...>
  const parts = pathname.split('/').filter(Boolean)
  const id = parts[1]
  const rest = parts.slice(2).join('/')
  const provider = PROVIDER_CATALOG.find((p) => p.id === id)
  if (!provider) {
    return sendError(res, 404, `unknown provider: ${id ?? ''}`)
  }
  const search = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).search
  const target = `${provider.baseURL.replace(/\/+$/, '')}/${rest}${search}`

  // 透传请求头：去掉 hop-by-hop 与 host，保留 Authorization / x-api-key / content-type 等
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) continue
    headers[key] = value
  }

  const method = req.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const upstream = await fetch(target, {
    method,
    headers,
    ...(hasBody ? { body: req } : {}),
  })

  // 回传状态码与响应头（去掉 hop-by-hop）
  const resHeaders = {}
  upstream.headers.forEach((value, key) => {
    if (['connection', 'transfer-encoding', 'content-length', 'content-encoding'].includes(key.toLowerCase())) return
    resHeaders[key] = value
  })
  res.writeHead(upstream.status, resHeaders)
  if (upstream.body) {
    const reader = upstream.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  }
  res.end()
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
}

const sendJson = (res, status, body) => {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
  })
  res.end(bytes)
}

const sendError = (res, status, message) => sendJson(res, status, { error: message })

const readBody = async (req, limit) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      throw Object.assign(new Error('request body too large'), { status: 413 })
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * 解析批量原件的紧凑二进制帧（与 localServer.ts 的 postFilesBatch 对应）：
 * 每条记录 = 3 个小端 u32（id / mime / data 长度）+ 三段原始字节。
 */
const parseFileBatch = (buf) => {
  const files = []
  let offset = 0
  while (offset < buf.length) {
    if (offset + 12 > buf.length) {
      throw Object.assign(new Error('malformed file batch'), { status: 400 })
    }
    const idLength = buf.readUInt32LE(offset)
    const mimeLength = buf.readUInt32LE(offset + 4)
    const dataLength = buf.readUInt32LE(offset + 8)
    offset += 12
    if (
      idLength === 0 ||
      idLength > 1024 ||
      mimeLength > 256 ||
      dataLength > MAX_BLOB ||
      offset + idLength + mimeLength + dataLength > buf.length
    ) {
      throw Object.assign(new Error('malformed file batch'), { status: 400 })
    }
    const id = buf.toString('utf8', offset, offset + idLength)
    offset += idLength
    const mimeType = buf.toString('utf8', offset, offset + mimeLength)
    offset += mimeLength
    files.push({ id, mimeType, data: buf.subarray(offset, offset + dataLength) })
    offset += dataLength
  }
  return files
}

const readJson = async (req) => {
  const bytes = await readBody(req, MAX_JSON)
  if (bytes.length === 0) {
    return {}
  }
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 })
  }
}

const idOf = (value) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const serveStatic = (req, res, pathname) => {
  if (!existsSync(DIST)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('dist/ 不存在，请先运行 pnpm build。开发模式请通过 pnpm dev 访问页面。')
    return
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  let file = path.resolve(DIST, relative)
  // 防止目录穿越
  if (!file.startsWith(DIST + path.sep) && file !== path.join(DIST, 'index.html')) {
    file = path.join(DIST, 'index.html')
  }
  // SPA 路由回退：没有扩展名的路径一律返回 index.html
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (path.extname(pathname)) {
      sendError(res, 404, 'not found')
      return
    }
    file = path.join(DIST, 'index.html')
  }
  const ext = path.extname(file).toLowerCase()
  const immutable = file.includes(`${path.sep}static${path.sep}`)
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(file).pipe(res)
}

const api = async (req, res, url) => {
  const segments = url.pathname.split('/').filter(Boolean)
  const method = req.method ?? 'GET'

  if (segments[1] === 'health') {
    return sendJson(res, 200, { ok: true, db: dbFile, ...stats() })
  }

  if (segments[1] === 'stats') {
    return sendJson(res, 200, stats())
  }

  if (segments[1] === 'usage') {
    if (method !== 'GET') {
      return sendError(res, 405, 'method not allowed')
    }
    return sendJson(res, 200, usageSummary())
  }

  if (segments[1] === 'search') {
    if (method !== 'GET') {
      return sendError(res, 405, 'method not allowed')
    }
    const query = url.searchParams.get('q') ?? ''
    const limit = Number(url.searchParams.get('limit') ?? 30)
    return sendJson(res, 200, { results: searchMessages(query, limit) })
  }

  if (segments[1] === 'folders') {
    if (segments.length === 2) {
      if (method === 'GET') {
        return sendJson(res, 200, { folders: listFolders() })
      }
      if (method === 'POST') {
        const body = await readJson(req)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name) {
          return sendError(res, 400, 'folder name is required')
        }
        return sendJson(
          res,
          200,
          createFolder({
            id: randomUUID().replace(/-/g, ''),
            name,
            createdAt: Date.now(),
          })
        )
      }
      return sendError(res, 405, 'method not allowed')
    }
    const id = idOf(segments[2])
    if (method === 'PATCH') {
      const body = await readJson(req)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) {
        return sendError(res, 400, 'folder name is required')
      }
      return renameFolder(id, name)
        ? sendJson(res, 200, { ok: true })
        : sendError(res, 404, 'folder not found')
    }
    if (method === 'DELETE') {
      deleteFolder(id)
      return sendJson(res, 200, { ok: true })
    }
    return sendError(res, 405, 'method not allowed')
  }

  if (segments[1] === 'sessions') {
    if (segments.length === 2) {
      if (method === 'GET') {
        return sendJson(res, 200, { sessions: listSessions() })
      }
      return sendError(res, 405, 'method not allowed')
    }
    if (segments[2] === 'batch' && method === 'POST') {
      const body = await readJson(req)
      const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : []
      const action = body.action
      if (action === 'delete') {
        for (const id of ids) {
          deleteSession(id)
        }
        return sendJson(res, 200, { deletedIds: ids, failedIds: [], limitReached: false })
      }
      if (action === 'pin' || action === 'unpin') {
        const succeededIds = []
        const failedIds = []
        let limitReached = false
        for (const id of ids) {
          const result = setSessionPinned(id, action === 'pin')
          if (result === 'ok') {
            succeededIds.push(id)
          } else {
            if (result === 'limit') {
              limitReached = true
            }
            failedIds.push(id)
          }
        }
        return sendJson(res, 200, { succeededIds, failedIds, limitReached })
      }
      return sendError(res, 400, 'unknown batch action')
    }
    const id = idOf(segments[2])
    if (method === 'GET') {
      const session = getSession(id)
      return session ? sendJson(res, 200, session) : sendError(res, 404, 'session not found')
    }
    if (method === 'PUT') {
      const body = await readJson(req)
      if (!body.session || body.session.id !== id) {
        return sendError(res, 400, 'session id mismatch')
      }
      putSession(body.session)
      return sendJson(res, 200, { ok: true })
    }
    if (method === 'PATCH') {
      const body = await readJson(req)
      if (typeof body.pinned === 'boolean') {
        const result = setSessionPinned(id, body.pinned)
        if (result === 'missing') {
          return sendError(res, 404, 'session not found')
        }
        if (result === 'limit') {
          return sendJson(res, 409, { error: 'pin limit reached', code: 'pin_limit' })
        }
        return sendJson(res, 200, { ok: true })
      }
      if (Object.hasOwn(body, 'folderId')) {
        const folderId =
          body.folderId === null
            ? null
            : typeof body.folderId === 'string' && body.folderId
              ? body.folderId
              : undefined
        if (folderId === undefined) {
          return sendError(res, 400, 'invalid folderId')
        }
        const result = setSessionFolder(id, folderId)
        if (result === 'missing') {
          return sendError(res, 404, 'session not found')
        }
        if (result === 'folder-missing') {
          return sendError(res, 404, 'folder not found')
        }
        return sendJson(res, 200, { ok: true })
      }
      if (typeof body.title !== 'string') {
        return sendError(res, 400, 'title or pinned is required')
      }
      return renameSession(id, body.title)
        ? sendJson(res, 200, { ok: true })
        : sendError(res, 404, 'session not found')
    }
    if (method === 'DELETE') {
      deleteSession(id)
      return sendJson(res, 200, { ok: true })
    }
    return sendError(res, 405, 'method not allowed')
  }

  if (segments[1] === 'files' && segments[2]) {
    const id = idOf(segments[2])
    if (method === 'GET') {
      const file = getFile(id)
      if (!file) {
        return sendError(res, 404, 'file not found')
      }
      const bytes = Buffer.from(file.data)
      res.writeHead(200, {
        'content-type': file.mimeType || 'application/octet-stream',
        'content-length': bytes.length,
        'cache-control': 'private, max-age=31536000, immutable',
      })
      return res.end(bytes)
    }
    if (method === 'POST' || method === 'PUT') {
      const data = await readBody(req, MAX_BLOB)
      const mimeType = req.headers['x-mime-type'] ?? 'application/octet-stream'
      putFiles([{ id, mimeType, data, staging: url.searchParams.get('staging') === '1' }])
      return sendJson(res, 200, { ok: true })
    }
    return sendError(res, 405, 'method not allowed')
  }

  if (segments[1] === 'staging') {
    if (segments[2] === 'clear' && method === 'POST') {
      clearStaging()
      return sendJson(res, 200, { ok: true })
    }
    if (segments[2] === 'sessions' && segments[3] === 'batch' && method === 'POST') {
      const bytes = await readBody(req, MAX_SESSION_BATCH)
      const body = JSON.parse(bytes.toString('utf8'))
      if (!Array.isArray(body.sessions)) {
        return sendError(res, 400, 'sessions must be an array')
      }
      putStagingSessions(body.sessions)
      return sendJson(res, 200, { ok: true })
    }
    if (segments[2] === 'files' && segments[3] === 'batch' && method === 'POST') {
      const bytes = await readBody(req, MAX_FILE_BATCH)
      putStagingFiles(parseFileBatch(bytes))
      return sendJson(res, 200, { ok: true })
    }
    if (segments[2] === 'sessions' && segments[3] && (method === 'PUT' || method === 'POST')) {
      const body = await readJson(req)
      if (!body.session || body.session.id !== idOf(segments[3])) {
        return sendError(res, 400, 'session id mismatch')
      }
      putStagingSession(body.session)
      return sendJson(res, 200, { ok: true })
    }
    if (segments[2] === 'types' && method === 'POST') {
      const body = await readJson(req)
      if (!Array.isArray(body.types)) {
        return sendError(res, 400, 'types must be an array')
      }
      updateStagingFileTypes(body.types)
      return sendJson(res, 200, { ok: true })
    }
    if (segments[2] === 'commit' && method === 'POST') {
      return sendJson(res, 200, { sessions: commitStaging() })
    }
    return sendError(res, 404, 'not found')
  }

  if (segments[1] === 'memories') {
    if (segments.length === 2) {
      if (method === 'GET') {
        return sendJson(res, 200, { memories: listMemories() })
      }
      if (method === 'PUT') {
        const body = await readJson(req)
        if (!Array.isArray(body.entries)) {
          return sendError(res, 400, 'entries must be an array')
        }
        putMemories(body.entries)
        return sendJson(res, 200, { ok: true })
      }
      if (method === 'DELETE') {
        clearMemories()
        return sendJson(res, 200, { ok: true })
      }
      return sendError(res, 405, 'method not allowed')
    }
    if (method === 'DELETE') {
      deleteMemory(idOf(segments[2]))
      return sendJson(res, 200, { ok: true })
    }
    return sendError(res, 405, 'method not allowed')
  }

  if (segments[1] === 'shares') {
    if (segments.length === 2) {
      if (method === 'GET') {
        return sendJson(res, 200, { shares: listShares() })
      }
      if (method === 'POST') {
        const body = await readJson(req)
        const session = typeof body.sessionId === 'string' ? getSession(body.sessionId) : null
        if (!session) {
          return sendError(res, 404, 'session not found')
        }
        const ids = Array.isArray(body.messageIds)
          ? body.messageIds.filter((id) => typeof id === 'string')
          : []
        const wanted = new Set(ids)
        const messages = (session.messages ?? []).flatMap((message) => {
          if (wanted.size > 0 && !wanted.has(message.id)) {
            return []
          }
          if (message.role === 'user') {
            const content = typeof message.content === 'string' ? message.content : ''
            const files = (message.files ?? []).map((file) => ({
              id: file.id,
              name: file.name,
              size: file.size,
              isImage: file.isImage === true,
            }))
            return content.trim() || files.length
              ? [{ id: message.id, role: 'user', content, createdAt: message.createdAt, files }]
              : []
          }
          const text = (message.blocks ?? [])
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
          return text.trim()
            ? [{ id: message.id, role: 'assistant', text, createdAt: message.createdAt }]
            : []
        })
        if (messages.length === 0) {
          return sendError(res, 400, 'no shareable messages')
        }
        const share = createShare({
          id: randomUUID().replace(/-/g, ''),
          sessionId: session.id,
          title: session.title,
          messages,
          createdAt: Date.now(),
        })
        return sendJson(res, 200, share)
      }
      return sendError(res, 405, 'method not allowed')
    }
    const id = idOf(segments[2])
    if (method === 'GET') {
      const share = getShare(id)
      return share ? sendJson(res, 200, share) : sendError(res, 404, 'share not found')
    }
    if (method === 'DELETE') {
      deleteShare(id)
      return sendJson(res, 200, { ok: true })
    }
    return sendError(res, 405, 'method not allowed')
  }

  if (segments[1] === 'migrate') {
    if (segments[2] === 'legacy' && method === 'POST') {
      const bytes = await readBody(req, MAX_BLOB)
      importSnapshot(bytes)
      return sendJson(res, 200, { ok: true, ...stats() })
    }
    if (segments[2] === 'records' && method === 'POST') {
      const body = await readJson(req)
      importRecords({
        sessions: Array.isArray(body.sessions) ? body.sessions : [],
        memories: Array.isArray(body.memories) ? body.memories : [],
      })
      return sendJson(res, 200, { ok: true, ...stats() })
    }
    if (segments[2] === 'status' && method === 'GET') {
      return sendJson(res, 200, { imported: getMeta('legacy_imported') === '1', ...stats() })
    }
  }

  return sendError(res, 404, 'not found')
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const run = async () => {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await api(req, res, url)
      return
    }
    if (url.pathname.startsWith('/provider/')) {
      await proxyProvider(req, res, url.pathname)
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method not allowed')
      return
    }
    serveStatic(req, res, url.pathname)
  }
  void run().catch((error) => {
    const status = typeof error?.status === 'number' ? error.status : 500
    // eslint-disable-next-line no-console
    console.error('[server]', error)
    if (!res.headersSent) {
      sendError(res, status, error instanceof Error ? error.message : String(error))
    } else {
      res.end()
    }
  })
})

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`chat-demo server: http://${HOST}:${PORT}`)
  // eslint-disable-next-line no-console
  console.log(`database: ${dbFile}`)
})
