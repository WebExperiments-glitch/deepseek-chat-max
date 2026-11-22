/**
 * 纯浏览器存储后端。
 *
 * 静态托管时没有 Node + SQLite，本模块把原本发往 /api/* 的请求直接落到浏览器 IndexedDB。
 * 对外只暴露一个 handleBrowserRequest(path, init) -> Response，签名与 localServer.ts
 * 内部的 request() 一致：调用方只需在闸口把 /api/* 的请求转到这里，其他业务逻辑不用改。
 *
 * object store 与 server/db.mjs 的表一一对应；会话正文仍以 JSON 对象（结构化克隆）保存，
 * 列表字段单独存列，避免列表接口读取全部消息。语义尽量与 server/index.mjs 对齐，
 * 简化处（无 FTS、无 SQL 事务、无 x-disposition 实际网络层）都在注释里标明。
 */
import { openDB, type DBSchema, type IDBPDatabase } from '../platform/idb.js'
import type { Folder, Session, SessionSummary } from '../chat/types.js'
import type { MemoryEntry } from '../memory/types.js'
import type { ShareMessage } from '../shares.js'
import type { ChatSearchResult } from '../search.js'

const DB_NAME = 'deepseek-chat-max'
const DB_VERSION = 1
/** /api/health 的 db 字段：浏览器里没有文件路径，给一个可辨识的标识 */
export const DB_LABEL = `indexeddb://${DB_NAME}`

export const STORES = [
  'sessions',
  'files',
  'folders',
  'staging_sessions',
  'staging_files',
  'memories',
  'shares',
  'meta',
] as const
export type StoreName = (typeof STORES)[number]

/** keyPath 与 db.mjs 的表主键一致（meta 用 key，其余用 id） */
const KEY_PATH: Record<StoreName, string> = {
  sessions: 'id',
  files: 'id',
  folders: 'id',
  staging_sessions: 'id',
  staging_files: 'id',
  memories: 'id',
  shares: 'id',
  meta: 'key',
}

/** 会话行对应 sessions / staging_sessions 表；payload 用对象而不是 JSON 字符串 */
export type SessionRow = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  fileIds: string[]
  payload: Session
  pinned: boolean
  folderId: string | null
}

/** 原件行对应 files / staging_files 表；IndexedDB 原生支持 Blob，无需转 ArrayBuffer */
export type FileRow = { id: string; mimeType: string; data: Blob }

/** 分享行对应 shares 表；payload 固化创建时的消息快照 */
export type ShareRow = {
  id: string
  sessionId: string
  title: string
  payload: { title: string; createdAt: number; messages: ShareMessage[] }
  createdAt: number
}

export type MetaRow = { key: string; value: string }

export interface ChatDB extends DBSchema {
  sessions: { key: string; value: SessionRow }
  files: { key: string; value: FileRow }
  folders: { key: string; value: Folder }
  staging_sessions: { key: string; value: SessionRow }
  staging_files: { key: string; value: FileRow }
  memories: { key: string; value: MemoryEntry }
  shares: { key: string; value: ShareRow }
  meta: { key: string; value: MetaRow }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

/** 惰性打开：只在真正处理请求时访问 indexedDB，便于在 Node 环境下安全导入本模块 */
export const getDatabase = (): Promise<IDBPDatabase<ChatDB>> =>
  (dbPromise ??= openDB<ChatDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: KEY_PATH[name] })
        }
      }
    },
  }))

// ---------------------------------------------------------------------------
// Response 构造与请求体解析
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })

/** 空 body 的 404：让 localServer.ts 的 getJsonOptional / getBlob 按状态码兜底 */
const notFound = (): Response => new Response('', { status: 404 })

const ok = (): Response => json({ ok: true })

const fail = (status: number, message: string, extra: Record<string, unknown> = {}): Response =>
  json({ error: message, ...extra }, status)

class BrowserBackendError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message)
    this.name = 'BrowserBackendError'
  }
}

const invalid = (message: string): never => {
  throw new BrowserBackendError(message)
}

