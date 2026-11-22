import { deleteJson, getJson, postJson } from './api/localServer.js'
import { platform } from '../ports/platform.js'

/** 分享快照里的一条消息；只保留展示所需字段，不包含分支与请求参数 */
export type ShareMessage = {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  content?: string
  text?: string
  files?: { id: string; name: string; size: number; isImage: boolean }[]
}

export type ShareMeta = {
  id: string
  sessionId: string
  title: string
  createdAt: number
  count: number
}

export type Share = Omit<ShareMeta, 'count'> & {
  messages: ShareMessage[]
}

export const createShare = (sessionId: string, messageIds: string[]) =>
  postJson<ShareMeta>('/api/shares', { sessionId, messageIds })

export const listShares = async (): Promise<ShareMeta[]> => {
  const body = await getJson<{ shares: ShareMeta[] }>('/api/shares')
  return Array.isArray(body.shares) ? body.shares : []
}

export const getShare = (id: string) => getJson<Share>(`/api/shares/${encodeURIComponent(id)}`)

export const deleteShare = (id: string) =>
  deleteJson<{ ok: true }>(`/api/shares/${encodeURIComponent(id)}`)

export const shareLink = (id: string) => `${platform().locationOrigin()}/share/${id}`
