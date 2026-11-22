import { describe, expect, it } from 'vitest'
import {
  createOpenAiStreamState,
  finishOpenAiStream,
  readOpenAiEvent,
  type OpenAiStreamState,
} from './parseOpenAiEvent.js'
import type { MessageStreamEvent } from './types.js'

const typesOf = (events: MessageStreamEvent[]) => events.map((event) => event.type)
const emit = (payload: unknown, state: OpenAiStreamState) => [...readOpenAiEvent(payload, state)]
const finish = (state: OpenAiStreamState, normal = true) => [...finishOpenAiStream(state, normal)]
const deltaOf = (events: MessageStreamEvent[]) =>
  events.find((event) => event.type === 'message_delta') as Extract<
    MessageStreamEvent,
    { type: 'message_delta' }
  >

describe('createOpenAiStreamState', () => {
  it('初始化为空状态，所有字段为默认值', () => {
    const state = createOpenAiStreamState('deepseek-chat')
    expect(state).toMatchObject({
      model: 'deepseek-chat',
      started: false,
      openBlock: null,
      nextIndex: 0,
      stopReason: null,
      title: null,
      refusal: null,
      finished: false,
    })
    expect(state.toolCalls.size).toBe(0)
    expect(state.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      thinking_tokens: 0,
      safety_tokens: 0,
      tool_search: 0,
      tool_fetch: 0,
      tool_image_search: 0,
    })
  })
})

describe('readOpenAiEvent 基本行为', () => {
  it('非对象 payload 不产生事件，也不改变状态', () => {
    for (const payload of [null, undefined, 42, 'x', [], true]) {
      const state = createOpenAiStreamState('m')
      expect(emit(payload, state)).toEqual([])
      expect(state.started).toBe(false)
      expect(state.nextIndex).toBe(0)
    }
  })

  it('首个有效 payload 发出 message_start，后续不再重复', () => {
    const state = createOpenAiStreamState('deepseek-chat')
    const first = emit({ choices: [{ delta: { content: 'A' } }] }, state)
    expect(typesOf(first)).toEqual(['message_start', 'content_block_start', 'content_block_delta'])
    expect(first[0]).toMatchObject({ type: 'message_start', message: { model: 'deepseek-chat' } })
    expect((first[0] as { message: { id: string } }).message.id).toMatch(/^openai-/)

    const second = emit({ choices: [{ delta: { content: 'B' } }] }, state)
    expect(typesOf(second)).toEqual(['content_block_delta'])
  })

  it('没有 choices 时只发出 message_start', () => {
    const state = createOpenAiStreamState('m')
    expect(typesOf(emit({}, state))).toEqual(['message_start'])
    expect(typesOf(emit({ choices: [] }, state))).toEqual([])
    expect(typesOf(emit({ choices: [null, 'x'] }, state))).toEqual([])
    expect(state.usage.input_tokens).toBe(0)
  })

  it('usage 即使没有 choices 也会被读取', () => {
    const state = createOpenAiStreamState('m')
    emit({ usage: { prompt_tokens: 90, prompt_cache_hit_tokens: 30 } }, state)
    expect(state.usage.input_tokens).toBe(60)
    expect(state.usage.cache_read_input_tokens).toBe(30)
  })
})