const idOf = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const header = (init: RequestInit | undefined, name: string): string | undefined =>
  new Headers(init?.headers).get(name) ?? undefined

const bodyBytes = async (init?: RequestInit): Promise<Uint8Array> => {
  const body = init?.body
  if (body == null) {
    return new Uint8Array()
  }
  if (typeof body === 'string') {
    return new TextEncoder().encode(body)
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer())
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body)
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  }
  // URLSearchParams / FormData / ReadableStream 这些请求体在当前调用点用不到
  return new Uint8Array()
}

const bodyJson = async (init?: RequestInit): Promise<Record<string, unknown>> => {
  const bytes = await bodyBytes(init)
  if (bytes.byteLength === 0) {
    return {}
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return invalid('invalid JSON body')
  }
}

/** TS 7 的 BlobPart 接受新分配的 ArrayBuffer，复制一份避免视图类型歧义 */
export const bytesToBlob = (bytes: Uint8Array, type = 'application/octet-stream'): Blob => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return new Blob([buffer], { type })
}

const arrayBufferOf = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

const newId = (): string => {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID().replace(/-/g, '')
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
}

// ---------------------------------------------------------------------------
// 纯逻辑：列表摘要、批量原件帧、搜索。抽出以便无 IndexedDB 环境下也能单测。
// ---------------------------------------------------------------------------

const fileIdsOf = (session: Session): string[] => [
  ...new Set(
    (session.messages ?? []).flatMap((message) =>
      message.role === 'user' ? (message.files ?? []).map((file) => file.id) : []
    )
  ),
]

/** 与 db.mjs 的 listSessions 返回形状一致：pinned 恒为布尔，folderId 恒为字符串或 null */
export const toSessionSummary = (row: SessionRow): SessionSummary => ({
  id: row.id,
  title: row.title,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  pinned: row.pinned === true,
  folderId: row.folderId ?? null,
})

/** 解析 postFilesBatch 的紧凑帧：3 个小端 u32 + id / mime / data 三段原始字节 */
export const parseFileBatch = (
  buffer: Uint8Array
): { id: string; mimeType: string; data: Uint8Array }[] => {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const files: { id: string; mimeType: string; data: Uint8Array }[] = []
  let offset = 0
  while (offset < buffer.byteLength) {
    if (offset + 12 > buffer.byteLength) {
      return invalid('malformed file batch')
    }
    const idLength = view.getUint32(offset, true)
    const mimeLength = view.getUint32(offset + 4, true)
    const dataLength = view.getUint32(offset + 8, true)
    offset += 12
    if (
      idLength === 0 ||
      idLength > 1024 ||
      mimeLength > 256 ||
      offset + idLength + mimeLength + dataLength > buffer.byteLength
    ) {
      return invalid('malformed file batch')
    }
    const decode = new TextDecoder('utf8')
    const id = decode.decode(buffer.subarray(offset, offset + idLength))
    offset += idLength
    const mimeType = decode.decode(buffer.subarray(offset, offset + mimeLength))
    offset += mimeLength
    files.push({ id, mimeType, data: buffer.subarray(offset, offset + dataLength) })
    offset += dataLength
  }
  return files
}

/** 会话正文里参与搜索的文字：用户取正文，助手取文本块（与 db.mjs 的 searchableText 一致） */
const searchableText = (message: Session['messages'][number] | undefined): string => {
  if (!message || typeof message.id !== 'string') {
    return ''
  }
  if (message.role === 'user') {
    return typeof message.content === 'string' ? message.content : ''
  }
  if (!Array.isArray(message.blocks)) {
    return ''
  }
  return message.blocks
    .flatMap((block) =>
      block?.type === 'text' && typeof (block as { text?: unknown }).text === 'string'
        ? [(block as { text: string }).text]
        : []
    )
    .join('\n')
}

