import { describe, it, expect } from 'vitest'
import {
  applyEvent,
  settleReply,
  getReplyText,
  getReplyThinking,
  getReplyAnswerText,
  rewriteReplyBlocks,
  canContinueReply,
  getContextRounds,
  toRequestMessages,
  getThinkingSeconds,
} from './reply.js'
import type { AssistantMessage, FileAttachment, Message, ReplyBlock, UserMessage } from './types.js'
import type {
  ContentBlockDelta,
  MessageStreamEvent,
  MessageUsage,
  OutputBlockStart,
  TextCitation,
} from '../api/types.js'

const usage = (output = 0): MessageUsage => ({
  input_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: output,
})

const user = (id: string, extra: Partial<UserMessage> = {}): UserMessage => ({
  id,
  role: 'user',
  content: `q-${id}`,
  files: [],
  createdAt: 0,
  ...extra,
})

const assistant = (id: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: 0,
  model: null,
  prefix: true,
  status: 'done',
  blocks: [],
  ...extra,
})

const cite = (url = 'https://a'): TextCitation => ({
  type: 'web_search_result_location',
  url,
  title: null,
  cited_text: 'cited',
  encrypted_index: '',
})

const start = (index: number, content_block: OutputBlockStart): MessageStreamEvent => ({
  type: 'content_block_start',
  index,
  content_block,
})

const delta = (index: number, d: ContentBlockDelta): MessageStreamEvent => ({
  type: 'content_block_delta',
  index,
  delta: d,
})

