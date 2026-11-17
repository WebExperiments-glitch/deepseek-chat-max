import { translate, type TranslationMessage } from '../../i18n/index.js'
import { readMessageEvent } from './parseEvent.js'
import {
  createOpenAiStreamState,
  finishOpenAiStream,
  readOpenAiEvent,
  type OpenAiStreamState,
} from './parseOpenAiEvent.js'
import { DEEPSEEK_ANTHROPIC_BASE_URL, type Provider } from './providers.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__
/** Anthropic 兼容接口的前缀 */
const ANTHROPIC_BASE_URL = DEEPSEEK_ANTHROPIC_BASE_URL
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 服务可达，但响应缺少 CORS 头，浏览器拒绝把结果交给页面 */
  | 'cors'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

/**
 * OpenAI 兼容服务的错误体：`{ error: { message } }`，也有网关返回 `{ error: "..." }`
 * 或 `{ message: "..." }` 的情况。
 */
export const readOpenAiErrorMessage = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const error = (value as { error?: unknown }).error
  if (typeof error === 'string') {
    return error
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) {
      return message
    }
  }
  const message = (value as { message?: unknown }).message
  return typeof message === 'string' && message ? message : null
}

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    } else {
      message = readOpenAiErrorMessage(body) ?? message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

/**
 * 发起请求并把失败统一成 ApiError。
 *
 * 跨域被拦时浏览器只会抛一个笼统的 TypeError（Failed to fetch），与真正断网无法区分。
 * 这里改为先试一次 `mode: 'cors'`，失败再用 `mode: 'no-cors'` 探测一次：
 * 能探到响应说明服务本身可达、只是没给 CORS 头，报 config 让用户看到真正的原因。
 */
export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    if (await isCorsBlocked(url)) {
      throw new ApiError('cors', url)
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

/** no-cors 探测：请求已发出即说明服务可达，跨域被拦是 CORS 问题而不是网络问题 */
const isCorsBlocked = async (url: string): Promise<boolean> => {
  try {
    await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' })
    return true
  } catch {
    return false
  }
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用）；OpenAI 兼容服务同样提供该端点 */
export const verifyApiKey = async (
  provider: Provider,
  apiKey: string,
  signal?: AbortSignal
): Promise<void> => {
  await request(provider.modelsURL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, ...provider.headers },
    signal,
  })
}

/**
 * 模型清单里的一项，字段对齐 GET /models 的模型元数据：
 * context_window、max_output_tokens、input_modalities、effort、api_capabilities。
 * 各网关只实现其中一部分，缺省字段按「未知」处理，不做猜测。
 */
export type ModelOption = {
  /** 发请求时使用的模型 id */
  id: string
  /** 设置里展示的名称；与 id 相同时由界面直接显示 id */
  label: string
  /** 服务商声明的上下文窗口；清单没有给出时为 undefined */
  contextWindow?: number
  /** 单次响应输出上限，也是 max_tokens 可接受的最大值 */
  maxOutputTokens?: number
  /** 支持的输入模态（text / image）；缺省表示未知，不据此禁用功能 */
  inputModalities?: string[]
  /** 开启思考时支持的推理强度档位，不含 none */
  effortLevels?: string[]
  /** 未指定强度时服务端使用的默认档位 */
  defaultEffort?: string
  /** 对话中更新 system 提示词时模型的采用方式 */
  systemPromptUpdate?: 'leading-only' | 'in-history'
}

/** 正整数字段：非数字、非有限值、<=0 都视为未知 */
const positiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined

/** 字符串数组字段：过滤空串；一个有效值都没有时返回 undefined（表示未知） */
const stringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }
  const list = value.filter((item): item is string => typeof item === 'string' && item !== '')
  return list.length > 0 ? list : undefined
}

/**
 * 拉取服务商的模型清单，供设置里的模型下拉使用。
 *
 * 兼容三种常见形状：`{ data: [{ id }] }`、`[{ id }]` 与纯字符串数组。
 * OpenCode 的清单里 id 与展示名分列在 id / name，且部分模型带 canonical_id；
 * 只取面向 chat 的条目（type 缺省或为 chat），并把 name 作为展示名。
 */
