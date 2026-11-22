import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResponsesRequest } from './responses.js'
import type { MessageParam, MessageStreamEvent } from './types.js'

// responses.ts 经 client.ts / providers.ts 在模块求值时读取构建期注入的全局常量，
// 必须先桩后动态导入（与 providers.test.ts 一致）。
vi.stubGlobal('__API_ORIGIN__', 'https://api.deepseek.com')
vi.stubGlobal('__DEV_PROXY_PREFIX__', '')

const { streamResponses, toMessageUsage, toResponsesInput } = await import('./responses.js')
const { ApiError } = await import('./client.js')

const BASE = 'https://api.test/v1'
const signal = () => new AbortController().signal
const request = (): ResponsesRequest => ({ model: 'deepseek-chat', input: [], stream: true })

/** 构造一个 SSE 帧；payload 自带 type 时占位，否则用 event 名回退 */
const frame = (payload: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`

const sseResponse = (frames: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const item of frames) {
          controller.enqueue(encoder.encode(item))
        }
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

const collect = async (gen: AsyncGenerator<MessageStreamEvent>) => {
  const events: MessageStreamEvent[] = []
  for await (const event of gen) {
    events.push(event)
  }
  return events
}

const created = (id = 'r1', model = 'deepseek-chat') =>
  frame({ type: 'response.created', response: { id, model } })
const completed = (extra: Record<string, unknown> = {}) =>
  frame({ type: 'response.completed', response: { id: 'r1', model: 'deepseek-chat', ...extra } })

describe('toResponsesInput', () => {
  it('空消息列表返回空数组', () => {
    expect(toResponsesInput([])).toEqual([])
  })

  it('latest_reminder 作为 system 说明保留', () => {
    expect(toResponsesInput([{ role: 'latest_reminder', content: '2024-06-15,Saturday' }])).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: '当前时间与位置：2024-06-15,Saturday' }] },
    ])
  })

  it('user 字符串消息：空串与空白丢弃，非空转 input_text', () => {
    expect(
      toResponsesInput([
        { role: 'user', content: '' },
        { role: 'user', content: '   ' },
        { role: 'user', content: '问题' },
      ])
    ).toEqual([{ role: 'user', content: [{ type: 'input_text', text: '问题' }] }])
  })

  it('user 内容数组支持 text、image file_id 与 document file_id', () => {
    expect(
      toResponsesInput([
        {
          role: 'user',
          content: [
            { type: 'text', text: '提问' },
            { type: 'image', source: { type: 'file', file_id: 'file_img' } },
            { type: 'document', source: { type: 'file', file_id: 'file_doc' } },
          ],
        },
      ])
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '提问' },
          { type: 'input_image', file_id: 'file_img' },
          { type: 'input_file', file_id: 'file_doc' },
        ],
      },
    ])
  })

  it('非 file source 的图片等不支持内容被忽略，全无有效内容时丢弃消息', () => {
    const invalid = {
      role: 'user',
      content: [{ type: 'image', source: { type: 'url', url: 'https://x' } }],
    } as unknown as MessageParam
    expect(toResponsesInput([invalid])).toEqual([])
  })

  it('assistant 只取非空 text 块，思考块不进上下文', () => {
    expect(
      toResponsesInput([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '回答' },
            { type: 'text', text: '' },
            { type: 'thinking', thinking: '思考', signature: 's' },
          ],
        },
      ])
    ).toEqual([{ role: 'assistant', content: [{ type: 'output_text', text: '回答' }] }])
  })

  it('assistant 没有非空文本时丢弃该消息', () => {
    expect(toResponsesInput([{ role: 'assistant', content: [{ type: 'text', text: '' }] }])).toEqual([])
  })

  it('多消息保持顺序并自动丢弃空消息', () => {
    expect(
      toResponsesInput([
        { role: 'user', content: '第一问' },
        { role: 'latest_reminder', content: '提醒' },
        { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
        { role: 'user', content: '' },
      ])
    ).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '第一问' }] },
      { role: 'system', content: [{ type: 'input_text', text: '当前时间与位置：提醒' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: '回答' }] },
    ])
  })
})

describe('toMessageUsage', () => {
  it('null 与 undefined 返回 undefined', () => {
    expect(toMessageUsage(null)).toBeUndefined()
    expect(toMessageUsage(undefined)).toBeUndefined()
  })

  it('input_tokens 含缓存命中时拆成未命中与命中两部分', () => {
    expect(
      toMessageUsage({
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 20,
      })
    ).toEqual({
      input_tokens: 60,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
      output_tokens: 20,
    })
  })

  it('缓存命中量超过输入总量时未命中部分下限为 0', () => {
    expect(
      toMessageUsage({ input_tokens: 10, input_tokens_details: { cached_tokens: 50 } })
    ).toMatchObject({ input_tokens: 0, cache_read_input_tokens: 50 })
  })

  it('思考与安全 token 明细仅在大于 0 时出现', () => {
    expect(
      toMessageUsage({
        input_tokens: 1,
        output_tokens: 2,
        output_tokens_details: { reasoning_tokens: 5, safety_tokens: 6 },
      })
    ).toEqual({
      input_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 2,
      output_tokens_details: { thinking_tokens: 5, safety_tokens: 6 },
    })
    expect(toMessageUsage({ output_tokens_details: { reasoning_tokens: 5 } })).toMatchObject({
      output_tokens_details: { thinking_tokens: 5 },
    })
    expect(toMessageUsage({ output_tokens_details: {} })).not.toHaveProperty(
      'output_tokens_details'
    )
  })

  it('server_tool_use 四项计数归一，缺省时不带该对象', () => {
    expect(
      toMessageUsage({
        input_tokens: 10,
        server_tool_use: { tool_search: 2, tool_fetch: 1, tool_image_search: 4 },
      })
    ).toEqual({
      input_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      server_tool_use: {
        web_search_requests: 2,
        tool_search: 2,
        tool_fetch: 1,
        tool_image_search: 4,
      },
    })
    expect(toMessageUsage({ input_tokens: 10 })).not.toHaveProperty('server_tool_use')
  })
})

describe('streamResponses', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('按约定 URL、方法、请求头与 body 发起请求', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([created(), completed()])
    )
    const body = request()
    await collect(streamResponses(BASE, 'sk-1', body, signal()))
    expect(fetchSpy).toHaveBeenCalledWith(`${BASE}/responses`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk-1',
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: expect.any(AbortSignal),
    })
  })

  it('首个事件的 response.id / model 用于 message_start', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([created('resp-abc', 'deepseek-chat'), completed()])
    )
    const events = await collect(streamResponses(BASE, 'k', request(), signal()))
    expect(events[0]).toMatchObject({
      type: 'message_start',
      message: { id: 'resp-abc', model: 'deepseek-chat' },
    })
  })

  it('首个事件没有 id 时生成 resp- 前缀的 id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([frame({ type: 'response.created', response: {} }), completed()])
    )
    const events = await collect(streamResponses(BASE, 'k', request(), signal()))
    expect(events[0]).toMatchObject({ type: 'message_start' })
    const id = (events[0] as { message: { id: string } }).message.id
    expect(id).toMatch(/^resp-/)
  })

  it('reasoning 与 output_text 增量切换时先关闭旧块', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        created(),
        frame({ type: 'response.reasoning_text.delta', delta: '思考' }),
        frame({ type: 'response.output_text.delta', delta: '回答' }),
        completed(),
      ])
    )
    const events = await collect(streamResponses(BASE, 'k', request(), signal()))
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[1]).toMatchObject({ index: 0, content_block: { type: 'thinking' } })
    expect(events[2]).toMatchObject({ index: 0, delta: { thinking: '思考' } })
    expect(events[3]).toEqual({ type: 'content_block_stop', index: 0 })
    expect(events[4]).toMatchObject({ index: 1, content_block: { type: 'text' } })
    expect(events[5]).toMatchObject({ index: 1, delta: { text: '回答' } })
  })

  it('output_item.done 关闭当前块，后续文本另起新块', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        created(),
        frame({ type: 'response.output_text.delta', delta: 'A' }),
        frame({ type: 'response.output_item.done', item: {} }),
        frame({ type: 'response.output_text.delta', delta: 'B' }),
        completed(),
      ])
    )
    const events = await collect(streamResponses(BASE, 'k', request(), signal()))
    const starts = events.filter((e) => e.type === 'content_block_start')
    const stops = events.filter((e) => e.type === 'content_block_stop')
    expect(starts.map((e) => (e as { index: number }).index)).toEqual([0, 1])
    expect(stops).toHaveLength(2)
    expect(events).toContainEqual({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'B' } })
  })

  it('response.completed 收尾并忽略其后的帧', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        created(),
        frame({ type: 'response.output_text.delta', delta: '你好' }),
        completed(),
        frame({ type: 'response.output_text.delta', delta: '不应出现' }),
      ])
    )
    const events = await collect(streamResponses(BASE, 'k', request(), signal()))
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events.some((e) => JSON.stringify(e).includes('不应出现'))).toBe(false)
    expect(events[4]).toMatchObject({ delta: { stop_reason: 'end_turn', stop_sequence: null } })
  })

  it('incomplete 的 content_filter 产生 refusal 明细与 title', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        created(),
        frame({
          type: 'response.incomplete',
          response: {
            id: 'r1',
            model: 'deepseek-chat',
            title: '会话标题',
            incomplete_details: { reason: 'content_filter' },
            error: { message: '图片被拦截' },
          },
        }),
      ])
    )
    const events = await collect(streamResponses(BASE, 'k', request(), signal()))
    expect(events[1]).toMatchObject({
      type: 'message_delta',
      delta: {
        stop_reason: 'refusal',
        title: '会话标题',
        stop_details: { type: 'refusal', category: null, explanation: '图片被拦截' },
      },
    })
  })

  it('incomplete 的 max_output_tokens 映射到 max_tokens', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        created(),
        frame({
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'max_output_tokens' } },
        }),
      ])
    )
    const events = await collect(streamResponses(BASE, 'k', request(), signal()))
    expect(events[1]).toMatchObject({ delta: { stop_reason: 'max_tokens' } })
  })

  it('response.failed 先发收尾事件再抛 stream 错误', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        created(),
        frame({ type: 'response.failed', response: { error: { message: '服务失败' } } }),
      ])
    )
    const events: MessageStreamEvent[] = []
    let error: unknown
    try {
      for await (const event of streamResponses(BASE, 'k', request(), signal())) {
        events.push(event)
      }
    } catch (caught) {
      error = caught
    }
    expect(events.map((e) => e.type)).toEqual(['message_start', 'message_delta', 'message_stop'])
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'stream', message: '服务失败' })
  })

  it('非法 JSON、空 data 与非对象帧被静默跳过', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'data: {broken json\n\n',
        'data: 123\n\n',
        'data: \n\n',
        frame({ type: 'response.output_text.delta', delta: '有效' }),
        completed(),
      ])
    )
    const events = await collect(streamResponses(BASE, 'k', request(), signal()))
    expect(events).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '有效' },
    })
    expect(events[events.length - 1]).toEqual({ type: 'message_stop' })
  })

  it('没有收到终态事件时以 interrupted 错误结束', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse([created()]))
    const events: MessageStreamEvent[] = []
    let error: unknown
    try {
      for await (const event of streamResponses(BASE, 'k', request(), signal())) {
        events.push(event)
      }
    } catch (caught) {
      error = caught
    }
    expect(events.map((e) => e.type)).toEqual(['message_start'])
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'interrupted' })
  })

  it('HTTP 非 2xx 抛出带状态码的 http 错误', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('限流', { status: 429 }))
    let error: unknown
    try {
      await collect(streamResponses(BASE, 'k', request(), signal()))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'http', status: 429, message: '限流' })
  })

  it('响应没有 body 时抛出 protocol 错误', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    let error: unknown
    try {
      await collect(streamResponses(BASE, 'k', request(), signal()))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'protocol', message: 'Response has no body' })
  })

  it('payload 缺少 type 时用 SSE 的 event 名回退', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        created(),
        'event: response.output_text.delta\ndata: {"delta":"回退"}\n\n',
        completed(),
      ])
    )
    const events = await collect(streamResponses(BASE, 'k', request(), signal()))
    expect(events).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '回退' },
    })
  })

  it('空的 delta 不产生内容块', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        created(),
        frame({ type: 'response.reasoning_text.delta', delta: '' }),
        frame({ type: 'response.output_text.delta', delta: '' }),
        completed(),
      ])
    )
    const events = await collect(streamResponses(BASE, 'k', request(), signal()))
    expect(events.map((e) => e.type)).toEqual(['message_start', 'message_delta', 'message_stop'])
  })

  it('completed 的 usage 与 title 归一后写入 message_delta', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        created(),
        completed({
          title: '会话标题',
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 7, safety_tokens: 3 },
            server_tool_use: { tool_search: 2, tool_fetch: 1, tool_image_search: 4 },
          },
        }),
      ])
    )
    const events = await collect(streamResponses(BASE, 'k', request(), signal()))
    const delta = events[1] as Extract<MessageStreamEvent, { type: 'message_delta' }>
    expect(delta.delta.title).toBe('会话标题')
    expect(delta.usage).toEqual({
      input_tokens: 60,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
      output_tokens: 20,
      output_tokens_details: { thinking_tokens: 7, safety_tokens: 3 },
      server_tool_use: {
        web_search_requests: 2,
        tool_search: 2,
        tool_fetch: 1,
        tool_image_search: 4,
      },
    })
  })
})