describe('readOpenAiEvent 内容块', () => {
  it('文本增量打开 text 块并发出 text_delta', () => {
    const state = createOpenAiStreamState('m')
    const events = emit({ choices: [{ delta: { content: '你好' } }] }, state)
    expect(events[1]).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })
    expect(events[2]).toEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '你好' },
    })
    expect(state.openBlock).toEqual({ type: 'text', index: 0 })
    expect(state.nextIndex).toBe(1)
  })

  it('连续文本增量复用同一个块，不重复 open', () => {
    const state = createOpenAiStreamState('m')
    emit({ choices: [{ delta: { content: 'A' } }] }, state)
    const events = emit({ choices: [{ delta: { content: 'B' } }] }, state)
    expect(typesOf(events)).toEqual(['content_block_delta'])
    expect(events[0]).toMatchObject({ index: 0, delta: { type: 'text_delta', text: 'B' } })
    expect(state.nextIndex).toBe(1)
  })

  it('非字符串 content 被忽略', () => {
    const state = createOpenAiStreamState('m')
    expect(typesOf(emit({ choices: [{ delta: { content: 123 } }] }, state))).toEqual([
      'message_start',
    ])
    expect(typesOf(emit({ choices: [{ delta: { content: null } }] }, state))).toEqual([])
    expect(state.openBlock).toBeNull()
  })

  it('reasoning_content 映射为 thinking 块与 thinking_delta', () => {
    const state = createOpenAiStreamState('m')
    const events = emit({ choices: [{ delta: { reasoning_content: '让我想想' } }] }, state)
    expect(events[1]).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    })
    expect(events[2]).toEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '让我想想' },
    })
  })

  it('reasoning 字段同样映射为 thinking_delta', () => {
    const state = createOpenAiStreamState('m')
    const events = emit({ choices: [{ delta: { reasoning: '推理' } }] }, state)
    expect(events[2]).toEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '推理' },
    })
  })

  it('reasoning_content 优先于 reasoning', () => {
    const state = createOpenAiStreamState('m')
    const events = emit(
      { choices: [{ delta: { reasoning_content: '官方推理', reasoning: '别的推理' } }] },
      state
    )
    expect(events[2]).toMatchObject({ delta: { thinking: '官方推理' } })
  })

  it('从 thinking 切换到 text 时先关闭旧块并另起新下标', () => {
    const state = createOpenAiStreamState('m')
    emit({ choices: [{ delta: { reasoning_content: '思考中' } }] }, state)
    const events = emit({ choices: [{ delta: { content: '回答' } }] }, state)
    expect(typesOf(events)).toEqual([
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
    ])
    expect(events[0]).toEqual({ type: 'content_block_stop', index: 0 })
    expect(events[1]).toMatchObject({ type: 'content_block_start', index: 1 })
    expect(events[2]).toEqual({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: '回答' },
    })
    expect(state.nextIndex).toBe(2)
  })

  it('从 text 切换到 thinking 时先关闭旧块并另起新下标', () => {
    const state = createOpenAiStreamState('m')
    emit({ choices: [{ delta: { content: '正文' } }] }, state)
    const events = emit({ choices: [{ delta: { reasoning: '补充思考' } }] }, state)
    expect(typesOf(events)).toEqual([
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
    ])
    expect(events[0]).toEqual({ type: 'content_block_stop', index: 0 })
    expect(events[1]).toMatchObject({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking' },
    })
    expect(events[2]).toMatchObject({ index: 1, delta: { thinking: '补充思考' } })
  })

  it('reasoning 与 content 同块时，thinking 先于 text 且各自成块', () => {
    const state = createOpenAiStreamState('m')
    const events = emit(
      { choices: [{ delta: { reasoning_content: '想', content: '说' } }] },
      state
    )
    expect(typesOf(events)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
    ])
    expect(state.nextIndex).toBe(2)
  })

  it('支持非流式的 message.content 形状', () => {
    const state = createOpenAiStreamState('m')
    const events = emit({ choices: [{ message: { content: '最终回答' } }] }, state)
    expect(events[2]).toEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '最终回答' },
    })
  })
})

