/**
 * 联网搜索商注册表（可插拔：用户下拉选哪家搜索商）。
 *
 * 两种形态：
 * - server-tool：由模型服务商在流式响应里原生调用（DeepSeek 边想边搜），客户端只声明工具；
 * - standalone：客户端先调独立 Search/Fetch API 做预检摘编，注入本轮上下文。
 *
 * 第三方搜索商（Tavily/Serper/Brave）经本地代理转发（绕过 CORS），Key 单独存。
 * 纯 TS 注册表 + 工厂，与 UI 解耦；统一 WebSearchItem 归一化，调用方无需关心各家格式。
 */
import type { WebSearchItem } from './api/webSearch.js'

export type SearchProviderKind = 'server-tool' | 'standalone'

export type SearchProvider = {
  id: string
  name: string
  kind: SearchProviderKind
  /** 是否需要用户填 Key（server-tool 用对话服务商的 Key，standalone 用独立 Key） */
  needsKey: boolean
  /** 独立 Key 用哪个本地代理前缀（空表示直连其 apiBase） */
  proxyPrefix?: string
  apiBase: string
  /** 执行搜索；server-tool 类不需要实现 */
  search?: (
    key: string,
    query: string,
    options: { count?: number; needContent?: boolean },
    signal?: AbortSignal
  ) => Promise<WebSearchItem[]>
  /** 读取网页正文；缺省时用搜索结果自带 content */
  fetchUrl?: (key: string, url: string, signal?: AbortSignal) => Promise<{ title: string; content: string }>
}

/** 递归取字符串字段（不同 API 的 title/url 字段名不同） */
const pick = (obj: unknown, keys: string[]): string => {
  if (obj === null || typeof obj !== 'object') {
    return ''
  }
  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key]
    if (typeof value === 'string' && value) {
      return value
    }
  }
  return ''
}

const normalize = (items: unknown[], fields: {
  url: string[]; title: string[]; snippet: string[]; content?: string[]; site?: string[]; date?: string[]
}): WebSearchItem[] =>
  items.flatMap((item) => {
    if (item === null || typeof item !== 'object') {
      return []
    }
    const url = pick(item, fields.url)
    if (!url) {
      return []
    }
    return [{
      url,
      title: pick(item, fields.title) || url,
      snippet: pick(item, fields.snippet),
      content: fields.content ? pick(item, fields.content) : '',
      siteName: fields.site ? pick(item, fields.site) || null : null,
      publishedAt: fields.date ? pick(item, fields.date) || null : null,
    }]
  })

/** DeepSeek 独立搜索 API（现有实现） */
const deepseekSearch = async (
  key: string, query: string, options: { count?: number; needContent?: boolean }, signal?: AbortSignal
): Promise<WebSearchItem[]> => {
  const { searchWeb } = await import('./api/webSearch.js')
  return searchWeb(key, query, options, signal)
}
const deepseekFetch = async (key: string, url: string, signal?: AbortSignal) => {
  const { fetchUrl } = await import('./api/webSearch.js')
  return fetchUrl(key, url, signal)
}

/** 调独立 API 并归一化（Tavily / Serper / Brave 走本地代理） */
const genericSearch = (
  base: string,
  build: (key: string, query: string, count: number) => { url: string; init: RequestInit }
) => async (key: string, query: string, options: { count?: number }, signal?: AbortSignal): Promise<WebSearchItem[]> => {
    const { url, init } = build(key, query, Math.min(10, Math.max(1, options.count ?? 5)))
    const response = await fetch(url, { ...init, signal })
    if (!response.ok) {
      throw new Error(`${base} ${response.status}`)
    }
    const body = await response.json()
    if (base === 'tavily') {
      return normalize((body.results ?? []) as unknown[], {
        url: ['url'], title: ['title'], snippet: ['content', 'snippet'], content: ['content'], site: ['source'], date: ['published_date'],
      })
    }
    // Serper / Brave: organic 结果
    const organic = body.organic ?? body.web?.results ?? []
    return normalize(organic as unknown[], {
      url: ['link', 'url'], title: ['title'], snippet: ['snippet', 'description'], site: ['source'], date: ['date'],
    })
  }

const proxied = (prefix: string, target: string) => `/provider/${prefix}${target.replace(/^https?:\/\/[^/]+/, '')}`

export const SEARCH_PROVIDERS: SearchProvider[] = [
  {
    id: 'deepseek-tools',
    name: 'DeepSeek 边想边搜',
    kind: 'server-tool',
    needsKey: false,
    apiBase: '',
  },
  {
    id: 'deepseek-api',
    name: 'DeepSeek 检索 API',
    kind: 'standalone',
    needsKey: true,
    apiBase: 'https://api.deepseek.com/v1/tools',
    search: deepseekSearch,
    fetchUrl: deepseekFetch,
  },
  {
    id: 'tavily',
    name: 'Tavily',
    kind: 'standalone',
    needsKey: true,
    proxyPrefix: 'search-tavily',
    apiBase: 'https://api.tavily.com',
    search: genericSearch('tavily', (key, query, count) => ({
      url: proxied('search-tavily', 'https://api.tavily.com/search'),
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, query, max_results: count, topic: 'general' }),
      },
    })),
  },
  {
    id: 'serper',
    name: 'Serper (Google)',
    kind: 'standalone',
    needsKey: true,
    proxyPrefix: 'search-serper',
    apiBase: 'https://google.serper.dev',
    search: genericSearch('serper', (key, query, count) => ({
      url: proxied('search-serper', 'https://google.serper.dev/search'),
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
        body: JSON.stringify({ q: query, num: count }),
      },
    })),
  },
  {
    id: 'brave',
    name: 'Brave Search',
    kind: 'standalone',
    needsKey: true,
    proxyPrefix: 'search-brave',
    apiBase: 'https://api.search.brave.com',
    search: genericSearch('brave', (key, query, count) => ({
      url: proxied('search-brave', 'https://api.search.brave.com/res/v1/web/search'),
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Subscription-Token': key },
        body: JSON.stringify({ q: query, count }),
      },
    })),
  },
]

export const SEARCH_PROVIDER_IDS = SEARCH_PROVIDERS.map((p) => p.id)

export const getSearchProvider = (id: string): SearchProvider =>
  SEARCH_PROVIDERS.find((p) => p.id === id) ?? SEARCH_PROVIDERS[0]

const MAX_DIGEST_CHARS = 6000

/** 用指定搜索商做一次预检检索并返回可注入上下文的摘编（纯函数式，失败抛出由调用方吞掉） */
export const digestWithProvider = async (
  provider: SearchProvider,
  key: string,
  question: string,
  signal: AbortSignal
): Promise<{ text: string; sources: { url: string; title: string }[] }> => {
  if (!provider.search) {
    throw new Error('provider has no search implementation')
  }
  const items = await provider.search(key, question, { count: 5, needContent: true }, signal)
  if (items.length === 0) {
    throw new Error('no results')
  }
  const lines = await Promise.all(items.map(async (item, index) => {
    // needContent 已带正文则直接用；否则需要逐条 fetchUrl
    let body = item.content || item.snippet
    if (!item.content && provider.fetchUrl) {
      try {
        const page = await provider.fetchUrl(key, item.url, signal)
        body = page.content || body
      } catch {
        // 单页抓取失败用摘要
      }
    }
    const head = `[${index + 1}] ${item.title || item.url}\nURL: ${item.url}`
    return body ? `${head}\n${body}` : head
  }))
  return {
    text: lines.join('\n\n').slice(0, MAX_DIGEST_CHARS),
    sources: items.map((item) => ({ url: item.url, title: item.title })),
  }
}