/** 命中位置切成三段，客户端可直接渲染，不需要注入 HTML */
export const likeSnippet = (content: string, query: string) => {
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
 * 简易全文搜索：对每条消息做大小写不敏感的子串匹配（原生 includes 支持中文），
 * 不建 FTS 索引；数据量在本地浏览器，遍历即可。排序与截断规则对齐 db.mjs。
 */
export const makeSearchResults = (
  rows: readonly Pick<SessionRow, 'id' | 'title' | 'updatedAt' | 'payload'>[],
  rawQuery: string,
  limit = 30
): ChatSearchResult[] => {
  const query = String(rawQuery ?? '').trim()
  if (!query) {
    return []
  }
  const size = Math.min(100, Math.max(1, Number(limit) || 30))
  const needle = query.toLowerCase()
  const hits: { result: ChatSearchResult; createdAt: number }[] = []
  for (const row of rows) {
    for (const message of row.payload.messages ?? []) {
      const text = searchableText(message).trim()
      if (!text || !text.toLowerCase().includes(needle)) {
        continue
      }
      hits.push({
        result: {
          sessionId: row.id,
          messageId: message?.id ?? '',
          role: message?.role === 'user' ? 'user' : 'assistant',
          title: row.title ?? '',
          updatedAt: row.updatedAt,
          ...likeSnippet(text, query),
        },
        createdAt: Number(message?.createdAt) || 0,
      })
    }
  }
  hits.sort((a, b) => b.result.updatedAt - a.result.updatedAt || a.createdAt - b.createdAt)
  return hits.slice(0, size).map((hit) => hit.result)
}

// ---------------------------------------------------------------------------
// 行写入与领域操作
// ---------------------------------------------------------------------------

/** pinned 只存在于列表元数据，正文类型里没有；兼容归档数据里附带的字段 */
const sessionPinned = (session: Session): boolean =>
  (session as Session & { pinned?: boolean }).pinned === true

/**
 * 构造会话行。正式表与 SQLite 的写入冲突语义保持一致：
 * 已存在时只更新列表字段与 payload，保留 pinned / folderId；
 * staging 表用 INSERT OR REPLACE，保留归档里的置顶与文件夹归属。
 */
const makeSessionRow = (session: Session, existing: SessionRow | undefined, staging: boolean): SessionRow => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  fileIds: fileIdsOf(session),
  payload: session,
  pinned: staging ? sessionPinned(session) : (existing?.pinned ?? false),
  folderId: staging
    ? session.folderId ?? null
    : existing
      ? existing.folderId
      : session.folderId ?? null,
})

const putSessionRow = async (
  db: IDBPDatabase<ChatDB>,
  session: Session,
  staging: boolean
): Promise<void> => {
  const store = staging ? 'staging_sessions' : 'sessions'
  const existing = await db.get(store, session.id)
  await db.put(store, makeSessionRow(session, existing, staging))
}

const listSessionRows = async (
  db: IDBPDatabase<ChatDB>,
  staging = false
): Promise<SessionRow[]> => {
  const rows = await db.getAll(staging ? 'staging_sessions' : 'sessions')
  return rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
}

const PIN_LIMIT = 10

type PinResult = 'ok' | 'missing' | 'limit'

const setSessionPinned = async (
  db: IDBPDatabase<ChatDB>,
  id: string,
  pinned: boolean
): Promise<PinResult> => {
  const row = await db.get('sessions', id)
  if (!row) {
    return 'missing'
  }
  if (pinned && !row.pinned) {
    const rows = await db.getAll('sessions')
    if (rows.filter((item) => item.pinned).length >= PIN_LIMIT) {
      return 'limit'
    }
  }
  await db.put('sessions', { ...row, pinned })
  return 'ok'
}

type FolderResult = 'ok' | 'missing' | 'folder-missing'

const setSessionFolder = async (
  db: IDBPDatabase<ChatDB>,
  id: string,
  folderId: string | null
): Promise<FolderResult> => {
  const row = await db.get('sessions', id)
  if (!row) {
    return 'missing'
  }
  if (folderId !== null && !(await db.get('folders', folderId))) {
    return 'folder-missing'
  }
  await db.put('sessions', { ...row, folderId })
  return 'ok'
}

