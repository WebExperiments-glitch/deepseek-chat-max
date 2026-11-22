import { describe, expect, it } from 'vitest'
import { readMessageEvent } from './parseEvent.js'

const blockStart = (contentBlock: unknown, index = 0) =>
  readMessageEvent({ type: 'content_block_start', index, content_block: contentBlock })
const blockDelta = (value: unknown, index = 0) =>
  readMessageEvent({ type: 'content_block_delta', index, delta: value })

const validUsage = {
  input_tokens: 1,
  cache_creation_input_tokens: 2,
  cache_read_input_tokens: 3,
  output_tokens: 4,
}

describe('readMessageEvent 基本校验', () => {
  it('非对象、数组与未知 type 一律返回 null', () => {
    for (const value of [null, undefined, 42, 'x', [], true]) {
      expect(readMessageEvent(value)).toBeNull()
    }
    expect(readMessageEvent({})).toBeNull()
    expect(readMessageEvent({ type: 'unknown' })).toBeNull()
  })

  it('ping 事件不被识别，直接丢弃', () => {
    expect(readMessageEvent({ type: 'ping' })).toBeNull()
  })

  it('message_stop 原样透传，包括额外字段', () => {
    const event = { type: 'message_stop', extra: 1 }
    expect(readMessageEvent(event)).toBe(event)
  })
})

describe('readMessageEvent message_start', () => {
  it('message 缺失或不是对象时返回 null', () => {
    expect(readMessageEvent({ type: 'message_start' })).toBeNull()
    expect(readMessageEvent({ type: 'message_start', message: 'x' })).toBeNull()
    expect(readMessageEvent({ type: 'message_start', message: null })).toBeNull()
  })

  it('合法 message_start 透传并保留额外字段', () => {
    const event = {
      type: 'message_start',
      message: { id: 'm1', model: 'deepseek-chat', usage: validUsage },
      extra: 'keep',
    }
    expect(readMessageEvent(event)).toEqual(event)
  })

  it('usage 四个字段必须都是有限数字，否则置为 undefined', () => {
    const base = { type: 'message_start', message: { id: 'm', model: 'x' } }
    expect(
      readMessageEvent({ ...base, message: { ...base.message, usage: validUsage } })
    ).toMatchObject({ message: { usage: validUsage } })
    expect(
      readMessageEvent({
        ...base,
        message: {
          ...base.message,
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
          },
        },
      })
    ).toMatchObject({ message: { usage: undefined } })
    expect(
      readMessageEvent({
        ...base,
        message: {
          ...base.message,
          usage: {
            input_tokens: NaN,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 4,
          },
        },
      })
    ).toMatchObject({ message: { usage: undefined } })
  })
})

describe('readMessageEvent text 块', () => {
  it('合法 text 块只返回 type/index/content_block 三个字段', () => {
    expect(blockStart({ type: 'text', text: 'hello' })).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: 'hello' },
    })
  })

  it('citations 过滤掉不合法项，保留合法项', () => {
    const good = {
      type: 'web_search_result_location',
      url: 'https://a.example',
      title: null,
      cited_text: '引用',
      encrypted_index: '',
    }
    const badUrl = { type: 'web_search_result_location', url: 123, title: null }
    const wrongType = { type: 'other', url: 'https://b.example', title: null }
    expect(blockStart({ type: 'text', text: '正文', citations: [good, badUrl, wrongType] })).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '正文', citations: [good] },
    })
  })

  it('citations 非数组时得到空数组，未给出时不添加 citations 键', () => {
    expect(blockStart({ type: 'text', text: 'x', citations: 'bad' })).toMatchObject({
      content_block: { citations: [] },
    })
    const result = blockStart({ type: 'text', text: 'x' })
    expect(result).not.toHaveProperty('content_block.citations')
  })

  it('text 不是字符串时返回 null', () => {
    expect(blockStart({ type: 'text', text: 123 })).toBeNull()
    expect(blockStart({ type: 'text' })).toBeNull()
  })
})

describe('readMessageEvent thinking 块与下标校验', () => {
  it('thinking 块保留字符串 signature', () => {
    expect(blockStart({ type: 'thinking', thinking: '思考', signature: 'sig' })).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '思考', signature: 'sig' },
    })
  })

  it('signature 缺失或非法时为 undefined，thinking 缺失时返回 null', () => {
    expect(blockStart({ type: 'thinking', thinking: '思考' })).toMatchObject({
      content_block: { signature: undefined },
    })
    expect(blockStart({ type: 'thinking', thinking: '思考', signature: 123 })).toMatchObject({
      content_block: { signature: undefined },
    })
    expect(blockStart({ type: 'thinking', thinking: 123 })).toBeNull()
    expect(blockStart({ type: 'thinking' })).toBeNull()
  })

  it('index 必须是非负安全整数', () => {
    expect(blockStart({ type: 'text', text: 'x' }, 0)).not.toBeNull()
    for (const index of [-1, 1.2, '0', NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(blockStart({ type: 'text', text: 'x' }, index as number)).toBeNull()
      expect(readMessageEvent({ type: 'content_block_stop', index })).toBeNull()
    }
    expect(readMessageEvent({ type: 'content_block_stop', index: undefined })).toBeNull()
  })
})