export const listModels = async (
  provider: Provider,
  apiKey: string,
  signal?: AbortSignal
): Promise<ModelOption[]> => {
  const response = await request(provider.modelsURL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, ...provider.headers },
    signal,
  })
  const body: unknown = await response.json().catch(() => null)
  const data = Array.isArray(body)
    ? body
    : body !== null && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : []
  const options = data.flatMap((item): ModelOption[] => {
    if (typeof item === 'string') {
      return [{ id: item, label: item }]
    }
    if (item === null || typeof item !== 'object') {
      return []
    }
    const record = item as Record<string, unknown>
    // 非 chat 的条目（如 embedding）不能用于对话
    if (typeof record.type === 'string' && record.type !== 'chat') {
      return []
    }
    const key = (['id', 'model', 'name'] as const).find(
      (candidate) => typeof record[candidate] === 'string' && record[candidate]
    )
    if (!key) {
      return []
    }
    const id = String(record[key])
    const label = typeof record.name === 'string' && record.name ? record.name : id
    // 各服务商的窗口字段名不同：DeepSeek/Anthropic 风格 context_window、
    // OpenAI 兼容网关常见的 contextWindow，以及 OpenRouter 风格的 limit.context
    const limit =
      record.limit !== null && typeof record.limit === 'object'
        ? (record.limit as Record<string, unknown>)
        : null
    const rawWindow =
      record.context_window ?? record.contextWindow ?? record.context_length ?? limit?.context
    const contextWindow = positiveInt(rawWindow)
    const maxOutputTokens = positiveInt(
      record.max_output_tokens ?? record.maxOutputTokens ?? limit?.output
    )
    const inputModalities = stringList(record.input_modalities ?? record.inputModalities)
    // DeepSeek 用 effort.supported_levels / default_level，OpenAI 风格网关通常没有
    const effortRecord =
      record.effort !== null && typeof record.effort === 'object'
        ? (record.effort as Record<string, unknown>)
        : null
    const effortLevels = stringList(effortRecord?.supported_levels)
    const defaultEffort =
      typeof effortRecord?.default_level === 'string' ? effortRecord.default_level : undefined
    const capabilities =
      record.api_capabilities !== null && typeof record.api_capabilities === 'object'
        ? (record.api_capabilities as Record<string, unknown>)
        : null
    const messages =
      capabilities?.anthropic_messages !== null &&
      typeof capabilities?.anthropic_messages === 'object'
        ? (capabilities.anthropic_messages as Record<string, unknown>)
        : null
    const rawUpdate = messages?.system_prompt_update
    const systemPromptUpdate =
      rawUpdate === 'leading-only' || rawUpdate === 'in-history' ? rawUpdate : undefined
    return [
      {
        id,
        label,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(inputModalities === undefined ? {} : { inputModalities }),
        ...(effortLevels === undefined ? {} : { effortLevels }),
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
        ...(systemPromptUpdate === undefined ? {} : { systemPromptUpdate }),
      },
    ]
  })
  // 同一 id 只保留第一条
  const seen = new Set<string>()
  return options.filter((option) => {
    if (seen.has(option.id)) {
      return false
    }
    seen.add(option.id)
    return true
  })
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${ANTHROPIC_BASE_URL}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export type FileListPage = {
  data: FileObject[]
  first_id?: string | null
  last_id?: string | null
  has_more?: boolean
}

/**
 * GET /anthropic/v1/files：Anthropic 兼容分页。
 * 分页游标是 after_id / before_id（互斥），limit 1–1000、默认 20；
 * 不支持 order / purpose 过滤，与 OpenAI 兼容版不同。
 */
export const listFiles = async (
  apiKey: string,
  options: { limit?: number; afterId?: string } = {},
  signal?: AbortSignal
): Promise<FileListPage> => {
  const params = new URLSearchParams()
  params.set('limit', String(Math.min(1000, Math.max(1, options.limit ?? 20))))
  if (options.afterId) {
    params.set('after_id', options.afterId)
  }
  const response = await request(`${ANTHROPIC_BASE_URL}/files?${params.toString()}`, {
    method: 'GET',
    headers: anthropicHeaders(apiKey, true),
    signal,
  })
  const body = (await response.json()) as FileListPage
  return { ...body, data: Array.isArray(body.data) ? body.data : [] }
}

/** GET /anthropic/v1/files/{file_id}：单个文件信息 */
export const retrieveFile = async (
  apiKey: string,
  fileId: string,
  signal?: AbortSignal
): Promise<FileObject> => {
  const response = await request(`${ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    method: 'GET',
    headers: anthropicHeaders(apiKey, true),
    signal,
  })
  return (await response.json()) as FileObject
}

export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${ANTHROPIC_BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}

/** OpenAI 兼容 chat/completions 的请求体；参数字段由调用方按需补充 */
export type OpenAiChatRequest = {
  model: string
  messages: unknown[]
  stream: true
  [key: string]: unknown
}

/**
 * POST {baseURL}/chat/completions（stream: true）。
 * 服务端的 OpenAI 增量在这里翻译成同一套 MessageStreamEvent，上层消费逻辑不区分协议。
 */
export async function* streamOpenAiChat(
  provider: Provider,
  apiKey: string,
  body: OpenAiChatRequest,
  signal: AbortSignal,
  sessionId?: string
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${provider.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...provider.headers,
      // OpenCode Go 要求每个会话带稳定的 session 标识，缺失会被 400 拒绝
      ...(sessionId ? { 'x-opencode-session': sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  const state: OpenAiStreamState = createOpenAiStreamState(body.model)
  for await (const { data } of readServerSentEvents(response.body, signal)) {
    if (data === '[DONE]') {
      yield* finishOpenAiStream(state, true)
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    // 流中的错误帧：形如 { error: { message } }，不带 choices
    const message = readOpenAiErrorMessage(payload)
    if (message && !hasChoices(payload)) {
      throw new ApiError('stream', message)
    }
    yield* readOpenAiEvent(payload, state)
    if (state.finished) {
      return
    }
  }
  // 没有收到 [DONE]：若已给出 finish_reason 视为正常结束，否则按断流处理。
  if (state.stopReason === null) {
    yield* finishOpenAiStream(state, false)
    throw new ApiError('interrupted', '')
  }
  yield* finishOpenAiStream(state, true)
}

const hasChoices = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'choices' in value