describe('readOpenAiEvent 结束原因、标题与拒答', () => {
  it('finish_reason 映射到内部 stop_reason', () => {
    const cases: [unknown, string | null][] = [
      ['stop', 'end_turn'],
      ['end_turn', 'end_turn'],
      ['length', 'max_tokens'],
      ['max_tokens', 'max_tokens'],
      ['tool_calls', 'tool_use'],
      ['function_call', 'tool_use'],
      ['tool_use', 'tool_use'],
      ['content_filter', 'refusal'],
      ['refusal', 'refusal'],
      ['something_else', null],
      [null, null],
    ]
    for (const [finishReason, expected] of cases) {
      const state = createOpenAiStreamState('m')
      emit({ choices: [{ delta: {}, finish_reason: finishReason }] }, state)
      expect(state.stopReason).toBe(expected)
    }
  })

  it('title 去空白后记录', () => {
    const state = createOpenAiStreamState('m')
    emit({ choices: [{ delta: { title: '  会话标题  ' } }] }, state)
    expect(state.title).toBe('会话标题')
  })

  it('纯空白或非字符串 title 被忽略', () => {
    const state = createOpenAiStreamState('m')
    emit({ choices: [{ delta: { title: '   ' } }] }, state)
    expect(state.title).toBeNull()
    emit({ choices: [{ delta: { title: 123 } }] }, state)
    expect(state.title).toBeNull()
  })

  it('refusal 去空白后记录', () => {
    const state = createOpenAiStreamState('m')
    emit({ choices: [{ delta: { refusal: '  图片被内容审核拦截  ' } }] }, state)
    expect(state.refusal).toBe('图片被内容审核拦截')
  })

  it('空的 refusal 不覆盖已有值', () => {
    const state = createOpenAiStreamState('m')
    emit({ choices: [{ delta: { refusal: '拦截' } }] }, state)
    emit({ choices: [{ delta: { refusal: '   ' } }] }, state)
    expect(state.refusal).toBe('拦截')
  })

  it('tool_calls 按 index 累积 id、name 与 arguments', () => {
    const state = createOpenAiStreamState('m')
    emit(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city"' } },
              ],
            },
          },
        ],
      },
      state
    )
    emit(
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: ':"北京"}' } }] } },
        ],
      },
      state
    )
    expect(state.toolCalls.get(0)).toEqual({ id: 'call_1', name: 'get_weather', args: '{"city":"北京"}' })
  })

  it('多个 tool_calls 按各自 index 独立累积', () => {
    const state = createOpenAiStreamState('m')
    emit(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'c0', function: { name: 'f0', arguments: '{' } },
                { index: 1, id: 'c1', function: { name: 'f1', arguments: '[' } },
              ],
            },
          },
        ],
      },
      state
    )
    emit(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '}' } },
                { index: 1, function: { arguments: ']' } },
              ],
            },
          },
        ],
      },
      state
    )
    expect([...state.toolCalls.keys()].sort()).toEqual([0, 1])
    expect(state.toolCalls.get(0)?.args).toBe('{}')
    expect(state.toolCalls.get(1)?.args).toBe('[]')
  })

  it('非对象的 tool_call 项与缺失 index 均被处理', () => {
    const state = createOpenAiStreamState('m')
    emit(
      {
        choices: [
          {
            delta: {
              tool_calls: [null, 'x', 5, { id: 'fallback_index0' }],
            },
          },
        ],
      },
      state
    )
    expect(state.toolCalls.size).toBe(1)
    expect(state.toolCalls.get(0)).toEqual({ id: 'fallback_index0', name: '', args: '' })
  })
})

