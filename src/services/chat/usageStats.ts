import { create } from 'zustand'
import type { ModelOption } from '../api/client.js'
import type { MessageUsage } from '../api/types.js'
import type { AssistantMessage, Session } from './types.js'
import { readStorage, writeStorage } from '../platform/storage.js'

/**
 * 上下文占用与用量统计。
 *
 * - 只认服务端上报的数值：prompt 体量 = 未命中输入 + 缓存读取 + 缓存写入，
 *   不再按字符估算，避免和实际计费口径不一致。
 * - 缓存命中率沿用「部分命中不能四舍五入成 100%」的规则：命中率再高，
 *   只要还有未命中的 token，就显示成 99.x% 或 >99.9%，不会出现假的 100%。
 * - 上下文窗口优先取服务商模型清单里的 context_window；清单没有给、
 *   但模型属于已知 DeepSeek 系列时用官方窗口；两者都没有时返回 null，
 *   界面只显示绝对 token 数，不猜百分比。
 */

/** DeepSeek 官方模型清单给出的窗口与最大输出 */
const DEEPSEEK_CONTEXT_WINDOW = 1_048_576

/** 清单与兜底表都没有时使用的窗口；只用于已知 DeepSeek 模型 */
const KNOWN_WINDOWS: Record<string, number> = {
  // 文档与 /models 都只列出这两个模型；旧名字不再兜底，未知就是未知
  'deepseek-flash': DEEPSEEK_CONTEXT_WINDOW,
  'deepseek-v4-pro': DEEPSEEK_CONTEXT_WINDOW,
}

const CACHE_KEY = 'chat-demo:context-usage'
/** 只保留最近 200 个会话，避免键无限增长 */
const MAX_ENTRIES = 200

export type ContextUsage = { tokens: number; at: number; model?: string }

type ContextState = { byId: Record<string, ContextUsage> }

const readCache = (): Record<string, ContextUsage> => {
  try {
    const raw = readStorage(CACHE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    const result: Record<string, ContextUsage> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<ContextUsage> | null
      if (typeof entry?.tokens === 'number' && typeof entry.at === 'number') {
        result[id] =
          typeof entry.model === 'string'
            ? { tokens: entry.tokens, at: entry.at, model: entry.model }
            : { tokens: entry.tokens, at: entry.at }
      }
    }
    return result
  } catch {
    return {}
  }
}

const writeCache = (byId: Record<string, ContextUsage>) => {
  try {
    const entries = Object.entries(byId).sort((a, b) => b[1].at - a[1].at)
    writeStorage(
      CACHE_KEY,
      JSON.stringify(Object.fromEntries(entries.slice(0, MAX_ENTRIES)))
    )
  } catch {
    // 隐私模式下写不进去也不影响本次显示
  }
}

export const useContextUsage = create<ContextState>(() => ({ byId: readCache() }))

/** 一次请求真正发出去的 prompt 体量（含命中缓存的部分） */
export const promptTokensOf = (usage: MessageUsage): number =>
  (usage.input_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0) +
  (usage.cache_creation_input_tokens ?? 0)

/**
 * 记下会话最近一次请求的上下文体量；同一会话只保留最新值。
 * model 一并保存：切换模型后仍按发请求时的模型解释这个数字。
 */
export const noteContextUsage = (
  sessionId: string,
  usage: MessageUsage | undefined,
  model?: string | null
) => {
  if (!usage) {
    return
  }
  const tokens = promptTokensOf(usage)
  if (tokens <= 0) {
    return
  }
  const previous = useContextUsage.getState().byId[sessionId]
  const usedModel = model ?? previous?.model
  if (previous && previous.tokens === tokens && previous.model === usedModel) {
    return
  }
  const next: ContextUsage = { tokens, at: Date.now() }
  if (usedModel) {
    next.model = usedModel
  }
  const byId = { ...useContextUsage.getState().byId, [sessionId]: next }
  useContextUsage.setState({ byId })
  writeCache(byId)
}

/** 清掉会话的上下文记录（删除会话时调用） */
export const forgetContextUsage = (sessionId: string) => {
  const byId = Object.fromEntries(
    Object.entries(useContextUsage.getState().byId).filter(([id]) => id !== sessionId)
  )
  useContextUsage.setState({ byId })
  writeCache(byId)
}

/** 清空全部上下文记录（替换或清空历史时调用） */
export const clearAllContextUsage = () => {
  useContextUsage.setState({ byId: {} })
  writeCache({})
}

/** 模型清单给出的窗口；没有时回落到已知 DeepSeek 窗口，仍未命中返回 null */
export const resolveContextWindow = (model: string, listed?: number): number | null =>
  listed && listed > 0 ? listed : (KNOWN_WINDOWS[model] ?? null)

