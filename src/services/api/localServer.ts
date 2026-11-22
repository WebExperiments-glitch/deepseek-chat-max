/**
 * 本地 Node 服务的 HTTP 客户端。
 *
 * 开发时 Rspack 把 /api 代理到 127.0.0.1:8787；生产时同一个进程同时托管页面和 API。
 * 浏览器不再直接持有 SQLite，只通过这层访问本机数据库。
 */
import { http } from '../../ports/http.js'

export class LocalServerError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'LocalServerError'
  }
}

const request = async (path: string, init?: RequestInit): Promise<Response> => {
  const response = await http(path, init)
  if (!response.ok) {
    let message = response.statusText
    try {
      const body: unknown = await response.json()
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
        message = body.error
      }
    } catch {
      // 响应不是 JSON 时沿用 HTTP 状态文案
    }
    throw new LocalServerError(message || 'local server error', response.status)
  }
  return response
}

const jsonHeaders = { 'content-type': 'application/json' }

export const getJson = async <T>(path: string): Promise<T> =>
  (await request(path)).json() as Promise<T>

export const getJsonOptional = async <T>(path: string): Promise<T | undefined> => {
  try {
    return await getJson<T>(path)
  } catch (error) {
    if (error instanceof LocalServerError && error.status === 404) {
      return undefined
    }
    throw error
  }
}

export const putJson = async <T>(path: string, body: unknown): Promise<T> =>
  (
    await request(path, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    })
  ).json() as Promise<T>

export const postJson = async <T>(path: string, body: unknown): Promise<T> =>
  (
    await request(path, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    })
  ).json() as Promise<T>

export const patchJson = async <T>(path: string, body: unknown): Promise<T> =>
  (
    await request(path, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    })
  ).json() as Promise<T>

export const deleteJson = async <T>(path: string): Promise<T> =>
  (await request(path, { method: 'DELETE' })).json() as Promise<T>

export const putBlob = async (path: string, blob: Blob): Promise<void> => {
  await request(path, {
    method: 'POST',
    headers: { 'x-mime-type': blob.type || 'application/octet-stream' },
    body: blob,
  })
}

export type BlobFile = { id: string; mimeType: string; blob: Blob }

/**
 * 一次 POST 上传多个原件，避免逐张 HTTP 往返。
 * 采用紧凑二进制帧（每条：3 个小端 u32 = id/mime/data 长度，紧随三段原始字节），
 * 不使用 base64，因此对图片零膨胀。编码规则与 server/index.mjs 的 parseFileBatch 对应。
 */
export const postFilesBatch = async (path: string, files: BlobFile[]): Promise<void> => {
  const encoder = new TextEncoder()
  const parts = await Promise.all(
    files.map(async (file) => ({
      id: encoder.encode(file.id),
      mime: encoder.encode(file.mimeType),
      data: new Uint8Array(await file.blob.arrayBuffer()),
    }))
  )
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
    offset += 4
    view.setUint32(offset, part.mime.length, true)
    offset += 4
    view.setUint32(offset, part.data.length, true)
    offset += 4
    output.set(part.id, offset)
    offset += part.id.length
    output.set(part.mime, offset)
    offset += part.mime.length
    output.set(part.data, offset)
    offset += part.data.length
  }
  await request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Blob([buffer]),
  })
}

export const getBlob = async (path: string): Promise<Blob | undefined> => {
  try {
    return await (await request(path)).blob()
  } catch (error) {
    if (error instanceof LocalServerError && error.status === 404) {
      return undefined
    }
    throw error
  }
}

export const postRaw = async (path: string, bytes: Uint8Array): Promise<void> => {
  // TS 7 的 BlobPart 要求 ArrayBuffer 而不是 SharedArrayBuffer 视图，复制一份确保类型收窄
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  await request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Blob([buffer]),
  })
}
