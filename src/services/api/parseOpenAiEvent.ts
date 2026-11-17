import type { MessageStreamEvent, StopReason } from './types.js'

/**
 * 把 OpenAI 兼容 chat/completions 的流式增量翻译成应用内部使用的 Anthropic 事件序列。
 *
 * 翻译规则：
 * - 首次收到 delta 时发 message_start；
 * - reasoning_content / reasoning 增量映射为 thinking 块，content 增量映射为 text 块，各自在切换时关闭上一个块；
 * - finish_reason 映射为 StopReason（stop→end_turn、length→max_tokens、content_filter→refusal）；
 * - [DONE] 或流结束发 message_delta + message_stop，让上层的归并逻辑与 Anthropic 完全一致。
 */

/** 一次请求内的翻译状态：记录当前打开的内容块与是否已经结束 */
export type OpenAiStreamState = {
  model: string
  /** 已发出 message_start */
  started: boolean
  /** 当前打开的内容块类型与下标 */
  openBlock: { type: 'thinking' | 'text'; index: number } | null
  /** 下一个可用的内容块下标 */
  nextIndex: number
  /** 已收到的结束原因；为 null 表示还没有 finish_reason */
  stopReason: StopReason | null
  /** title.enabled 为 true 时服务端在最后一个 chunk 的 delta.title 里给出的会话标题 */
  title: string | null
  /** 图片被内容审核拦截时的说明，位于 message.refusal / delta.refusal */
  refusal: string | null
  /** 已发出 message_stop */
  finished: boolean
  /** 累计用量，OpenAI 在末尾或每个 chunk 的 usage 字段中给出 */
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
    thinking_tokens: number
    safety_tokens: number
    tool_search: number
    tool_fetch: number
    tool_image_search: number
  }
}