describe('applyEvent', () => {
  it('message_start 切换为 streaming 并写入 usage；缺省 usage 时保留旧值', () => {
    const next = applyEvent(
      assistant('a1', { status: 'pending' }),
      { type: 'message_start', message: { id: 'm', model: 'deepseek-chat', usage: usage(5) } },
      100,
      new Map()
    )
    expect(next.status).toBe('streaming')
    expect(next.usage).toEqual(usage(5))

    const kept = applyEvent(
      assistant('a2', { usage: usage(3) }),
      { type: 'message_start', message: { id: 'm', model: 'x' } },
      100,
      new Map()
    )
    expect(kept.usage).toEqual(usage(3))
  })

  it('content_block_start 追加文本块并记录临时索引', () => {
    const indexes = new Map<number, number>()
    const next = applyEvent(
      assistant('a1', { status: 'pending' }),
      start(2, { type: 'text', text: 'Hello' }),
      100,
      indexes
    )
    expect(next.status).toBe('streaming')
    expect(next.blocks).toEqual([{ type: 'text', text: 'Hello', citations: [] }])
    expect(indexes.get(2)).toBe(0)
  })

  it('content_block_start 重新开始时删除旧索引映射', () => {
    const indexes = new Map<number, number>()
    indexes.set(0, 3)
    applyEvent(assistant('a1'), start(0, { type: 'text', text: 'A' }), 0, indexes)
    expect(indexes.get(0)).toBe(0)
  })

  it('text_delta 追加正文，未知索引的增量被忽略', () => {
    const indexes = new Map<number, number>()
    let reply = applyEvent(assistant('a1'), start(2, { type: 'text', text: 'Hi' }), 0, indexes)
    reply = applyEvent(reply, delta(2, { type: 'text_delta', text: ' there' }), 0, indexes)
    expect(getReplyText(reply)).toBe('Hi there')

    const before = reply
    reply = applyEvent(reply, delta(9, { type: 'text_delta', text: 'IGNORED' }), 0, indexes)
    expect(reply).toBe(before)
  })

  it('thinking_delta 与 signature_delta 累积到思考块并记录 startedAt', () => {
    const indexes = new Map<number, number>()
    let reply = applyEvent(
      assistant('a1'),
      start(0, { type: 'thinking', thinking: '', signature: '' }),
      1000,
      indexes
    )
    expect(reply.blocks[0]).toMatchObject({ type: 'thinking', startedAt: 1000 })

    reply = applyEvent(reply, delta(0, { type: 'thinking_delta', thinking: '分析' }), 1000, indexes)
    reply = applyEvent(reply, delta(0, { type: 'signature_delta', signature: 'sig-' }), 1000, indexes)
    reply = applyEvent(reply, delta(0, { type: 'signature_delta', signature: 'x' }), 1000, indexes)
    expect(reply.blocks[0]).toMatchObject({ thinking: '分析', signature: 'sig-x' })
  })

  it('citations_delta 追加引用，保留起始块已有的引用', () => {
    const indexes = new Map<number, number>()
    let reply = applyEvent(
      assistant('a1'),
      start(0, { type: 'text', text: 'A', citations: [cite('u1')] }),
      0,
      indexes
    )
    reply = applyEvent(reply, delta(0, { type: 'citations_delta', citation: cite('u2') }), 0, indexes)
    const block = reply.blocks[0]
    expect(block.type).toBe('text')
    if (block.type === 'text') {
      expect(block.citations?.map((c) => c.url)).toEqual(['u1', 'u2'])
    }
  })

  it('tool_use 起始块被保存，input_json_delta 累积到 inputText', () => {
    const indexes = new Map<number, number>()
    let reply = applyEvent(
      assistant('a1'),
      start(0, { type: 'tool_use', id: 't1', name: 'calc', input: {} }),
      0,
      indexes
    )
    expect(reply.blocks[0]).toEqual({ type: 'tool_use', id: 't1', name: 'calc', input: {} })
    // 未完成的工具往返不能作为续写前缀
    expect(reply.prefix).toBe(false)

    reply = applyEvent(reply, delta(0, { type: 'input_json_delta', partial_json: '{"a":' }), 0, indexes)
    reply = applyEvent(reply, delta(0, { type: 'input_json_delta', partial_json: '1}' }), 0, indexes)
    expect(reply.blocks[0]).toMatchObject({ inputText: '{"a":1}' })
  })

  it('服务端工具块按原样保存', () => {
    const toolUse: OutputBlockStart = {
      type: 'server_tool_use',
      id: 'srv1',
      name: 'deepseek_web_search',
      input: { action: 'search', queries: ['q'] },
      caller: { type: 'direct' },
      kind: 'search',
    }
    const result: OutputBlockStart = {
      type: 'web_fetch_tool_result',
      tool_use_id: 'srv1',
      kind: 'read_link',
      content: {
        type: 'web_fetch_result',
        url: 'https://a',
        content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '' }, title: null },
        published_at: null,
      },
      signature: 'sig',
    }
    let reply = applyEvent(assistant('a1'), start(0, toolUse), 0, new Map())
    reply = applyEvent(reply, start(1, result), 0, new Map())
    expect(reply.blocks[0]).toBe(toolUse)
    expect(reply.blocks[1]).toBe(result)
  })

  it('content_block_stop 为未结束的思考块写入 endedAt 并清除索引', () => {
    const indexes = new Map<number, number>()
    let reply = applyEvent(
      assistant('a1'),
      start(0, { type: 'thinking', thinking: '', signature: '' }),
      1000,
      indexes
    )
    reply = applyEvent(reply, { type: 'content_block_stop', index: 0 }, 5000, indexes)
    expect(reply.blocks[0]).toMatchObject({ endedAt: 5000 })
    expect(indexes.has(0)).toBe(false)

    const before = reply
    reply = applyEvent(reply, delta(0, { type: 'thinking_delta', thinking: 'late' }), 6000, indexes)
    expect(reply).toBe(before)
  })

  it('content_block_stop 不影响文本块', () => {
    const indexes = new Map<number, number>()
    let reply = applyEvent(assistant('a1'), start(0, { type: 'text', text: 'A' }), 100, indexes)
    reply = applyEvent(reply, { type: 'content_block_stop', index: 0 }, 200, indexes)
    expect(reply.blocks[0]).toEqual({ type: 'text', text: 'A', citations: [] })
  })

  it('message_delta 更新结束原因、明细与累计用量', () => {
    let reply = applyEvent(
      assistant('a1'),
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: usage(42),
      },
      0,
      new Map()
    )
    expect(reply.stopReason).toBe('end_turn')
    expect(reply.usage).toEqual(usage(42))

    const details = { type: 'refusal' as const, category: null, explanation: null }
    reply = applyEvent(
      reply,
      { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: details } },
      0,
      new Map()
    )
    expect(reply.stopDetails).toEqual(details)
  })

  it('message_stop / ping 等事件不改变内容但切换为 streaming', () => {
    const reply = applyEvent(assistant('a1', { status: 'pending' }), { type: 'message_stop' }, 0, new Map())
    expect(reply.status).toBe('streaming')
    expect(reply.blocks).toEqual([])
    expect(applyEvent(reply, { type: 'ping' }, 0, new Map())).toBe(reply)
  })
})