describe('readOpenAiEvent usage 读取', () => {
  it('读取 DeepSeek prompt_cache_hit_tokens，未命中部分单独计', () => {
    const state = createOpenAiStreamState('m')
    emit(
      {
        usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40, completion_tokens: 20 },
        choices: [],
      },
      state
    )
    expect(state.usage.input_tokens).toBe(60)
    expect(state.usage.cache_read_input_tokens).toBe(40)
    expect(state.usage.output_tokens).toBe(20)
    expect(state.usage.cache_creation_input_tokens).toBe(0)
  })

  it('读取 prompt_tokens_details.cached_tokens', () => {
    const state = createOpenAiStreamState('m')
    emit(
      {
        usage: {
          prompt_tokens: 200,
          prompt_tokens_details: { cached_tokens: 150 },
        },
        choices: [],
      },
      state
    )
    expect(state.usage.input_tokens).toBe(50)
    expect(state.usage.cache_read_input_tokens).toBe(150)
  })

  it('读取顶层 cached_tokens 与 cache_read_input_tokens', () => {
    const a = createOpenAiStreamState('m')
    emit({ usage: { prompt_tokens: 80, cached_tokens: 20 } }, a)
    expect(a.usage.input_tokens).toBe(60)
    expect(a.usage.cache_read_input_tokens).toBe(20)

    const b = createOpenAiStreamState('m')
    emit({ usage: { prompt_tokens: 80, cache_read_input_tokens: 30 } }, b)
    expect(b.usage.input_tokens).toBe(50)
    expect(b.usage.cache_read_input_tokens).toBe(30)
  })

  it('命中量超过 prompt 总量时以总量为上限', () => {
    const state = createOpenAiStreamState('m')
    emit({ usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 50 } }, state)
    expect(state.usage.cache_read_input_tokens).toBe(10)
    expect(state.usage.input_tokens).toBe(0)
  })

  it('input_tokens / output_tokens 字段名也可识别', () => {
    const state = createOpenAiStreamState('m')
    emit({ usage: { input_tokens: 80, output_tokens: 12 } }, state)
    expect(state.usage.input_tokens).toBe(80)
    expect(state.usage.output_tokens).toBe(12)
  })

  it('读取 completion_tokens_details 的思考 token 与 safety_tokens', () => {
    const state = createOpenAiStreamState('m')
    emit(
      {
        usage: {
          completion_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 7 },
          safety_tokens: 3,
        },
      },
      state
    )
    expect(state.usage.output_tokens).toBe(20)
    expect(state.usage.thinking_tokens).toBe(7)
    expect(state.usage.safety_tokens).toBe(3)
  })

  it('safety_tokens 嵌套在 completion_tokens_details 内时也能读到', () => {
    const state = createOpenAiStreamState('m')
    emit(
      {
        usage: {
          completion_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 7, safety_tokens: 5 },
        },
      },
      state
    )
    expect(state.usage.thinking_tokens).toBe(7)
    expect(state.usage.safety_tokens).toBe(5)
  })

  it('读取 server_tool_use 的工具次数', () => {
    const state = createOpenAiStreamState('m')
    emit(
      {
        usage: {
          server_tool_use: { tool_search: 2, tool_fetch: 1, tool_image_search: 4 },
        },
      },
      state
    )
    expect(state.usage.tool_search).toBe(2)
    expect(state.usage.tool_fetch).toBe(1)
    expect(state.usage.tool_image_search).toBe(4)
  })

  it('累计快照按各字段最大值合并，而不是相加', () => {
    const state = createOpenAiStreamState('m')
    emit({ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 20, completion_tokens: 10 } }, state)
    emit({ usage: { prompt_tokens: 200, prompt_cache_hit_tokens: 50, completion_tokens: 15 } }, state)
    emit({ usage: { prompt_tokens: 150, prompt_cache_hit_tokens: 30, completion_tokens: 8 } }, state)
    expect(state.usage.input_tokens).toBe(150)
    expect(state.usage.cache_read_input_tokens).toBe(50)
    expect(state.usage.output_tokens).toBe(15)
  })

  it('忽略非法 usage 数值（负数、非数字、NaN、非对象）', () => {
    const state = createOpenAiStreamState('m')
    for (const usage of [
      { prompt_tokens: -1, completion_tokens: -5, cached_tokens: NaN },
      { prompt_tokens: '100', input_tokens: '80', safety_tokens: '3' },
      null,
      'x',
      42,
      { prompt_tokens_details: 'x', server_tool_use: 'y' },
    ]) {
      emit({ usage }, state)
    }
    expect(state.usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      thinking_tokens: 0,
      safety_tokens: 0,
      tool_search: 0,
      tool_fetch: 0,
      tool_image_search: 0,
    })
  })
})