export const createOpenAiStreamState = (model: string): OpenAiStreamState => ({
  model,
  started: false,
  openBlock: null,
  nextIndex: 0,
  stopReason: null,
  title: null,
  refusal: null,
  finished: false,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    thinking_tokens: 0,
    safety_tokens: 0,
    tool_search: 0,
    tool_fetch: 0,
    tool_image_search: 0,
  },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

/** finish_reason → StopReason；未知原因按正常结束处理 */
const toStopReason = (value: unknown): StopReason | null => {
  switch (value) {
    case 'stop':
    case 'end_turn':
      return 'end_turn'
    case 'length':
    case 'max_tokens':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool_use'
    case 'content_filter':
    case 'refusal':
      return 'refusal'
    default:
      return null
  }
}

/**
 * 读取一段 usage。
 *
 * 各家 OpenAI 兼容网关的字段并不统一，缓存命中尤其分散：
 * - DeepSeek 官方：prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * - OpenAI 与多数网关：prompt_tokens_details.cached_tokens
 * - 少数网关直接给 cached_tokens 或 cache_read_input_tokens
 *
 * 内部语义与 Anthropic 一致：input_tokens 只算**未命中**的部分，
 * 命中量单独记在 cache_read_input_tokens，命中率才不会把 prompt 算两遍。
 * usage 在流式响应里是累计快照（可能重复出现在多个 chunk），因此取最大值而不是相加。
 */
const readUsage = (state: OpenAiStreamState, value: unknown) => {
  if (!isRecord(value)) {
    return
  }
  const pickFrom = (record: Record<string, unknown>, key: string): number => {
    const found = record[key]
    return typeof found === 'number' && Number.isFinite(found) && found > 0 ? found : 0
  }
  const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : null
  const total = pickFrom(value, 'prompt_tokens') || pickFrom(value, 'input_tokens')
  const cached =
    pickFrom(value, 'prompt_cache_hit_tokens') ||
    pickFrom(value, 'cached_tokens') ||
    pickFrom(value, 'cache_read_input_tokens') ||
    (details ? pickFrom(details, 'cached_tokens') : 0)
  // 命中量不可能超过 prompt 总量；网关给错了就以总量为上限
  const cacheRead = total > 0 ? Math.min(cached, total) : cached
  const uncached = total > 0 ? total - cacheRead : 0
  const output = pickFrom(value, 'completion_tokens') || pickFrom(value, 'output_tokens')
  state.usage.input_tokens = Math.max(state.usage.input_tokens, uncached)
  state.usage.cache_read_input_tokens = Math.max(state.usage.cache_read_input_tokens, cacheRead)
  state.usage.output_tokens = Math.max(state.usage.output_tokens, output)
  // 思考 token 与安全审核 token 已经包含在 completion_tokens 里，只作明细展示
  const completionDetails = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : null
  const thinking = completionDetails ? pickFrom(completionDetails, 'reasoning_tokens') : 0
  const safety = pickFrom(value, 'safety_tokens')
  state.usage.thinking_tokens = Math.max(state.usage.thinking_tokens, thinking)
  state.usage.safety_tokens = Math.max(state.usage.safety_tokens, safety)
  const tools = isRecord(value.server_tool_use) ? value.server_tool_use : null
  if (tools) {
    state.usage.tool_search = Math.max(state.usage.tool_search, pickFrom(tools, 'tool_search'))
    state.usage.tool_fetch = Math.max(state.usage.tool_fetch, pickFrom(tools, 'tool_fetch'))
    state.usage.tool_image_search = Math.max(
      state.usage.tool_image_search,
      pickFrom(tools, 'tool_image_search')
    )
  }
}

const start = (state: OpenAiStreamState): MessageStreamEvent => {
  state.started = true
  return {
    type: 'message_start',
    message: { id: `openai-${Date.now().toString(36)}`, model: state.model },
  }
}

const closeBlock = (state: OpenAiStreamState): MessageStreamEvent[] => {
  if (!state.openBlock) {
    return []
  }
  const event: MessageStreamEvent = { type: 'content_block_stop', index: state.openBlock.index }
  state.openBlock = null
  return [event]
}

/** 需要写内容时先确保对应类型的块已打开；切换类型会关闭上一个块 */
const ensureBlock = (
  state: OpenAiStreamState,
  type: 'thinking' | 'text'
): { events: MessageStreamEvent[]; index: number } => {
  if (state.openBlock?.type === type) {
    return { events: [], index: state.openBlock.index }
  }
  const events = closeBlock(state)
  const index = state.nextIndex
  state.nextIndex += 1
  state.openBlock = { type, index }
  events.push({
    type: 'content_block_start',
    index,
    content_block: type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' },
  })
  return { events, index }
}

/**
 * 消费一个 SSE data 帧，产出翻译后的事件；state 会被就地更新。
 * 兼容 delta.reasoning_content（DeepSeek / vLLM）、delta.reasoning（部分网关）
 * 以及非流式的 message.content 形状。
 */
export function* readOpenAiEvent(
  payload: unknown,
  state: OpenAiStreamState
): Generator<MessageStreamEvent> {
  const events: MessageStreamEvent[] = []
  if (!isRecord(payload)) {
    return
  }
  if (!state.started) {
    events.push(start(state))
  }
  readUsage(state, payload.usage)
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const choice = isRecord(choices[0]) ? choices[0] : null
  if (!choice) {
    for (const event of events) {
      yield event
    }
    return
  }
  const delta = isRecord(choice.delta)
    ? choice.delta
    : isRecord(choice.message)
      ? choice.message
      : null
  if (delta) {
    const reasoning =
      (isString(delta.reasoning_content) && delta.reasoning_content) ||
      (isString(delta.reasoning) && delta.reasoning) ||
      ''
    if (reasoning) {
      const block = ensureBlock(state, 'thinking')
      events.push(...block.events, {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'thinking_delta', thinking: reasoning },
      })
    }
    const text = isString(delta.content) ? delta.content : ''
    if (text) {
      const block = ensureBlock(state, 'text')
      events.push(...block.events, {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'text_delta', text },
      })
    }
  }
  // 会话标题只在最后一个 chunk 出现一次，跟随 delta 透传
  if (delta && isString(delta.title) && delta.title.trim() !== '') {
    state.title = delta.title.trim()
  }
  // 图片拒答说明：流式在最后一个 chunk 的 delta.refusal，非流式在 message.refusal
  const refusal = delta && isString(delta.refusal) ? delta.refusal.trim() : ''
  if (refusal !== '') {
    state.refusal = refusal
  }
  const stopReason = toStopReason(choice.finish_reason)
  if (stopReason) {
    state.stopReason = stopReason
  }
  for (const event of events) {
    yield event
  }
}

/** 收尾：关闭未结束的块，发 message_delta 与 message_stop */
export function* finishOpenAiStream(
  state: OpenAiStreamState,
  normal: boolean
): Generator<MessageStreamEvent> {
  if (state.finished) {
    return
  }
  if (!state.started) {
    yield start(state)
  }
  const stopReason: StopReason = state.stopReason ?? (normal ? 'end_turn' : 'end_turn')
  for (const event of closeBlock(state)) {
    yield event
  }
  state.finished = true
  const { thinking_tokens, safety_tokens, tool_search, tool_fetch, tool_image_search, ...base } =
    state.usage
  const toolsUsed = tool_search + tool_fetch + tool_image_search
  yield {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
      ...(state.title === null ? {} : { title: state.title }),
      ...(state.refusal === null
        ? {}
        : {
            stop_details: {
              type: 'refusal' as const,
              category: null,
              explanation: state.refusal,
            },
          }),
    },
    usage: {
      ...base,
      ...(thinking_tokens + safety_tokens > 0
        ? {
            output_tokens_details: {
              ...(thinking_tokens > 0 ? { thinking_tokens } : {}),
              ...(safety_tokens > 0 ? { safety_tokens } : {}),
            },
          }
        : {}),
      ...(toolsUsed > 0
        ? {
            server_tool_use: {
              // Chat Completions 只给「成功且计费」的次数，展示口径与 Anthropic 对齐
              web_search_requests: tool_search,
              tool_search,
              tool_fetch,
              tool_image_search,
            },
          }
        : {}),
    },
  }
  yield { type: 'message_stop' }
}