describe('settleReply', () => {
  it('结束回复并为未结束的思考块收尾，保留已结束的块', () => {
    const blocks: ReplyBlock[] = [
      { type: 'thinking', thinking: 't', startedAt: 100 },
      { type: 'thinking', thinking: 'done', startedAt: 50, endedAt: 80 },
      { type: 'text', text: 'A', citations: [] },
    ]
    const result = settleReply(assistant('a1', { blocks }), 'done', 999)

    expect(result.status).toBe('done')
    expect(result.blocks[0]).toMatchObject({ endedAt: 999 })
    expect(result.blocks[1]).toMatchObject({ endedAt: 80 })
    expect(result.blocks[2]).toEqual({ type: 'text', text: 'A', citations: [] })
  })

  it('可写入错误对象并设置为 stopped', () => {
    const error = { kind: 'network' as const, message: 'oops' }
    const result = settleReply(assistant('a1'), 'stopped', 0, error)
    expect(result.status).toBe('stopped')
    expect(result.error).toEqual(error)
  })

  it('拒答不做特殊处理，正文和思考原样保留', () => {
    const blocks: ReplyBlock[] = [
      { type: 'thinking', thinking: 'T' },
      { type: 'text', text: 'A', citations: [] },
    ]
    const result = settleReply(assistant('a1', { blocks, stopReason: 'refusal' }), 'error', 0)
    expect(result.blocks).toEqual(blocks)
    expect(result.status).toBe('error')
  })
})

describe('文本提取', () => {
  it('getReplyText 拼接所有文本块，getReplyThinking 以空行连接思考块', () => {
    const blocks: ReplyBlock[] = [
      { type: 'thinking', thinking: 'T1' },
      { type: 'text', text: 'A' },
      { type: 'tool_use', id: 't', name: 'n', input: {} },
      { type: 'thinking', thinking: 'T2' },
      { type: 'text', text: 'B' },
      { type: 'text', text: 'C' },
    ]
    const reply = assistant('a1', { blocks })
    expect(getReplyText(reply)).toBe('ABC')
    expect(getReplyThinking(reply)).toBe('T1\n\nT2')
    expect(getReplyAnswerText(reply)).toBe('BC')
  })

  it('getReplyAnswerText 只取末尾连续正文段，模板提示会终止该段', () => {
    const withTrailingTemplate: ReplyBlock[] = [
      { type: 'text', text: 'keep' },
      { type: 'text', text: 'TIP', isTemplate: true },
    ]
    expect(getReplyAnswerText(assistant('a1', { blocks: withTrailingTemplate }))).toBe('')

    const withLeadingTemplate: ReplyBlock[] = [
      { type: 'text', text: 'TIP', isTemplate: true },
      { type: 'text', text: 'real' },
    ]
    expect(getReplyAnswerText(assistant('a2', { blocks: withLeadingTemplate }))).toBe('real')
  })
})