describe('finishOpenAiStream 收尾', () => {
  it('空状态收尾仍发出 message_start、message_delta 与 message_stop', () => {
    const state = createOpenAiStreamState('m')
    const events = finish(state, true)
    expect(typesOf(events)).toEqual(['message_start', 'message_delta', 'message_stop'])
    expect(events[1]).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
    })
    expect(events[2]).toEqual({ type: 'message_stop' })
    expect(state.finished).toBe(true)
  })

  it('先关闭未结束的内容块，再发 message_delta', () => {
    const state = createOpenAiStreamState('m')
    emit({ choices: [{ delta: { content: '未闭合' } }] }, state)
    const events = finish(state)
    expect(typesOf(events)).toEqual([
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[0]).toEqual({ type: 'content_block_stop', index: 0 })
  })

  it('tool_calls 在收尾时补成 tool_use 内容块（含 JSON 参数）', () => {
    const state = createOpenAiStreamState('m')
    emit(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } },
              ],
            },
          },
        ],
      },
      state
    )
    emit({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] } }] }, state)
    const events = finish(state)
    expect(typesOf(events)).toEqual([
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[0]).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} },
    })
    expect(events[1]).toEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"city":"北京"}' },
    })
  })

  it('多个 tool_calls 按 index 排序，跟在已有内容块之后', () => {
    const state = createOpenAiStreamState('m')
    const textEvents = emit({ choices: [{ delta: { content: '开场白' } }] }, state)
    expect(textEvents[1]).toMatchObject({ type: 'content_block_start', index: 0 })
    emit(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: 'second', function: { name: 'b', arguments: '' } },
                { index: 0, id: 'first', function: { name: 'a', arguments: '' } },
              ],
            },
          },
        ],
      },
      state
    )
    const events = finish(state)
    const starts = events.filter((e) => e.type === 'content_block_start')
    expect(starts).toHaveLength(2)
    expect(starts.map((e) => (e as { index: number }).index)).toEqual([1, 2])
    expect(starts[0]).toMatchObject({ content_block: { type: 'tool_use', id: 'first', name: 'a' } })
    expect(starts[1]).toMatchObject({ content_block: { type: 'tool_use', id: 'second', name: 'b' } })
    expect(events.filter((e) => e.type === 'content_block_delta')).toHaveLength(0)
  })

  it('缺失 id/name/arguments 的 tool_call 使用默认值且不发 input_json_delta', () => {
    const state = createOpenAiStreamState('m')
    emit({ choices: [{ delta: { tool_calls: [{ index: 3 }] } }] }, state)
    const events = finish(state)
    expect(events[0]).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_3', name: 'unknown', input: {} },
    })
    expect(
      events.some(
        (e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta'
      )
    ).toBe(false)
  })

  it('收尾是幂等的，第二次调用不再产生事件', () => {
    const state = createOpenAiStreamState('m')
    expect(finish(state)).toHaveLength(3)
    expect(finish(state)).toEqual([])
    expect(finish(state, false)).toEqual([])
  })

  it('message_delta 带上 title 与 refusal 明细', () => {
    const state = createOpenAiStreamState('m')
    emit({ choices: [{ delta: { title: '标题', refusal: '被拦截' } }] }, state)
    emit({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }, state)
    const events = finish(state)
    const delta = deltaOf(events)
    expect(delta).toMatchObject({
      type: 'message_delta',
      delta: {
        stop_reason: 'refusal',
        stop_sequence: null,
        title: '标题',
        stop_details: { type: 'refusal', category: null, explanation: '被拦截' },
      },
    })
  })

  it('message_delta 输出 usage 明细与工具计数', () => {
    const state = createOpenAiStreamState('m')
    emit(
      {
        usage: {
          prompt_tokens: 100,
          prompt_cache_hit_tokens: 40,
          completion_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 7 },
          safety_tokens: 3,
          server_tool_use: { tool_search: 2, tool_fetch: 1, tool_image_search: 4 },
        },
      },
      state
    )
    const events = finish(state)
    const delta = events[0] as Extract<MessageStreamEvent, { type: 'message_delta' }>
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

  it('没有明细时 message_delta.usage 不带 output_tokens_details / server_tool_use', () => {
    const state = createOpenAiStreamState('m')
    emit({ usage: { prompt_tokens: 10, completion_tokens: 5 } }, state)
    const delta = finish(state)[0] as Extract<MessageStreamEvent, { type: 'message_delta' }>
    expect(delta.usage).toEqual({
      input_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 5,
    })
  })

  it('没有 finish_reason 时 normal 为 true/false 都按 end_turn 收尾', () => {
    for (const normal of [true, false]) {
      const state = createOpenAiStreamState('m')
      const delta = deltaOf(finish(state, normal))
      expect(delta).toMatchObject({ delta: { stop_reason: 'end_turn' } })
    }
  })

  it('已有 stopReason 时沿用该值', () => {
    const state = createOpenAiStreamState('m')
    emit({ choices: [{ delta: {}, finish_reason: 'length' }] }, state)
    const delta = finish(state, true)[0]
    expect(delta).toMatchObject({ delta: { stop_reason: 'max_tokens' } })
  })
})