describe('readMessageEvent server_tool_use 块', () => {
  const base = {
    type: 'server_tool_use',
    id: 'srv1',
    name: 'deepseek_web_search',
    caller: { type: 'direct' },
  }

  it('search action 的 queries 为字符串数组时通过', () => {
    const tool = { ...base, kind: 'search', input: { action: 'search', queries: ['a', 'b'] } }
    expect(blockStart(tool)).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: tool,
    })
  })

  it('open_page / read_link / find_in_page 的必填字段校验', () => {
    expect(
      blockStart({ ...base, kind: 'read_link', input: { action: 'open_page', url: 'https://x' } })
    ).not.toBeNull()
    expect(
      blockStart({ ...base, kind: 'read_link', input: { action: 'read_link', url: 'https://x' } })
    ).not.toBeNull()
    expect(
      blockStart({
        ...base,
        kind: 'deep_search',
        input: { action: 'find_in_page', url: 'u', pattern: 'p' },
      })
    ).not.toBeNull()
    expect(blockStart({ ...base, kind: 'search', input: { action: 'open_page' } })).toBeNull()
    expect(
      blockStart({ ...base, kind: 'search', input: { action: 'find_in_page', url: 'u' } })
    ).toBeNull()
    expect(blockStart({ ...base, kind: 'search', input: { action: 'unknown' } })).toBeNull()
    expect(
      blockStart({ ...base, kind: 'search', input: { action: 'search', queries: ['a', 2] } })
    ).toBeNull()
  })

  it('id / kind / name / input 非法时返回 null', () => {
    expect(blockStart({ ...base, id: 123, kind: 'search', input: { action: 'search', queries: [] } })).toBeNull()
    expect(blockStart({ ...base, kind: 'bad', input: { action: 'search', queries: [] } })).toBeNull()
    expect(blockStart({ ...base, name: 'bad', kind: 'search', input: { action: 'search', queries: [] } })).toBeNull()
    expect(blockStart({ ...base, input: 'x', kind: 'search' })).toBeNull()
  })
})

describe('readMessageEvent web_search_tool_result 块', () => {
  it('过滤 content 中的非法项，保留合法结果与带 error_code 的错误项', () => {
    const result = {
      type: 'web_search_result',
      title: 'T',
      url: 'https://x',
      snippet: null,
      site_name: null,
      site_icon: null,
      page_age: null,
    }
    const error = { type: 'web_search_tool_result_error', error_code: 'unavailable' }
    const bad = { type: 'web_search_result', url: 'u', title: 123 }
    const block = { type: 'web_search_tool_result', tool_use_id: 't', kind: 'search', content: [result, error, bad] }
    expect(blockStart(block)).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { ...block, content: [result, error] },
    })
  })

  it('错误项缺少 error_code 时被丢弃', () => {
    const block = {
      type: 'web_search_tool_result',
      tool_use_id: 't',
      kind: 'search',
      content: [{ type: 'web_search_tool_result_error' }],
    }
    expect(blockStart(block)).toMatchObject({ content_block: { content: [] } })
  })

  it('tool_use_id / kind / content 非法时返回 null', () => {
    expect(blockStart({ type: 'web_search_tool_result', kind: 'search', content: [] })).toBeNull()
    expect(
      blockStart({ type: 'web_search_tool_result', tool_use_id: 't', kind: 'read_link', content: [] })
    ).toBeNull()
    expect(
      blockStart({ type: 'web_search_tool_result', tool_use_id: 't', kind: 'search', content: 'x' })
    ).toBeNull()
  })
})

