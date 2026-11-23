/**
 * 模型可用性探测（「填 Key → 一键检测 → 开聊」闭环）。
 *
 * 策略（成本优先，借鉴行业做法 + DeepSeek 官方 v0.2.1 的「按 Key 可见性」思路）：
 * 1. 先 GET /models —— 大多数服务商（含 DeepSeek）直接返回该 Key 支持的模型，零对话成本。
 *    实测 DeepSeek：`deepseek-flash` / `deepseek-v4-pro`。
 * 2. 只有 /models 不可用、返回空、或明显是全量假清单时，才降级到**小规模并发真实探测**：
 *    对候选模型发 `max_tokens:1` 的极小请求，能回 200 的即可用。并发受限，避免打爆。
 * 3. 遇到鉴权/余额错误立即中止（Key 本身有问题，继续探测无意义）；
 *    unsupported_model 只是「这个候选不行」，继续下一个。
 *
 * 纯 TS，经注入的 http / listModels 访问网络，可单测、与 UI 解耦。
 */
import { listModels, type ModelOption } from './api/client.js'
import { toProblem } from './api/problem.js'
import type { Provider } from './api/providers.js'

export type ProbeSource = 'models-endpoint' | 'probe' | 'empty'

export type ProbeResult = {
  /** 可用模型 id 列表 */
  models: string[]
  /** 结果来源：/models 清单 / 真实探测 / 没找到 */
  source: ProbeSource
  /** 实际探测了多少个候选（/models 成功时为 0） */
  tested: number
  /** 中止原因：鉴权/余额等问题 */
  aborted?: 'auth' | 'balance' | 'cors' | 'network'
}

export type ProbeOptions = {
  /** 候选模型（/models 不可用时探测这些） */
  candidates: string[]
  /** 探测并发上限，默认 4 */
  concurrency?: number
  /** 最多探测多少个候选，默认 24（避免几千请求） */
  limit?: number
  signal?: AbortSignal
  /** 进度回调：已完成数 / 总数 */
  onProgress?: (done: number, total: number) => void
  /** 注入的探测函数（单测用；默认走真实 OpenAI 兼容请求） */
  probeOne?: (model: string, signal?: AbortSignal) => Promise<void>
  /** 注入的清单拉取（单测用；默认走 listModels） */
  listModels?: (provider: Provider, apiKey: string, signal?: AbortSignal) => Promise<ModelOption[]>
}

/** 默认单模型探测：OpenAI 兼容 chat/completions，max_tokens=1，几乎零成本 */
const defaultProbeOne =
  (provider: Provider, apiKey: string) =>
  async (model: string, signal?: AbortSignal): Promise<void> => {
    const { http } = await import('../ports/http.js')
    const url = `${provider.baseURL.replace(/\/+$/, '')}/chat/completions`
    const isAnthropic = provider.protocol === 'anthropic'
    const body = isAnthropic
      ? {
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }
      : {
          model,
          max_tokens: 1,
          stream: false,
          messages: [{ role: 'user', content: 'hi' }],
        }
    const response = await http(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(isAnthropic ? { 'anthropic-version': '2023-06-01' } : {}),
        ...provider.headers,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      // 复用统一错误类型，让 toProblem 能识别 unsupported_model / auth / balance
      const { ApiError } = await import('./api/client.js')
      throw new ApiError('http', text || `HTTP ${response.status}`, response.status)
    }
  }

/** 并发受限地跑一批异步任务，任一任务抛「致命」错误时由调用方决定是否继续 */
async function mapWithConcurrency<T>(
  items: string[],
  limit: number,
  worker: (item: string) => Promise<T>,
  /** 返回 true 时停止派发后续任务（用于鉴权/余额错误的即时中止） */
  shouldStop: (reason: unknown) => boolean = () => false
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(items.length)
  let next = 0
  let stopped = false
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (stopped) {
        return
      }
      const index = next++
      if (index >= items.length) {
        return
      }
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
        if (shouldStop(reason)) {
          stopped = true
        }
      }
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 检测当前 Key 真正能用的模型。
 * 优先 /models（零成本）；拿不到才降级到小规模并发探测。
 */
export const probeAvailableModels = async (
  provider: Provider,
  apiKey: string,
  options: ProbeOptions
): Promise<ProbeResult> => {
  const { candidates, concurrency = 4, limit = 24, signal, onProgress } = options

  // 第一步：尝试 /models（零成本，最准）
  try {
    const listed: ModelOption[] = await (options.listModels ?? listModels)(provider, apiKey, signal)
    if (listed.length > 0) {
      return { models: listed.map((m) => m.id), source: 'models-endpoint', tested: 0 }
    }
  } catch {
    // /models 不可用，走探测
  }

  // 第二步：小规模并发真实探测
  const targets = [...new Set(candidates)].filter(Boolean).slice(0, limit)
  if (targets.length === 0) {
    return { models: [], source: 'empty', tested: 0 }
  }
  const probe = options.probeOne ?? defaultProbeOne(provider, apiKey)
  let done = 0
  onProgress?.(0, targets.length)

  const isFatal = (reason: unknown): boolean => {
    const code = toProblem(reason).code
    return code === 'auth_failed' || code === 'insufficient_balance'
  }
  const settled = await mapWithConcurrency(
    targets,
    concurrency,
    async (model) => {
      try {
        await probe(model, signal)
        return true
      } finally {
        done += 1
        onProgress?.(done, targets.length)
      }
    },
    isFatal
  )

  const models: string[] = []
  let aborted: ProbeResult['aborted']
  for (let i = 0; i < settled.length; i += 1) {
    if (settled[i].status === 'fulfilled') {
      models.push(targets[i])
      continue
    }
    const problem = toProblem((settled[i] as PromiseRejectedResult).reason)
    if (problem.code === 'auth_failed' || problem.code === 'insufficient_balance') {
      aborted = problem.code === 'auth_failed' ? 'auth' : 'balance'
      break
    }
    if (problem.code === 'cors' || problem.code === 'network') {
      aborted = problem.group === 'connection' ? problem.code as 'cors' | 'network' : undefined
    }
    // unsupported_model / rate_limited / server_busy 等：跳过该候选，继续
  }
  return { models, source: 'probe', tested: done, aborted }
}