describe('rewriteReplyBlocks', () => {
  it('改写思维链：写入第一个思考块，清空其余块的思考与签名', () => {
    const blocks: ReplyBlock[] = [
      { type: 'thinking', thinking: 'a', signature: 's1' },
      { type: 'thinking', thinking: 'b', signature: 's2' },
      { type: 'text', text: 'ans', citations: [cite()] },
    ]
    const out = rewriteReplyBlocks(blocks, { thinking: 'Z', text: 'ans' })

    expect(out[0]).toMatchObject({ type: 'thinking', thinking: 'Z', signature: 's1' })
    expect(out[1]).toMatchObject({ type: 'thinking', thinking: '', signature: undefined })
    expect(out[2]).toBe(blocks[2])
  })

  it('改写正文：写入末尾正文段首块并清除引用，其余正文块清空', () => {
    const tool: ReplyBlock = { type: 'tool_use', id: 't1', name: 'calc', input: {} }
    const template: ReplyBlock = { type: 'text', text: 'TIP', isTemplate: true }
    const blocks: ReplyBlock[] = [
      tool,
      template,
      { type: 'text', text: 'old', citations: [cite('u1')] },
      { type: 'text', text: 'more', citations: [cite('u2')] },
    ]
    const out = rewriteReplyBlocks(blocks, { thinking: '', text: 'NEW' })

    expect(out[0]).toBe(tool)
    expect(out[1]).toBe(template)
    expect(out[2]).toEqual({ type: 'text', text: 'NEW', citations: [] })
    expect(out[3]).toEqual({ type: 'text', text: '', citations: [] })
  })

  it('没有思考块且有新思维链时在最前新建思考块', () => {
    const blocks: ReplyBlock[] = [{ type: 'tool_use', id: 't', name: 'n', input: {} }]
    const out = rewriteReplyBlocks(blocks, { thinking: 'T', text: '' })
    expect(out[0]).toEqual({ type: 'thinking', thinking: 'T' })
    expect(out).toHaveLength(2)
    expect(out[1]).toBe(blocks[0])
  })

  it('没有末尾正文段且有新正文时在末尾追加文本块', () => {
    const blocks: ReplyBlock[] = [{ type: 'tool_use', id: 't', name: 'n', input: {} }]
    const out = rewriteReplyBlocks(blocks, { thinking: '', text: 'NEW' })
    expect(out[out.length - 1]).toEqual({ type: 'text', text: 'NEW' })
    expect(out).toHaveLength(2)
  })

  it('内容未变化或新思维链仅为空白时返回原数组', () => {
    const blocks: ReplyBlock[] = [{ type: 'text', text: 'A', citations: [] }]
    expect(rewriteReplyBlocks(blocks, { thinking: '', text: 'A' })).toBe(blocks)
    expect(rewriteReplyBlocks(blocks, { thinking: '   ', text: 'A' })).toBe(blocks)
  })
})

describe('canContinueReply', () => {
  it('前缀关闭、拒答、工具调用结束或非允许状态时不可续写', () => {
    expect(canContinueReply(assistant('a', { prefix: false, status: 'stopped' }))).toBe(false)
    expect(canContinueReply(assistant('a', { status: 'done', stopReason: 'refusal' }))).toBe(false)
    expect(canContinueReply(assistant('a', { status: 'done', stopReason: 'tool_use' }))).toBe(false)
    expect(canContinueReply(assistant('a', { status: 'done', stopReason: 'end_turn' }))).toBe(false)
    expect(canContinueReply(assistant('a', { status: 'error', stopReason: 'max_tokens' }))).toBe(false)
    expect(canContinueReply(assistant('a', { status: 'pending', stopReason: 'max_tokens' }))).toBe(false)
  })

  it('服务端工具块与模板提示块禁止续写', () => {
    const blocks: ReplyBlock[] = [
      { type: 'server_tool_use', id: 's', name: 'deepseek_web_search', input: { action: 'search', queries: ['q'] }, caller: { type: 'direct' }, kind: 'search' },
      { type: 'web_search_tool_result', tool_use_id: 's', content: [], kind: 'search' },
      { type: 'web_fetch_tool_result', tool_use_id: 's', content: { type: 'web_fetch_tool_result_error', error_code: 'unavailable' }, kind: 'read_link' },
      { type: 'text', text: 'TIP', isTemplate: true },
    ]
    for (const block of blocks) {
      expect(canContinueReply(assistant('a', { status: 'stopped', blocks: [block] }))).toBe(false)
    }
  })

  it('停止的回复与达到输出上限的回复可以续写，客户端工具块不阻止', () => {
    expect(canContinueReply(assistant('a', { status: 'stopped' }))).toBe(true)
    expect(canContinueReply(assistant('a', { status: 'done', stopReason: 'max_tokens' }))).toBe(true)
    expect(
      canContinueReply(
        assistant('a', { status: 'stopped', blocks: [{ type: 'tool_use', id: 't', name: 'n', input: {} }] })
      )
    ).toBe(true)
  })
})