describe('readMessageEvent web_fetch_tool_result 块', () => {
  it('合法成功结果原样保留，包括 signature', () => {
    const block = {
      type: 'web_fetch_tool_result',
      tool_use_id: 't',
      kind: 'read_link',
      signature: 'sig',
      content: {
        type: 'web_fetch_result',
        url: 'https://x',
        content: { type: 'document', title: null, source: { type: 'text', data: '' } },
        published_at: null,
      },
    }
    expect(blockStart(block)).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: block,
    })
  })

  it('合法错误结果通过，signature 置为 undefined', () => {
    const block = {
      type: 'web_fetch_tool_result',
      tool_use_id: 't',
      kind: 'deep_search',
      content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
    }
    expect(blockStart(block)).toMatchObject({
      content_block: { content: block.content, signature: undefined },
    })
  })

  it('非法 tool_use_id / kind / content 形态返回 null', () => {
    expect(
      blockStart({
        type: 'web_fetch_tool_result',
        kind: 'read_link',
        content: { type: 'web_fetch_tool_result_error', error_code: 'x' },
      })
    ).toBeNull()
    expect(
      blockStart({
        type: 'web_fetch_tool_result',
        tool_use_id: 't',
        kind: 'search',
        content: { type: 'web_fetch_tool_result_error', error_code: 'x' },
      })
    ).toBeNull()
    expect(
      blockStart({
        type: 'web_fetch_tool_result',
        tool_use_id: 't',
        kind: 'read_link',
        content: { type: 'web_fetch_tool_result_error' },
      })
    ).toBeNull()
    expect(blockStart({ type: 'web_fetch_tool_result', tool_use_id: 't', kind: 'read_link', content: 'x' })).toBeNull()
  })

  it('成功结果的 url / title / published_at 必须是合法类型', () => {
    const ok = {
      type: 'web_fetch_tool_result',
      tool_use_id: 't',
      kind: 'read_link',
      content: {
        type: 'web_fetch_result',
        url: 'u',
        content: { type: 'document', title: null },
        published_at: null,
      },
    }
    expect(blockStart(ok)).not.toBeNull()
    expect(
      blockStart({ ...ok, content: { ...ok.content, url: 123 } })
    ).toBeNull()
    expect(
      blockStart({ ...ok, content: { ...ok.content, content: { type: 'document', title: 123 } } })
    ).toBeNull()
    expect(blockStart({ ...ok, content: { ...ok.content, published_at: 123 } })).toBeNull()
  })
})

describe('readMessageEvent tool_use 块', () => {
  it('客户端工具块不展示内容但原样透传，交给归并层处理', () => {
    const tool = { type: 'tool_use', id: 'call1', name: 'f', input: {} }
    expect(blockStart(tool)).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: tool,
    })
  })
})

describe('readMessageEvent content_block_delta', () => {
  it('text_delta / thinking_delta / signature_delta 合法时通过', () => {
    expect(blockDelta({ type: 'text_delta', text: 'a' })).toEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'a' },
    })
    expect(blockDelta({ type: 'thinking_delta', thinking: '思' })).not.toBeNull()
    expect(blockDelta({ type: 'signature_delta', signature: 'sig' })).not.toBeNull()
  })

  it('delta 的正文必须是字符串', () => {
    expect(blockDelta({ type: 'text_delta', text: 1 })).toBeNull()
    expect(blockDelta({ type: 'text_delta' })).toBeNull()
    expect(blockDelta({ type: 'thinking_delta' })).toBeNull()
    expect(blockDelta({ type: 'signature_delta' })).toBeNull()
  })

  it('citations_delta 只在 citation 合法时通过', () => {
    expect(
      blockDelta({
        type: 'citations_delta',
        citation: { type: 'web_search_result_location', url: 'u', title: null },
      })
    ).not.toBeNull()
    expect(
      blockDelta({ type: 'citations_delta', citation: { type: 'web_search_result_location', title: null } })
    ).toBeNull()
    expect(blockDelta({ type: 'citations_delta' })).toBeNull()
  })

  it('未知 delta 类型与非法 index 返回 null', () => {
    expect(blockDelta({ type: 'unknown', text: 'a' })).toBeNull()
    expect(blockDelta(undefined)).toBeNull()
    expect(
      readMessageEvent({
        type: 'content_block_delta',
        index: -1,
        delta: { type: 'text_delta', text: 'a' },
      })
    ).toBeNull()
  })
})

describe('readMessageEvent message_delta', () => {
  it('合法 stop_reason 时透传并规范化 title 与 usage', () => {
    const event = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null, title: '标题' },
      usage: validUsage,
      extra: 'keep',
    }
    expect(readMessageEvent(event)).toEqual(event)
  })

  it('title 非字符串置为 undefined，usage 非法置为 undefined', () => {
    const result = readMessageEvent({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', title: 123 },
      usage: { input_tokens: 1 },
    })
    expect(result).toMatchObject({ delta: { stop_reason: 'tool_use', title: undefined }, usage: undefined })
  })

  it('stop_reason 非法或缺失时返回 null', () => {
    for (const stop_reason of ['bad', 'END_TURN', null, undefined]) {
      expect(readMessageEvent({ type: 'message_delta', delta: { stop_reason } })).toBeNull()
    }
    expect(readMessageEvent({ type: 'message_delta' })).toBeNull()
    expect(readMessageEvent({ type: 'message_delta', delta: 'x' })).toBeNull()
  })

  it('content_block_stop 合法时原样透传', () => {
    expect(readMessageEvent({ type: 'content_block_stop', index: 2, extra: true })).toEqual({
      type: 'content_block_stop',
      index: 2,
      extra: true,
    })
  })
})