const renameSession = async (db: IDBPDatabase<ChatDB>, id: string, title: string): Promise<boolean> => {
  const row = await db.get('sessions', id)
  if (!row) {
    return false
  }
  await db.put('sessions', { ...row, title, payload: { ...row.payload, title } })
  return true
}

/** 删除会话：同时清理它生成的分享链接，以及不再被任何会话引用的原件 */
const deleteSessionById = async (db: IDBPDatabase<ChatDB>, id: string): Promise<void> => {
  const row = await db.get('sessions', id)
  const own = row?.fileIds ?? []
  const [shares, sessions] = await Promise.all([db.getAll('shares'), db.getAll('sessions')])
  const referenced = new Set(
    sessions.filter((item) => item.id !== id).flatMap((item) => item.fileIds)
  )
  const orphanFiles = own.filter((fileId) => !referenced.has(fileId))
  const tx = db.transaction(['sessions', 'shares', 'files'], 'readwrite')
  tx.objectStore('sessions').delete(id)
  for (const share of shares) {
    if (share.sessionId === id) {
      tx.objectStore('shares').delete(share.id)
    }
  }
  for (const fileId of orphanFiles) {
    tx.objectStore('files').delete(fileId)
  }
  await tx.done
}

const writeMemory = async (db: IDBPDatabase<ChatDB>, value: MemoryEntry): Promise<void> => {
  const asBool = (item: unknown): boolean => item === true || item === 1
  const entry: MemoryEntry = {
    ...value,
    keywords: Array.isArray(value.keywords) ? value.keywords : [],
    sourceMessageIds: Array.isArray(value.sourceMessageIds) ? value.sourceMessageIds : [],
    pinned: asBool(value.pinned),
    archived: asBool(value.archived),
    manual: asBool(value.manual),
  }
  await db.put('memories', entry)
}

const listMemories = async (db: IDBPDatabase<ChatDB>): Promise<MemoryEntry[]> => {
  const rows = await db.getAll('memories')
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

const shareMessages = (session: Session, ids: string[]): ShareMessage[] => {
  const wanted = new Set(ids)
  return (session.messages ?? []).flatMap((message): ShareMessage[] => {
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
        ? [{ id: message.id, role: 'user' as const, content, createdAt: message.createdAt, files }]
        : []
    }
    const text = (message.blocks ?? [])
      .flatMap((block) =>
        block?.type === 'text' && typeof (block as { text?: unknown }).text === 'string'
          ? [(block as { text: string }).text]
          : []
      )
      .join('\n')
    return text.trim()
      ? [{ id: message.id, role: 'assistant' as const, text, createdAt: message.createdAt }]
      : []
  })
}

const shareMeta = (row: ShareRow) => ({
  id: row.id,
  sessionId: row.sessionId,
  title: row.title,
  createdAt: row.createdAt,
  count: row.payload.messages.length,
})

const shareFull = (row: ShareRow) => ({
  id: row.id,
  sessionId: row.sessionId,
  title: row.title,
  createdAt: row.createdAt,
  messages: Array.isArray(row.payload.messages) ? row.payload.messages : [],
})

const stats = async (db: IDBPDatabase<ChatDB>) => {
  const [sessions, files, memories] = await Promise.all([
    db.count('sessions'),
    db.count('files'),
    db.count('memories'),
  ])
  return { sessions, files, memories }
}