/**
 * 在所有服务商的模型清单里按 id 找窗口。
 * 会话记录的是发请求时的模型，切换服务商或模型后仍要用当时的口径解释历史用量。
 */
export const findContextWindow = (
  lists: Record<string, ModelOption[]>,
  model: string
): number | null => {
  for (const options of Object.values(lists)) {
    const option = options.find((item) => item.id === model)
    if (option?.contextWindow) {
      return option.contextWindow
    }
  }
  return null
}

export type SessionUsageTotals = {
  /** 用户提问轮数 */
  rounds: number
  /** 模型回复条数（含分支里未选中的版本） */
  replies: number
  inputUncached: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** 其中的思考 token（已含在 output 里） */
  thinking: number
  /** 其中的安全审核 token（已含在 output 里） */
  safety: number
  /** prompt 总量：未命中 + 命中读取 + 缓存写入 */
  prompt: number
  /** 缓存读取占 prompt 的比例；没有 prompt 时为 null */
  cacheRate: number | null
  /** 服务端上报的搜索请求数 */
  searchRequests: number
  /** 客户端能看到的链接阅读次数 */
  readRequests: number
}

const emptyTotals = (): SessionUsageTotals => ({
  rounds: 0,
  replies: 0,
  inputUncached: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  thinking: 0,
  safety: 0,
  prompt: 0,
  cacheRate: null,
  searchRequests: 0,
  readRequests: 0,
})

/** 汇总一个会话的用量；没有上报过用量的历史消息不参与统计 */
export const aggregateSessionUsage = (session: Session | null): SessionUsageTotals => {
  const totals = emptyTotals()
  if (!session) {
    return totals
  }
  for (const message of session.messages) {
    if (message.role === 'user') {
      totals.rounds += 1
      continue
    }
    if (message.role !== 'assistant') {
      continue
    }
    const reply = message as AssistantMessage
    totals.replies += 1
    const usage = reply.usage
    if (usage) {
      totals.inputUncached += usage.input_tokens ?? 0
      totals.cacheRead += usage.cache_read_input_tokens ?? 0
      totals.cacheWrite += usage.cache_creation_input_tokens ?? 0
      totals.output += usage.output_tokens ?? 0
      totals.thinking += usage.output_tokens_details?.thinking_tokens ?? 0
      totals.safety += usage.output_tokens_details?.safety_tokens ?? 0
      // 计费口径优先用 tool_search；没有时退回展示用的 web_search_requests
      totals.searchRequests +=
        usage.server_tool_use?.tool_search ?? usage.server_tool_use?.web_search_requests ?? 0
    }
    totals.readRequests += reply.blocks.filter(
      (block) => block.type === 'server_tool_use' && block.name === 'deepseek_read_url'
    ).length
  }
  totals.prompt = totals.inputUncached + totals.cacheRead + totals.cacheWrite
  totals.cacheRate = totals.prompt > 0 ? totals.cacheRead / totals.prompt : null
  return totals
}

/** 紧凑 token 数：517 / 12.8k / 517k / 1.2M */
export const formatTokens = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`
  }
  if (value >= 100_000) {
    return `${Math.round(value / 1000)}k`
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1000)}k`
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`
  }
  return String(Math.round(value))
}

/**
 * 缓存命中率。
 *
 * 完全命中返回 100；部分命中时最多显示一位小数，若一位小数会四舍五入成 100，
 * 则退到两位小数，再退到 >99.9%，确保「10 个 token 里有 1 个没命中」不会被显示成 100%。
 */
export const formatCacheHitPercent = (
  cacheRead: number,
  prompt: number,
  decimalPlaces: 0 | 1 = 0
): string | null => {
  if (prompt <= 0) {
    return null
  }
  if (cacheRead >= prompt) {
    return '100'
  }
  const oneDecimal = ((cacheRead / prompt) * 100).toFixed(1)
  if (decimalPlaces === 0) {
    const whole = Math.round((cacheRead / prompt) * 100)
    return whole >= 100 ? oneDecimal : String(whole)
  }
  if (Number(oneDecimal) < 99.95) {
    return oneDecimal
  }
  const twoDecimals = ((cacheRead / prompt) * 100).toFixed(2)
  return twoDecimals === '100.00' ? '>99.99' : twoDecimals
}

/** 按百分比取整数显示；窗口未知时返回 null */
export const contextPercent = (tokens: number, window: number | null): number | null =>
  window && window > 0 ? Math.min(100, (tokens / window) * 100) : null
