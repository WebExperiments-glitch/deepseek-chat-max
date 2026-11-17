/**
 * 本地 Node 服务的 HTTP 客户端。
 *
 * 开发时 Rspack 把 /api 代理到 127.0.0.1:8787；生产时同一个进程同时托管页面和 API。
 * 浏览器不再直接持有 SQLite，只通过这层访问本机数据库。
 */

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
  const response = await fetch(path, init)
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