/** 用量汇总：遍历会话正文里的 usage，与 db.mjs 的 usageSummary 同规则 */
const usageSummary = async (db: IDBPDatabase<ChatDB>) => {
  const rows = (await db.getAll('sessions')).sort((a, b) => b.updatedAt - a.updatedAt)
  const totals = {
    requests: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  }
  const sessions: {
    id: string
    title: string
    updatedAt: number
    requests: number
    inputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    outputTokens: number
    promptTokens: number
    cacheHitRate: number
  }[] = []
  for (const row of rows) {
    let inputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let outputTokens = 0
    let requests = 0
    for (const message of row.payload.messages ?? []) {
      const usage = message && 'usage' in message ? message.usage : undefined
      if (!usage) {
        continue
      }
      requests += 1
      inputTokens += Number(usage.input_tokens) || 0
      cacheReadTokens += Number(usage.cache_read_input_tokens) || 0
      cacheWriteTokens += Number(usage.cache_creation_input_tokens) || 0
      outputTokens += Number(usage.output_tokens) || 0
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
  const promptTokens = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  return {
    totals: {
      ...totals,
      promptTokens,
      cacheHitRate: promptTokens > 0 ? totals.cacheReadTokens / promptTokens : 0,
    },
    sessions,
  }
}

// ---------------------------------------------------------------------------
// 路由：分支与 server/index.mjs 的 api() 一一对应
// ---------------------------------------------------------------------------

const route = async (path: string, init?: RequestInit): Promise<Response> => {
  const url = new URL(path, 'http://browser.local')
  const segments = url.pathname.split('/').filter(Boolean)
  const method = (init?.method ?? 'GET').toUpperCase()
  const db = await getDatabase()

  if (segments[1] === 'health') {
    return json({ ok: true, db: DB_LABEL, ...(await stats(db)) })
  }

  if (segments[1] === 'stats') {
    return json(await stats(db))
  }

  if (segments[1] === 'usage') {
    return method === 'GET' ? json(await usageSummary(db)) : fail(405, 'method not allowed')
  }

  if (segments[1] === 'search') {
    if (method !== 'GET') {
      return fail(405, 'method not allowed')
    }
    const rows = await db.getAll('sessions')
    const results = makeSearchResults(
      rows,
      url.searchParams.get('q') ?? '',
      Number(url.searchParams.get('limit') ?? 30)
    )
    return json({ results })
  }

  if (segments[1] === 'folders') {
    if (segments.length === 2) {
      if (method === 'GET') {
        const folders = (await db.getAll('folders')).sort((a, b) => a.createdAt - b.createdAt)
        return json({ folders })
      }
      if (method === 'POST') {
        const body = await bodyJson(init)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name) {
          return fail(400, 'folder name is required')
        }
        const folder: Folder = { id: newId(), name, createdAt: Date.now() }
        await db.put('folders', folder)
        return json(folder)
      }
      return fail(405, 'method not allowed')
    }
    const id = idOf(segments[2] ?? '')
    if (method === 'PATCH') {
      const body = await bodyJson(init)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) {
        return fail(400, 'folder name is required')
      }
      const row = await db.get('folders', id)
      if (!row) {
        return fail(404, 'folder not found')
      }
      await db.put('folders', { ...row, name })
      return ok()
    }
    if (method === 'DELETE') {
      // 先读完再开事务：事务里 await 其他请求会让它自动提交，后续 put 将失效
      const affected = (await db.getAll('sessions')).filter((row) => row.folderId === id)
      const tx = db.transaction(['folders', 'sessions'], 'readwrite')
      tx.objectStore('folders').delete(id)
      // 与 db.mjs 一致：删除文件夹只清空会话的归档关系，不删除会话
      for (const row of affected) {
        tx.objectStore('sessions').put({ ...row, folderId: null })
      }
      await tx.done
      return ok()
    }
    return fail(405, 'method not allowed')
  }

  if (segments[1] === 'sessions') {
    if (segments.length === 2) {
      return method === 'GET'
        ? json({ sessions: (await listSessionRows(db)).map(toSessionSummary) })
        : fail(405, 'method not allowed')
    }
    if (segments[2] === 'batch' && method === 'POST') {
      const body = await bodyJson(init)
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : []
      if (body.action === 'delete') {
        for (const id of ids) {
          await deleteSessionById(db, id)
        }
        return json({ deletedIds: ids, failedIds: [], limitReached: false })
      }
      if (body.action === 'pin' || body.action === 'unpin') {
        const succeededIds: string[] = []
        const failedIds: string[] = []
        let limitReached = false
        for (const id of ids) {
          const result = await setSessionPinned(db, id, body.action === 'pin')
          if (result === 'ok') {
            succeededIds.push(id)
          } else {
            limitReached ||= result === 'limit'
            failedIds.push(id)
          }
        }
        return json({ succeededIds, failedIds, limitReached })
      }
      return fail(400, 'unknown batch action')
    }
    const id = idOf(segments[2] ?? '')
    if (method === 'GET') {
      const row = await db.get('sessions', id)
      return row ? json(row.payload) : notFound()
    }
    if (method === 'PUT') {
      const body = await bodyJson(init)
      const session = body.session as Session | undefined
      if (!session || session.id !== id) {
        return fail(400, 'session id mismatch')
      }
      await putSessionRow(db, session, false)
      return ok()
    }
    if (method === 'PATCH') {
      const body = await bodyJson(init)
      if (typeof body.pinned === 'boolean') {
        const result = await setSessionPinned(db, id, body.pinned)
        if (result === 'missing') {
          return fail(404, 'session not found')
        }
        if (result === 'limit') {
          return fail(409, 'pin limit reached', { code: 'pin_limit' })
        }
        return ok()
      }
      if (Object.hasOwn(body, 'folderId')) {
        const raw = body.folderId
        const folderId =
          raw === null ? null : typeof raw === 'string' && raw ? raw : undefined
        if (folderId === undefined) {
          return fail(400, 'invalid folderId')
        }
        const result = await setSessionFolder(db, id, folderId)
        if (result === 'missing') {
          return fail(404, 'session not found')
        }
        if (result === 'folder-missing') {
          return fail(404, 'folder not found')
        }
        return ok()
      }
      if (typeof body.title !== 'string') {
        return fail(400, 'title or pinned is required')
      }
      return (await renameSession(db, id, body.title))
        ? ok()
        : fail(404, 'session not found')
    }
    if (method === 'DELETE') {
      await deleteSessionById(db, id)
      return ok()
    }
    return fail(405, 'method not allowed')
  }

  if (segments[1] === 'files' && segments[2]) {
    // /api/files/batch 是浏览器后端补充的入口；app 实际使用的是 /api/staging/files/batch。
    if (segments[2] === 'batch' && method === 'POST') {
      const files = parseFileBatch(await bodyBytes(init))
      const tx = db.transaction('files', 'readwrite')
      for (const file of files) {
        tx.objectStore('files').put({ id: file.id, mimeType: file.mimeType, data: bytesToBlob(file.data, file.mimeType) })
      }
      await tx.done
      return ok()
    }
    const id = idOf(segments[2])
    if (method === 'GET') {
      // 服务端 getFile 只查正式表，staging 参数在 GET 上不生效
      const row = await db.get('files', id)
      if (!row) {
        return notFound()
      }
      const mime = String(row.mimeType || 'application/octet-stream').toLowerCase()
      const disposition =
        header(init, 'x-disposition') === 'inline' && /^image\//.test(mime) ? 'inline' : 'attachment'
      return new Response(row.data, {
        status: 200,
        headers: {
          'content-type': mime,
          'cache-control': 'private, max-age=31536000, immutable',
          'content-disposition': `${disposition}; filename="file"`,
        },
      })
    }
    if (method === 'POST' || method === 'PUT') {
      const mimeType = header(init, 'x-mime-type') ?? 'application/octet-stream'
      const store = url.searchParams.get('staging') === '1' ? 'staging_files' : 'files'
      await db.put(store, { id, mimeType, data: bytesToBlob(await bodyBytes(init), mimeType) })
      return ok()
    }
    if (method === 'DELETE') {
      // 服务端没有这个端点；保留给浏览器后端做完整的文件管理
      const tx = db.transaction(['files', 'staging_files'], 'readwrite')
      tx.objectStore('files').delete(id)
      tx.objectStore('staging_files').delete(id)
      await tx.done
      return ok()
    }
    return fail(405, 'method not allowed')
  }

  if (segments[1] === 'staging') {
    if (segments[2] === 'clear' && method === 'POST') {
      const tx = db.transaction(['staging_sessions', 'staging_files'], 'readwrite')
      tx.objectStore('staging_sessions').clear()
      tx.objectStore('staging_files').clear()
      await tx.done
      return ok()
    }
    if (segments[2] === 'sessions' && segments[3] === 'batch' && method === 'POST') {
      const body = await bodyJson(init)
      if (!Array.isArray(body.sessions)) {
        return fail(400, 'sessions must be an array')
      }
      const sessions = await db.getAll('staging_sessions')
      const byId = new Map(sessions.map((row) => [row.id, row]))
      const tx = db.transaction('staging_sessions', 'readwrite')
      for (const value of body.sessions) {
        const session = value as Session
        if (session && typeof session.id === 'string') {
          tx.objectStore('staging_sessions').put(makeSessionRow(session, byId.get(session.id), true))
        }
      }
      await tx.done
      return ok()
    }
    if (segments[2] === 'files' && segments[3] === 'batch' && method === 'POST') {
      const files = parseFileBatch(await bodyBytes(init))
      const tx = db.transaction('staging_files', 'readwrite')
      for (const file of files) {
        tx.objectStore('staging_files').put({
          id: file.id,
          mimeType: file.mimeType,
          data: bytesToBlob(file.data, file.mimeType),
        })
      }
      await tx.done
      return ok()
    }
    if (segments[2] === 'sessions' && segments[3] && (method === 'PUT' || method === 'POST')) {
      const body = await bodyJson(init)
      const session = body.session as Session | undefined
      if (!session || session.id !== idOf(segments[3])) {
        return fail(400, 'session id mismatch')
      }
      await putSessionRow(db, session, true)
      return ok()
    }
    if (segments[2] === 'types' && method === 'POST') {
      const body = await bodyJson(init)
      if (!Array.isArray(body.types)) {
        return fail(400, 'types must be an array')
      }
      const types = new Map(
        body.types.filter((pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2)
      )
      const rows = await db.getAll('staging_sessions')
      const tx = db.transaction('staging_sessions', 'readwrite')
      for (const row of rows) {
        let changed = false
        const messages = (row.payload.messages ?? []).map((message) => {
          if (message.role !== 'user') {
            return message
          }
          const files = (message.files ?? []).map((file) => {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              changed = true
              return { ...file, mimeType: type }
            }
            return file
          })
          return { ...message, files }
        })
        if (changed) {
          tx.objectStore('staging_sessions').put({
            ...row,
            payload: { ...row.payload, messages },
          })
        }
      }
      await tx.done
      return ok()
    }
    if (segments[2] === 'commit' && method === 'POST') {
      const [stagingSessions, stagingFiles] = await Promise.all([
        db.getAll('staging_sessions'),
        db.getAll('staging_files'),
      ])
      const summaries = stagingSessions.map(toSessionSummary)
      // 模拟 db.mjs 的表交换：清空正式表 → 写入暂存数据 → 清空暂存表。
      // IndexedDB 用一个读写事务完成，中途出错整体回滚。
      const tx = db.transaction(
        ['sessions', 'files', 'staging_sessions', 'staging_files', 'shares'],
        'readwrite'
      )
      tx.objectStore('sessions').clear()
      tx.objectStore('files').clear()
      tx.objectStore('shares').clear()
      for (const row of stagingSessions) {
        tx.objectStore('sessions').put(row)
      }
      for (const row of stagingFiles) {
        tx.objectStore('files').put(row)
      }
      tx.objectStore('staging_sessions').clear()
      tx.objectStore('staging_files').clear()
      await tx.done
      return json({ sessions: summaries })
    }
    return notFound()
  }

  if (segments[1] === 'memories') {
    if (segments.length === 2) {
      if (method === 'GET') {
        return json({ memories: await listMemories(db) })
      }
      if (method === 'PUT') {
        const body = await bodyJson(init)
        if (!Array.isArray(body.entries)) {
          return fail(400, 'entries must be an array')
        }
        const tx = db.transaction('memories', 'readwrite')
        for (const value of body.entries) {
          if (value && typeof value === 'object') {
            tx.objectStore('memories').put(value as MemoryEntry)
          }
        }
        await tx.done
        return ok()
      }
      if (method === 'DELETE') {
        await db.clear('memories')
        return ok()
      }
      return fail(405, 'method not allowed')
    }
    if (method === 'DELETE') {
      await db.delete('memories', idOf(segments[2] ?? ''))
      return ok()
    }
    return fail(405, 'method not allowed')
  }

  if (segments[1] === 'shares') {
    if (segments.length === 2) {
      if (method === 'GET') {
        const rows = (await db.getAll('shares')).sort((a, b) => b.createdAt - a.createdAt)
        return json({ shares: rows.map(shareMeta) })
      }
      if (method === 'POST') {
        const body = await bodyJson(init)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const row = await db.get('sessions', sessionId)
        if (!row) {
          return fail(404, 'session not found')
        }
        const ids = Array.isArray(body.messageIds)
          ? body.messageIds.filter((id): id is string => typeof id === 'string')
          : []
        const messages = shareMessages(row.payload, ids)
        if (messages.length === 0) {
          return fail(400, 'no shareable messages')
        }
        const share: ShareRow = {
          id: newId(),
          sessionId: row.payload.id,
          title: row.payload.title,
          payload: { title: row.payload.title, createdAt: Date.now(), messages },
          createdAt: Date.now(),
        }
        await db.put('shares', share)
        return json(shareMeta(share))
      }
      return fail(405, 'method not allowed')
    }
    const id = idOf(segments[2] ?? '')
    if (method === 'GET') {
      const row = await db.get('shares', id)
      return row ? json(shareFull(row)) : notFound()
    }
    if (method === 'DELETE') {
      await db.delete('shares', id)
      return ok()
    }
    return fail(405, 'method not allowed')
  }

  if (segments[1] === 'migrate') {
    if (segments[2] === 'legacy' && method === 'POST') {
      const bytes = await bodyBytes(init)
      const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
      if (isZip) {
        // 浏览器备份 ZIP 走 browserBackup 的还原逻辑；动态导入避免模块循环。
        const { importAllData } = await import('./browserBackup.js')
        await importAllData(arrayBufferOf(bytes))
      } else {
        // 简化：SQLite 快照在纯浏览器里无法 ATTACH 解析，只标记已处理，保证迁移流程不卡住。
        // 需要还原旧数据时先导出为浏览器备份 ZIP，再走上面的分支。
        // eslint-disable-next-line no-console
        console.warn('[browser-backend] 无法在浏览器内解析 SQLite 快照，已跳过 legacy 导入')
      }
      await db.put('meta', { key: 'legacy_imported', value: '1' })
      return json({ ok: true, ...(await stats(db)) })
    }
    if (segments[2] === 'records' && method === 'POST') {
      const body = await bodyJson(init)
      const sessions = Array.isArray(body.sessions) ? (body.sessions as Session[]) : []
      const memories = Array.isArray(body.memories) ? (body.memories as MemoryEntry[]) : []
      for (const session of sessions) {
        await putSessionRow(db, session, false)
      }
      for (const entry of memories) {
        await writeMemory(db, entry)
      }
      await db.put('meta', { key: 'legacy_imported', value: '1' })
      return json({ ok: true, ...(await stats(db)) })
    }
    if (segments[2] === 'status' && method === 'GET') {
      const meta = await db.get('meta', 'legacy_imported')
      return json({ imported: meta?.value === '1', ...(await stats(db)) })
    }
  }

  return fail(404, 'not found')
}

/**
 * 浏览器存储的请求入口，签名与 localServer.ts 的内部 request() 一致。
 * 闸口把 /api/* 的请求转到这里即可，业务层（chat/db.ts、memory/db.ts 等）无需修改。
 */
export const handleBrowserRequest = async (path: string, init?: RequestInit): Promise<Response> => {
  try {
    return await route(path, init)
  } catch (error) {
    const status = error instanceof BrowserBackendError ? error.status : 500
    return fail(status, error instanceof Error ? error.message : String(error))
  }
}