describe('getContextRounds', () => {
  it('只保留提问后紧跟可用回答的轮次', () => {
    const good = assistant('a1', {
      status: 'done',
      stopReason: 'end_turn',
      blocks: [{ type: 'text', text: 'ans', citations: [] }],
    })
    const refused = assistant('a2', { status: 'done', stopReason: 'refusal', blocks: [{ type: 'text', text: 'ans', citations: [] }] })
    const empty = assistant('a3', { status: 'done', blocks: [] })
    const errored = assistant('a4', { status: 'error', blocks: [{ type: 'text', text: 'ans', citations: [] }] })
    const templateOnly = assistant('a5', { status: 'done', blocks: [{ type: 'text', text: 'TIP', isTemplate: true }] })

    const history: Message[] = [
      user('u1'), good,
      user('u2'), refused,
      user('u3'), empty,
      user('u4'), errored,
      user('u5'), templateOnly,
    ]
    expect(getContextRounds(history).map(([u]) => u.id)).toEqual(['u1'])
  })
})

describe('toRequestMessages', () => {
  it('组装历史轮次与本轮提问，requestContext 拼接在正文前、引用被去掉', () => {
    const history: Message[] = [
      user('u1', { content: 'Q1', requestContext: 'CTX' }),
      assistant('a1', { status: 'done', stopReason: 'end_turn', blocks: [{ type: 'text', text: 'A1', citations: [cite()] }] }),
    ]
    const messages = toRequestMessages(history, user('u2', { content: 'Q2' }))

    expect(messages).toEqual([
      { role: 'user', content: 'CTX\n\nQ1' },
      { role: 'assistant', content: [{ type: 'text', text: 'A1' }] },
      { role: 'user', content: 'Q2' },
    ])
  })

  it('每一轮及本轮各自带上 latest_reminder，不去重', () => {
    const history: Message[] = [
      user('u1'),
      assistant('a1', { status: 'done', blocks: [{ type: 'text', text: 'A1', citations: [] }], latestReminder: 'R1' }),
      user('u2'),
      assistant('a2', { status: 'done', blocks: [{ type: 'text', text: 'A2', citations: [] }], latestReminder: 'R2' }),
    ]
    const messages = toRequestMessages(history, user('u3'), undefined, false, 'R3')

    expect(messages.map((m) => m.role)).toEqual([
      'latest_reminder', 'user', 'assistant',
      'latest_reminder', 'user', 'assistant',
      'latest_reminder', 'user',
    ])
    expect(messages.filter((m) => m.role === 'latest_reminder').map((m) => m.content)).toEqual(['R1', 'R2', 'R3'])
  })

  it('文件按 serverId 生成 image/document 块，null 的附件不进入请求', () => {
    const files: FileAttachment[] = [
      { id: 'f1', serverId: 'srv1', name: 'p.png', size: 1, isImage: true, mimeType: 'image/png' },
      { id: 'f2', serverId: 'srv2', name: 'd.pdf', size: 1, isImage: false, mimeType: 'application/pdf' },
      { id: 'f3', serverId: null, name: 'local.txt', size: 1, isImage: false, mimeType: 'text/plain' },
    ]
    const messages = toRequestMessages([], user('u1', { content: '看这些', files }))

    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'file', file_id: 'srv1' } },
        { type: 'document', source: { type: 'file', file_id: 'srv2' } },
        { type: 'text', text: '看这些' },
      ],
    })

    const noText = toRequestMessages([], user('u2', { content: '', files: [files[0]] }))
    expect(noText[0]).toEqual({
      role: 'user',
      content: [{ type: 'image', source: { type: 'file', file_id: 'srv1' } }],
    })
  })

  it('历史提问为空且无有效附件时，连同回答一起省略', () => {
    const history: Message[] = [
      user('u1', { content: '', files: [{ id: 'f', serverId: null, name: 'x', size: 0, isImage: false, mimeType: '' }] }),
      assistant('a1', { status: 'done', blocks: [{ type: 'text', text: 'A1', citations: [] }] }),
    ]
    const messages = toRequestMessages(history, user('u2', { content: 'Q' }))
    expect(messages.map((m) => m.role)).toEqual(['user'])
  })

  it('续写前缀带上本轮思考与正文', () => {
    const prefix = assistant('a1', {
      prefix: true,
      thinking: true,
      status: 'done',
      stopReason: 'max_tokens',
      blocks: [
        { type: 'thinking', thinking: 'T', signature: 'sig' },
        { type: 'text', text: 'PART', citations: [] },
      ],
    })
    const messages = toRequestMessages([], user('u1', { content: 'Q' }), prefix, true)

    expect(messages).toEqual([
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'T', signature: 'sig' },
        { type: 'text', text: 'PART' },
      ] },
    ])
  })

  it('续写前缀没有有效正文或思考时只重发提问', () => {
    const blank = assistant('a1', { prefix: true, blocks: [{ type: 'thinking', thinking: '   ' }] })
    expect(toRequestMessages([], user('u1'), blank, true).map((m) => m.role)).toEqual(['user'])

    const disabled = assistant('a2', { prefix: false, blocks: [{ type: 'text', text: 'PART', citations: [] }] })
    expect(toRequestMessages([], user('u2'), disabled).map((m) => m.role)).toEqual(['user'])
  })

  it('历史思考被省略后仍保留前后正文的空行', () => {
    const history: Message[] = [
      user('u1'),
      assistant('a1', {
        status: 'done',
        blocks: [
          { type: 'text', text: 'A', citations: [] },
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'B', citations: [] },
        ],
      }),
    ]
    const messages = toRequestMessages(history, user('u2'))
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'A' }, { type: 'text', text: '\n\nB' }],
    })
  })

  it('仅回传带签名的 read_link 调用与结果，缺签名时两者都丢弃', () => {
    const signedResult: ReplyBlock = {
      type: 'web_fetch_tool_result',
      tool_use_id: 'srv1',
      kind: 'read_link',
      content: {
        type: 'web_fetch_result',
        url: 'https://a',
        content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '' }, title: null },
        published_at: null,
      },
      signature: 'sig',
    }
    const unsignedResult: ReplyBlock = {
      ...signedResult,
      tool_use_id: 'srv2',
      signature: '',
    }
    const history: Message[] = [
      user('u1'),
      assistant('a1', {
        status: 'done',
        blocks: [
          { type: 'text', text: 'intro', citations: [] },
          { type: 'server_tool_use', id: 'srv1', name: 'deepseek_read_url', input: { action: 'read_link', url: 'https://a' }, caller: { type: 'direct' }, kind: 'read_link' },
          signedResult,
        ],
      }),
      user('u2'),
      assistant('a2', {
        status: 'done',
        blocks: [
          { type: 'text', text: 'intro2', citations: [] },
          { type: 'server_tool_use', id: 'srv2', name: 'deepseek_read_url', input: { action: 'read_link', url: 'https://b' }, caller: { type: 'direct' }, kind: 'read_link' },
          unsignedResult,
        ],
      }),
    ]
    const messages = toRequestMessages(history, user('u9'))

    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'intro' },
        { type: 'server_tool_use', id: 'srv1', name: 'deepseek_read_url', input: { action: 'read_link', url: 'https://a' }, kind: 'read_link' },
        signedResult,
      ],
    })
    expect(messages[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'intro2' }] })
  })
})

describe('getThinkingSeconds', () => {
  it('至少 1 秒并四舍五入', () => {
    expect(getThinkingSeconds(0, 0)).toBe(1)
    expect(getThinkingSeconds(1000, 3200)).toBe(2)
    expect(getThinkingSeconds(1000, 3700)).toBe(3)
    expect(getThinkingSeconds(5000, 1000)).toBe(1)
  })
})
