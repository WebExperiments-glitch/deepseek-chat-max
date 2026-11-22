import { ApiError, request } from './client.js'
import { DEEPSEEK_ORIGIN, DEEPSEEK_ANTHROPIC_BASE_URL } from './providers.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'

/**
 * 联网检索的两种形态：
 *
 * 1. 独立工具 API（Search / Fetch）：POST /v1/tools/search、/v1/tools/fetch。
 *    Bearer 鉴权，返回结构化 JSON。用于「自己的程序直接搜索抓取」。
 * 2. 预检检索 digestForQuestion：用独立 Search API 查一遍，把结果摘编成可注入
 *    上下文的文本。OpenAI 兼容服务商没有 DeepSeek 的服务端搜索工具，靠它补上联网能力。
 *
 * 检索失败不阻断主请求，由调用方吞掉并降级为无搜索结果。
 */

/** Search API 单条结果（只取我们展示与注入需要的字段） */
export type WebSearchItem = {
  url: string
  title: string
  snippet: string
  content: string
  siteName: string | null
  publishedAt: string | null
  /** 排序分 0–3，≥1.5 为优质 */
  rerankScore?: number
  /** 权威度 -1 到 4，≥3 为极权威 */
  authority?: number
}

type SearchResponse = {
  results?: {
    url?: string
    title?: string
    snippet?: string
    summary?: string
    content?: string
    site_name?: string | null
    date?: string | null
    rerank_score?: number
    authority?: number
  }[]
}

/** 直接调用独立 Search API：POST /v1/tools/search */
export const searchWeb = async (
  apiKey: string,
  query: string,
  options: { count?: number; needContent?: boolean } = {},
  signal?: AbortSignal
): Promise<WebSearchItem[]> => {
  const response = await request(`${DEEPSEEK_ORIGIN}/v1/tools/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      count: Math.min(50, Math.max(1, options.count ?? 10)),
      need_content: options.needContent === true,
    }),
    signal,
  })
  const body = (await response.json()) as SearchResponse
  return (body.results ?? [])
    .filter((item) => typeof item.url === 'string' && item.url !== '')
    .map((item) => ({
      url: item.url as string,
      title: item.title ?? '',
      snippet: item.snippet ?? item.summary ?? '',
      content: item.content ?? '',
      siteName: item.site_name ?? null,
      publishedAt: item.date ?? null,
      rerankScore: item.rerank_score,
      authority: item.authority,
    }))
}

/** 直接调用独立 Fetch API：POST /v1/tools/fetch，返回网页标题与 Markdown 正文 */
export const fetchUrl = async (
  apiKey: string,
  url: string,
  signal?: AbortSignal
): Promise<{ title: string; content: string }> => {
  const response = await request(`${DEEPSEEK_ORIGIN}/v1/tools/fetch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  })
  const body = (await response.json()) as { title?: string; content?: string }
  return { title: body.title ?? '', content: body.content ?? '' }
}

/** 一次预检检索的结果 */
export type SearchDigest = {
  /** 可直接注入上下文的摘编文本 */
  text: string
  /** 检索到的来源，用于界面展示 */
  sources: { url: string; title: string }[]
}

/** 摘编超过这个长度就截断，避免挤占主请求的上下文 */
const MAX_DIGEST_CHARS = 6000

/**
 * 用独立 Search API 做一次联网检索并返回摘编；失败时抛出 ApiError，由调用方吞掉并降级。
 * need_content=true 让 Search 直接返回网页正文，省去逐条 Fetch 的额外请求。
 */
export const digestForQuestion = async (
  apiKey: string,
  question: string,
  signal: AbortSignal
): Promise<SearchDigest> => {
  const items = await searchWeb(apiKey, question, { count: 5, needContent: true }, signal)
  if (items.length === 0) {
    throw new ApiError('protocol', '')
  }
  const lines = items.map((item, index) => {
    const body = item.content || item.snippet
    const head = `[${index + 1}] ${item.title || item.url}\nURL: ${item.url}`
    return body ? `${head}\n${body}` : head
  })
  const text = lines.join('\n\n').slice(0, MAX_DIGEST_CHARS)
  return {
    text,
    sources: items.map((item) => ({ url: item.url, title: item.title })),
  }
}

/** 摘编的来源标记，用于构造注入前缀 */
export const SEARCH_DIGEST_LABEL = '以下是联网搜索到的公开资料，仅供参考，注意甄别时效与准确性：'

const SEARCH_SYSTEM_PROMPT =
  '你是检索助手。请使用联网搜索工具查找与问题相关的公开资料，用简洁的中文（或与问题相同的语言）列出要点：' +
  '每条要点后附上来源 URL。不要编造，找不到相关内容时直接说明未找到。'

/**
 * 旧版预检检索：用一次带 deepseek_web_search 的 Messages 请求做摘编。
 * 保留给可能的历史调用方；新版请用 digestForQuestion（独立 API，更省）。
 */
export const digestWebSearch = async (
  deepseekApiKey: string,
  question: string,
  model: string,
  signal: AbortSignal
): Promise<SearchDigest> => {
  const response = await request(`${DEEPSEEK_ANTHROPIC_BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': deepseekApiKey,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      system: SEARCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question }],
      thinking: { type: 'disabled' },
      safety_check: { level: 'high' },
      tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
      stream: true,
    }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw new ApiError('protocol', await response.text().catch(() => ''))
  }
  let text = ''
  const sources: { url: string; title: string }[] = []
  const seen = new Set<string>()
  for await (const { data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block.type === 'web_search_tool_result') {
        for (const item of block.content) {
          if (item.type === 'web_search_result' && !seen.has(item.url)) {
            seen.add(item.url)
            sources.push({ url: item.url, title: item.title })
          }
        }
      }
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    } else if (event.type === 'message_stop') {
      break
    }
  }
  const trimmed = text.trim().slice(0, MAX_DIGEST_CHARS)
  if (!trimmed && sources.length === 0) {
    throw new ApiError('protocol', '')
  }
  const body =
    trimmed ||
    sources.map((source) => `- ${source.title || source.url}: ${source.url}`).join('\n')
  return { text: body, sources }
}
