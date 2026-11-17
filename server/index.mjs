import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import {
  clearMemories,
  clearStaging,
  commitStaging,
  dbFile,
  deleteMemory,
  deleteSession,
  getFile,
  getMeta,
  getSession,
  importRecords,
  importSnapshot,
  listMemories,
  listSessions,
  putFiles,
  putMemories,
  putSession,
  putStagingSession,
  renameSession,
  setSessionPinned,
  stats,
  updateStagingFileTypes,
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

  if (segments[1] === 'sessions') {
    if (segments.length === 2) {
      if (method === 'GET') {
        return sendJson(res, 200, { sessions: listSessions() })
      }
      return sendError(res, 405, 'method not allowed')
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
        return setSessionPinned(id, body.pinned)
          ? sendJson(res, 200, { ok: true })
          : sendError(res, 404, 'session not found')
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
