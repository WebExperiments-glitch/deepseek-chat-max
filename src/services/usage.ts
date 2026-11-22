import { DEEPSEEK_ANTHROPIC_BASE_URL } from './api/providers.js'
import { getJson } from './api/localServer.js'

export type UsageSession = {
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
}

export type UsageSummary = {
  totals: {
    requests: number
    inputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    outputTokens: number
    promptTokens: number
    cacheHitRate: number
  }
  sessions: UsageSession[]
}

export const loadUsage = (): Promise<UsageSummary> => getJson<UsageSummary>('/api/usage')

/** 单次缓存探针的用量 */
export type CacheProbeUsage = {
  status: number
  ms: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  error?: string
}

export type CacheProbeResult = {
  prefixChars: number
  first: CacheProbeUsage
  second: CacheProbeUsage
  cached: boolean
}

const PROBE_FILLER = '这是一段用于检测提示词缓存的稳定前缀，内容逐字相同。'
const PROBE_WAIT_MS = 5000

type ProbeCall = { usage: CacheProbeUsage; text: string }

const probeOnce = async (apiKey: string, body: string): Promise<ProbeCall> => {
  const started = performance.now()
  const response = await fetch(`${DEEPSEEK_ANTHROPIC_BASE_URL}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body,
  })
  const text = await response.text()
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(text)
    if (value !== null && typeof value === 'object') {
      parsed = value as Record<string, unknown>
    }
  } catch {
    // 失败响应不是 JSON，下面按状态码报错
  }
  const usage =
    parsed.usage !== null && typeof parsed.usage === 'object'
      ? (parsed.usage as Record<string, unknown>)
      : {}
  const num = (value: unknown) => (typeof value === 'number' ? value : 0)
  const blocks = Array.isArray(parsed.content) ? parsed.content : []
  const answer = blocks
    .flatMap((block) => {
      if (block === null || typeof block !== 'object') {
        return []
      }
      const record = block as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string' ? [record.text] : []
    })
    .join('')
  return {
    usage: {
      status: response.status,
      ms: Math.round(performance.now() - started),
      inputTokens: num(usage.input_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
      outputTokens: num(usage.output_tokens),
      ...(response.ok ? {} : { error: text.slice(0, 200) }),
    },
    text: answer,
  }
}

/**
 * 缓存自检，形状与 DSH 的 request-cache e2e 一致：
 * 第一轮发一条长提问；第二轮把「同一提问 + 第一轮回答 + 新提问」追加在后面。
 * 第二轮请求以第一轮为逐字节前缀，理应报告 cache_read > 0。
 * 只用于诊断，不写入会话（约 2K 前缀 + 少量输出）。
 */
export const probeCache = async (apiKey: string): Promise<CacheProbeResult> => {
  const filler = PROBE_FILLER.repeat(80)
  const system = `You are a cache probe. ${filler}`
  const firstQuestion = `${filler}\n\nReply with OK only.`
  const first = await probeOnce(
    apiKey,
    JSON.stringify({
      model: 'deepseek-flash',
      system,
      messages: [{ role: 'user', content: firstQuestion }],
      thinking: { type: 'disabled' },
      max_tokens: 8,
      stream: false,
    })
  )
  await new Promise((resolve) => setTimeout(resolve, PROBE_WAIT_MS))
  const second = await probeOnce(
    apiKey,
    JSON.stringify({
      model: 'deepseek-flash',
      system,
      messages: [
        { role: 'user', content: firstQuestion },
        { role: 'assistant', content: first.text.trim() || 'OK' },
        { role: 'user', content: 'Repeat the single word OK.' },
      ],
      thinking: { type: 'disabled' },
      max_tokens: 8,
      stream: false,
    })
  )
  return {
    prefixChars: system.length + firstQuestion.length,
    first: first.usage,
    second: second.usage,
    cached: second.usage.cacheReadTokens > 0,
  }
}
