/**
 * 错误「机器层」（Problem）—— 稳定机器码归机器，人话归 UI。
 *
 * 借鉴 Microsoft Graph / RFC 9457 的约定：
 * - code 是稳定的机器标识，UI/代码只依赖它，不随语言或文案变化；
 * - raw 是服务端原文，**仅用于诊断、日志与分类关键词**，绝不直接展示给用户；
 * - 中文安抚文案在 UI 层（services/chat/describe.ts）按 group/code 投影。
 *
 * 这一层是纯函数、零依赖（除 ApiError 类型），可穷尽测试，也是「闸门系统」的单一真相源：
 * 新增错误码时 Record<ApiProblemCode, ApiProblemGroup> 会强制你归类，不会漏。
 */
import { ApiError } from './client.js'

/** 稳定机器码：传输层与 UI 之间唯一的错误契约 */
export type ApiProblemCode =
  | 'context_overflow' // 400/422 + 超长关键词：对话装不下
  | 'payload_too_large' // 413：文件过大
  | 'auth_failed' // 401：密钥错误
  | 'insufficient_balance' // 402：余额不足
  | 'timeout' // 408：上传/请求过慢
  | 'rate_limited' // 429：限流
  | 'server_busy' // 503：负载过高
  | 'gateway_timeout' // 504：网关超时
  | 'server_error' // 500：服务器内部故障
  | 'invalid_request' // 400(格式)/422(其它)：请求不合法
  | 'network' // 断网
  | 'cors' // 跨域被拦
  | 'protocol' // 响应不符合协议
  | 'unknown' // 兜底

/**
 * 四类归因 —— 用户不需要认识十几个 HTTP 码，只需要知道「现在该谁动手」。
 * connection 是我们端特有的连接类（断网/CORS），单独成组便于给连接提示。
 */
export type ApiProblemGroup =
  | 'content' // 内容装不下：整理/换模型/减小文件
  | 'account' // 账户要处理：检查 Key/充值
  | 'crowded' // 只是有点挤：后台自动重试
  | 'ours' // 我们这边出了状况：记录+重试/反馈
  | 'connection' // 连接问题

/** 码 → 归因 的穷尽映射（新增码必须归类，编译期兜底） */
export const CODE_GROUP: Readonly<Record<ApiProblemCode, ApiProblemGroup>> = {
  context_overflow: 'content',
  payload_too_large: 'content',
  auth_failed: 'account',
  insufficient_balance: 'account',
  timeout: 'crowded',
  rate_limited: 'crowded',
  server_busy: 'crowded',
  gateway_timeout: 'crowded',
  server_error: 'ours',
  invalid_request: 'ours',
  network: 'connection',
  cors: 'connection',
  protocol: 'ours',
  unknown: 'ours',
}

export type ApiProblem = {
  code: ApiProblemCode
  group: ApiProblemGroup
  /** 服务端原文，仅诊断用，禁止直接展示 */
  raw: string
  status?: number
}

/** 超长识别（各家文案不同）；与 errors.ts 共用同一份，避免两处漂移 */
export const CONTEXT_OVERFLOW_PATTERNS: ReadonlyArray<RegExp> = [
  /context[_ -]?length[_ -]?exceeded/i,
  /(maximum|max)\s+context\s+(length|window)/i,
  /exceeds?\s+(the\s+)?context\s+(length|window|limit)/i,
  /context[_ -]?window[_ -]?exceeded/i,
  /(input|request|prompt)\s+(is\s+)?too\s+long/i,
  /too\s+many\s+tokens/i,
  /token\s+(limit|count)\s+exceeded/i,
]

export const isContextOverflowMessage = (message: string): boolean =>
  CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))

/** 由 HTTP 状态码 + 服务端原文推导机器码（原文只用于超长关键词识别） */
export const codeFromStatus = (status: number, message: string): ApiProblemCode => {
  if (status === 401) {
    return 'auth_failed'
  }
  if (status === 402) {
    return 'insufficient_balance'
  }
  if (status === 413) {
    return 'payload_too_large'
  }
  if (status === 408) {
    return 'timeout'
  }
  if (status === 429) {
    return 'rate_limited'
  }
  if (status === 503) {
    return 'server_busy'
  }
  if (status === 504) {
    return 'gateway_timeout'
  }
  if (status === 500) {
    return 'server_error'
  }
  if (status === 400 || status === 422) {
    return isContextOverflowMessage(message) ? 'context_overflow' : 'invalid_request'
  }
  if (status >= 500) {
    return 'server_error'
  }
  return 'unknown'
}

/** 把任意失败归一成结构化 Problem —— UI 与闸门逻辑只认它 */
export const toProblem = (error: unknown): ApiProblem => {
  if (error instanceof ApiError) {
    let code: ApiProblemCode
    if (error.kind === 'cors') {
      code = 'cors'
    } else if (error.kind === 'network') {
      code = 'network'
    } else if (error.kind === 'protocol') {
      code = 'protocol'
    } else if (error.status !== undefined) {
      code = codeFromStatus(error.status, error.message)
    } else {
      code = 'unknown'
    }
    return { code, group: CODE_GROUP[code], raw: error.message, status: error.status }
  }
  // 兼容持久化在历史消息里的结构化错误（反序列化后不再是 ApiError 实例，字段一致）
  if (error && typeof error === 'object' && 'message' in error) {
    const e = error as { kind?: string; message?: unknown; status?: number }
    const message = typeof e.message === 'string' ? e.message : ''
    let code: ApiProblemCode
    if (e.kind === 'cors') {
      code = 'cors'
    } else if (e.kind === 'network') {
      code = 'network'
    } else if (e.kind === 'protocol') {
      code = 'protocol'
    } else if (e.status !== undefined) {
      code = codeFromStatus(e.status, message)
    } else {
      code = 'unknown'
    }
    return { code, group: CODE_GROUP[code], raw: message, status: e.status }
  }
  return {
    code: 'unknown',
    group: 'ours',
    raw: error instanceof Error ? error.message : String(error),
  }
}

/**
 * 闸门：是否值得后台指数退避自动重试 1–2 次。
 * 只对「有点挤」和连接抖动开放；账户/内容/参数类重试无用，绝不重试。
 */
export const isAutoRetryable = (problem: ApiProblem): boolean =>
  problem.group === 'crowded' || problem.group === 'connection'

/** 闸门：内容类（装不下）需要算可用余量并给整理/换模型动作 */
export const isContentProblem = (problem: ApiProblem): boolean => problem.group === 'content'
