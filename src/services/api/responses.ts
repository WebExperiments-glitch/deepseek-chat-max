import type {
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
} from './types.js'
import { http } from '../../ports/http.js'
import { ApiError } from './client.js'
import { readServerSentEvents } from './sse.js'

/**
 * Responses API（POST /responses）的最小实现：
 * 把应用内部的 Anthropic 风格消息翻译成 Responses 的 input items，
 * 再把语义化流式事件翻译回应用统一使用的 MessageStreamEvent。
 *
 * 当前范围（与文档逐条对齐后取舍）：
 * - 文本、图片（Files API file_id 或 data URL）、文档（file_id）、思考流、标题、usage 均支持；
 * - 服务端联网工具暂不声明：Responses 的 web_search_call item 需要原样回传才能续命，
 *   而应用内部的块模型没有对应结构，宁可关掉也不做半套；
 * - previous_response_id / conversation / store 均为无状态，天然不依赖服务端状态。
 */

export type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: string }
  | { type: 'input_image'; file_id: string }
  | { type: 'input_file'; file_id: string }

export type ResponsesItem = {
  role: 'user' | 'assistant' | 'system' | 'developer'
  content: string | ResponsesContentPart[]
}

export type ResponsesRequest = {
  model: string
  input: ResponsesItem[]
  instructions?: string
  stream: true
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  reasoning?: { effort: 'low' | 'high' | 'max' }
  safety_check?: { level: 'high' }
  title?: { enabled: boolean }
  /** JSON Output：Responses 协议用 text.format 声明 */
  text?: { format: { type: 'json_object' } }
  /** 客户端函数调用（Responses 为扁平 function 形状） */
  tools?: unknown[]
  user?: string
}

type ResponsesUsage = {
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens?: number
  output_tokens_details?: { reasoning_tokens?: number; safety_tokens?: number }
  server_tool_use?: {
    tool_search?: number
    tool_fetch?: number
    tool_image_search?: number
  }
}

type ResponsesObject = {
  id?: string
  model?: string
  title?: string
  status?: string
  incomplete_details?: { reason?: string }
  error?: { code?: string; message?: string } | null
  usage?: ResponsesUsage | null
}

const asText = (text: string): ResponsesContentPart => ({ type: 'input_text', text })

/** 把一条内部消息翻成 Responses item；无法表达的内容直接省略（服务端也不支持） */
const toItems = (message: MessageParam): ResponsesItem | null => {
  if (message.role === 'latest_reminder') {
    // Responses 不支持 latest_reminder 角色，作为 system 说明保留同样的信息
    return { role: 'system', content: [asText(`当前时间与位置：${message.content}`)] }
  }
  if (message.role === 'user') {
    if (typeof message.content === 'string') {
      return message.content.trim() === ''
        ? null
        : { role: 'user', content: [asText(message.content)] }
    }
    const parts: ResponsesContentPart[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push(asText(block.text))
      } else if (block.type === 'image' && block.source.type === 'file') {
        parts.push({ type: 'input_image', file_id: block.source.file_id })
      } else if (block.type === 'document' && block.source.type === 'file') {
        parts.push({ type: 'input_file', file_id: block.source.file_id })
      }
    }
    return parts.length > 0 ? { role: 'user', content: parts } : null
  }
  const parts: ResponsesContentPart[] = []
  for (const block of message.content) {
    if (block.type === 'text' && block.text !== '') {
      parts.push({ type: 'output_text', text: block.text })
    }
    // 历史思考与工具块按文档不进上下文，这里保持一致
  }
  return parts.length > 0 ? { role: 'assistant', content: parts } : null
}

/** 内部 messages → Responses input；空消息自动丢弃 */
export const toResponsesInput = (messages: MessageParam[]): ResponsesItem[] =>
  messages.flatMap((message) => {
    const item = toItems(message)
    return item ? [item] : []
  })

