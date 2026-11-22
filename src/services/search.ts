import { getJson } from './api/localServer.js'

/** 一条全文搜索命中；摘要已按命中位置切成三段，避免在客户端注入 HTML */
export type ChatSearchResult = {
  sessionId: string
  messageId: string
  role: 'user' | 'assistant'
  title: string
  updatedAt: number
  before: string
  match: string
  after: string
}

type SearchResponse = {
  results: ChatSearchResult[]
}

export const searchChats = async (query: string, limit = 30): Promise<ChatSearchResult[]> => {
  const keyword = query.trim()
  if (!keyword) {
    return []
  }
  const params = new URLSearchParams({ q: keyword, limit: String(limit) })
  const body = await getJson<SearchResponse>(`/api/search?${params.toString()}`)
  return Array.isArray(body.results) ? body.results : []
}