/** usage 归一：Responses 的 input_tokens 含缓存命中，内部口径要求分开 */
export const toMessageUsage = (usage: ResponsesUsage | null | undefined): MessageUsage | undefined => {
  if (!usage) {
    return undefined
  }
  const input = usage.input_tokens ?? 0
  const cached = usage.input_tokens_details?.cached_tokens ?? 0
  const thinking = usage.output_tokens_details?.reasoning_tokens ?? 0
  const safety = usage.output_tokens_details?.safety_tokens ?? 0
  const tools = usage.server_tool_use
  return {
    input_tokens: Math.max(0, input - cached),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: usage.output_tokens ?? 0,
    ...(thinking > 0 || safety > 0
      ? {
          output_tokens_details: {
            ...(thinking > 0 ? { thinking_tokens: thinking } : {}),
            ...(safety > 0 ? { safety_tokens: safety } : {}),
          },
        }
      : {}),
    ...(tools
      ? {
          server_tool_use: {
            web_search_requests: tools.tool_search ?? 0,
            tool_search: tools.tool_search ?? 0,
            tool_fetch: tools.tool_fetch ?? 0,
            tool_image_search: tools.tool_image_search ?? 0,
          },
        }
      : {}),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * POST /responses（stream: true）→ 统一的 MessageStreamEvent。
 * 事件以 response.completed / response.incomplete / response.failed 结束，没有 [DONE]。
 */
export async function* streamResponses(
  baseURL: string,
  apiKey: string,
  body: ResponsesRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await http(`${baseURL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new ApiError('http', text || `HTTP ${response.status}`, response.status)
  }
  if (!response.body) {
    throw new ApiError('protocol', 'Response has no body')
  }

  let started = false
  let nextIndex = 0
  let open: { type: 'thinking' | 'text'; index: number } | null = null
  let terminal = false

  const startEvent = (id: string, model: string): MessageStreamEvent => {
    started = true
    return {
      type: 'message_start',
      message: { id: id || `resp-${Date.now().toString(36)}`, model, usage: undefined },
    }
  }

  /** 打开指定类型的块；返回需要下发的事件与当前块下标（已打开时下标不变） */
  const openBlock = (
    type: 'thinking' | 'text'
  ): { events: MessageStreamEvent[]; index: number } => {
    if (open && open.type === type) {
      return { events: [], index: open.index }
    }
    const events: MessageStreamEvent[] = []
    if (open) {
      events.push({ type: 'content_block_stop', index: open.index })
    }
    const index = nextIndex
    events.push({
      type: 'content_block_start',
      index,
      content_block:
        type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' },
    })
    open = { type, index }
    nextIndex += 1
    return { events, index }
  }

  const closeBlock = (): MessageStreamEvent[] => {
    if (!open) {
      return []
    }
    const event: MessageStreamEvent = { type: 'content_block_stop', index: open.index }
    open = null
    return [event]
  }

  for await (const frame of readServerSentEvents(response.body, signal)) {
    if (!frame.data) {
      continue
    }
    let payload: unknown
    try {
      payload = JSON.parse(frame.data)
    } catch {
      continue
    }
    if (!isRecord(payload)) {
      continue
    }
    const type = str(payload.type) || frame.event
    if (!started) {
      const res = isRecord(payload.response) ? payload.response : null
      yield startEvent(str(res?.id), str(res?.model))
    }
    switch (type) {
      case 'response.reasoning_text.delta': {
        const delta = str(payload.delta)
        if (delta !== '') {
          const block = openBlock('thinking')
          for (const event of block.events) {
            yield event
          }
          yield {
            type: 'content_block_delta',
            index: block.index,
            delta: { type: 'thinking_delta', thinking: delta },
          }
        }
        break
      }
      case 'response.output_text.delta': {
        const delta = str(payload.delta)
        if (delta !== '') {
          const block = openBlock('text')
          for (const event of block.events) {
            yield event
          }
          yield {
            type: 'content_block_delta',
            index: block.index,
            delta: { type: 'text_delta', text: delta },
          }
        }
        break
      }
      case 'response.output_item.done': {
        for (const event of closeBlock()) {
          yield event
        }
        break
      }
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const res = isRecord(payload.response) ? payload.response : {}
        const usage = toMessageUsage((res as ResponsesObject).usage)
        const incomplete = (res as ResponsesObject).incomplete_details?.reason
        const stopReason: StopReason =
          type === 'response.failed'
            ? 'end_turn'
            : incomplete === 'content_filter'
              ? 'refusal'
              : incomplete === 'max_output_tokens'
                ? 'max_tokens'
                : 'end_turn'
        for (const event of closeBlock()) {
          yield event
        }
        yield {
          type: 'message_delta',
          delta: {
            stop_reason: stopReason,
            stop_sequence: null,
            ...(str((res as ResponsesObject).title)
              ? { title: str((res as ResponsesObject).title) }
              : {}),
            ...(incomplete === 'content_filter'
              ? {
                  stop_details: {
                    type: 'refusal' as const,
                    category: null,
                    explanation: (res as ResponsesObject).error?.message ?? null,
                  },
                }
              : {}),
          },
          usage,
        }
        yield { type: 'message_stop' }
        terminal = true
        if (type === 'response.failed') {
          const message = (res as ResponsesObject).error?.message ?? 'Response failed'
          throw new ApiError('stream', message)
        }
        break
      }
      default:
        break
    }
    if (terminal) {
      return
    }
  }
  if (!terminal) {
    throw new ApiError('interrupted', 'Stream ended before response.completed')
  }
}
