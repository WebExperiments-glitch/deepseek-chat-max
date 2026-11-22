import { beforeEach, describe, expect, it } from 'vitest'
import type { MessageUsage } from '../api/types.js'
import type { AssistantMessage, Session, UserMessage } from './types.js'
import {
  aggregateSessionUsage,
  contextPercent,
  estimateRequestSurfaceTokens,
  findContextWindow,
  formatCacheHitPercent,
  formatTokens,
  noteContextUsage,
  projectedContextTokens,
  promptTokensOf,
  resolveContextWindow,
  useContextUsage,
  clearAllContextUsage,
  forgetContextUsage,
} from './usageStats.js'

const usage = (
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  extra: Partial<MessageUsage> = {}
): MessageUsage => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
  ...extra,
})

const user = (id: string): UserMessage => ({
  id,
  role: 'user',
  content: '问题',
  files: [],
  createdAt: 1,
})

const reply = (id: string, value?: MessageUsage): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: 2,
  model: null,
  prefix: true,
  status: 'done',
  blocks: [],
  ...(value ? { usage: value } : {}),
})

const session = (messages: (UserMessage | AssistantMessage)[]): Session => ({
  id: 's1',
  title: '会话',
  createdAt: 1,
  updatedAt: 2,
  messages,
})

describe('promptTokensOf', () => {
  it('把未命中、缓存读取与缓存写入相加', () => {
    expect(promptTokensOf(usage(100, 800, 20, 50))).toBe(920)
  })

  it('缺少缓存字段时按 0 处理', () => {
    expect(promptTokensOf(usage(100, 0, 0, 50))).toBe(100)
  })
})

describe('formatCacheHitPercent', () => {
  it('prompt 为 0 时返回 null', () => {
    expect(formatCacheHitPercent(0, 0)).toBeNull()
    expect(formatCacheHitPercent(10, 0)).toBeNull()
  })

  it('完全命中返回 100', () => {
    expect(formatCacheHitPercent(100, 100)).toBe('100')
    expect(formatCacheHitPercent(120, 100)).toBe('100')
  })

  it('普通部分命中按目标精度取整', () => {
    expect(formatCacheHitPercent(889, 1000)).toBe('89')
    expect(formatCacheHitPercent(889, 1000, 1)).toBe('88.9')
    expect(formatCacheHitPercent(1, 3)).toBe('33')
  })

  it('回归：默认精度下 9999/10000 不能显示成 100 或 100.0', () => {
    expect(formatCacheHitPercent(9999, 10000)).toBe('99.99')
  })

  it('回归：一位精度下 9999/10000 仍显示 99.99', () => {
    expect(formatCacheHitPercent(9999, 10000, 1)).toBe('99.99')
  })

  it('逼近完全命中时自适应增加小数位显示真实下界', () => {
    expect(formatCacheHitPercent(999999, 1000000)).toBe('99.9999')
    expect(formatCacheHitPercent(999999, 1000000, 1)).toBe('99.9999')
  })

  it('整数域计算避免浮点舍入误差', () => {
    // 1/2 在一位精度下是 50，不输出多余的 .0
    expect(formatCacheHitPercent(1, 2, 1)).toBe('50')
    // 2/3 在一位精度下四舍五入为 66.7
    expect(formatCacheHitPercent(2, 3, 1)).toBe('66.7')
    // 100000/300000 = 33.333...%，整数精度四舍五入为 33
    expect(formatCacheHitPercent(100000, 300000)).toBe('33')
  })

  it('非常接近 100 但不越界时保留两位小数', () => {
    expect(formatCacheHitPercent(9999, 10000)).toBe('99.99')
    expect(formatCacheHitPercent(9997, 10000)).toBe('99.97')
  })

  it('零命中返回 0', () => {
    expect(formatCacheHitPercent(0, 100)).toBe('0')
    expect(formatCacheHitPercent(0, 100, 1)).toBe('0')
  })
})

describe('formatTokens', () => {
  it('小于一千原样显示', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('千位保留一位小数', () => {
    expect(formatTokens(1000)).toBe('1.0k')
    expect(formatTokens(1234)).toBe('1.2k')
  })

  it('万位取整', () => {
    expect(formatTokens(12800)).toBe('13k')
    expect(formatTokens(99999)).toBe('100k')
  })

  it('十万位取整、百万位保留两位', () => {
    expect(formatTokens(100000)).toBe('100k')
    expect(formatTokens(517000)).toBe('517k')
    expect(formatTokens(1000000)).toBe('1.00M')
    expect(formatTokens(1200000)).toBe('1.20M')
  })
})

describe('resolveContextWindow', () => {
  it('优先使用模型清单给出的窗口', () => {
    expect(resolveContextWindow('deepseek-flash', 65536)).toBe(65536)
  })

  it('清单缺失时回落到已知 DeepSeek 模型', () => {
    expect(resolveContextWindow('deepseek-flash')).toBe(1048576)
    expect(resolveContextWindow('deepseek-v4-pro')).toBe(1048576)
  })

  it('未知模型返回 null', () => {
    expect(resolveContextWindow('some-custom-model')).toBeNull()
    expect(resolveContextWindow('deepseek-v4.1-flash')).toBeNull()
  })

  it('清单里的非正数视为未知', () => {
    expect(resolveContextWindow('deepseek-flash', 0)).toBe(1048576)
  })
})

describe('findContextWindow', () => {
  it('跨服务商按模型 id 查找', () => {
    const lists = {
      deepseek: [],
      opencode: [
        {
          id: 'gpt-5',
          label: 'GPT-5',
          contextWindow: 200000,
        },
      ],
    }
    expect(findContextWindow(lists, 'gpt-5')).toBe(200000)
  })

  it('找不到返回 null', () => {
    expect(findContextWindow({}, 'unknown')).toBeNull()
  })
})

describe('contextPercent', () => {
  it('按窗口折算并封顶 100', () => {
    expect(contextPercent(500, 1000)).toBe(50)
    expect(contextPercent(2000, 1000)).toBe(100)
  })

  it('窗口未知返回 null', () => {
    expect(contextPercent(500, null)).toBeNull()
    expect(contextPercent(500, 0)).toBeNull()
  })
})

describe('aggregateSessionUsage', () => {
  it('空会话返回全零且 cacheRate 为 null', () => {
    const totals = aggregateSessionUsage(null)
    expect(totals.rounds).toBe(0)
    expect(totals.cacheRate).toBeNull()
    expect(totals.prompt).toBe(0)
  })

  it('统计用户轮数与回复条数', () => {
    const totals = aggregateSessionUsage(
      session([user('u1'), reply('a1'), user('u2'), reply('a2')])
    )
    expect(totals.rounds).toBe(2)
    expect(totals.replies).toBe(2)
  })

  it('汇总用量与思考、安全审核明细', () => {
    const totals = aggregateSessionUsage(
      session([
        user('u1'),
        reply(
          'a1',
          usage(100, 800, 20, 200, {
            output_tokens_details: { thinking_tokens: 120, safety_tokens: 13 },
          })
        ),
      ])
    )
    expect(totals.inputUncached).toBe(100)
    expect(totals.cacheRead).toBe(800)
    expect(totals.cacheWrite).toBe(20)
    expect(totals.output).toBe(200)
    expect(totals.thinking).toBe(120)
    expect(totals.safety).toBe(13)
    expect(totals.prompt).toBe(920)
    expect(totals.cacheRate).toBeCloseTo(800 / 920)
  })

  it('搜索次数用 web_search_requests，不用计费查询数 tool_search', () => {
    const totals = aggregateSessionUsage(
      session([
        user('u1'),
        reply(
          'a1',
          usage(1, 0, 0, 1, {
            server_tool_use: { web_search_requests: 3, tool_search: 18, tool_fetch: 2 },
          })
        ),
      ])
    )
    // 3 次搜索调用含 18 个查询词，UI 显示「搜索 3 次」而非「18 次」
    expect(totals.searchRequests).toBe(3)
  })

  it('网页阅读次数用 web_fetch_requests，含深度思考搜索打开的网页', () => {
    const totals = aggregateSessionUsage(
      session([
        user('u1'),
        reply(
          'a1',
          usage(1, 0, 0, 1, {
            server_tool_use: { web_search_requests: 3, web_fetch_requests: 6, tool_fetch: 0 },
          })
        ),
      ])
    )
    // 深度思考搜索打开 6 个网页，即使 tool_fetch（计费）为 0 也要显示浏览了 6 次
    expect(totals.readRequests).toBe(6)
  })

  it('未上报用量的回复不参与统计', () => {
    const totals = aggregateSessionUsage(session([user('u1'), reply('a1')]))
    expect(totals.replies).toBe(1)
    expect(totals.prompt).toBe(0)
    expect(totals.cacheRate).toBeNull()
  })
})

describe('即时占用投影', () => {
  beforeEach(() => {
    clearAllContextUsage()
  })

  const messages = () => [user('u1'), reply('a1'), user('u2'), reply('a2')]

  it('估算请求表面时计入用户正文、动态上下文与助手文本块', () => {
    const s = session([
      { ...user('u1'), content: '你好世界', requestContext: '动态上下文' },
      { ...reply('a1'), blocks: [{ type: 'text', text: '回答内容', citations: [] }] },
    ])
    expect(estimateRequestSurfaceTokens(s)).toBeGreaterThan(0)
  })

  it('历史思考块不回传，不计入请求表面', () => {
    const withThinking = session([
      {
        ...reply('a1'),
        blocks: [
          { type: 'thinking', thinking: '很长很长的内部推理' },
          { type: 'text', text: '短', citations: [] },
        ],
      },
    ])
    const without = session([
      { ...reply('a1'), blocks: [{ type: 'text', text: '短', citations: [] }] },
    ])
    expect(estimateRequestSurfaceTokens(withThinking)).toBe(
      estimateRequestSurfaceTokens(without)
    )
  })

  it('压缩后请求表面下降', () => {
    const before = session(messages())
    const after = session(messages())
    after.compression = { summary: '摘要', upToMessageId: 'a1', rounds: 1, at: 1 }
    expect(estimateRequestSurfaceTokens(after)).toBeLessThan(
      estimateRequestSurfaceTokens(before)
    )
  })

  it('没有锚点时返回 0', () => {
    expect(projectedContextTokens('s1', session(messages()))).toBe(0)
  })

  it('锚点没有采样表面时诚实回退到锚点，不猜数字', () => {
    noteContextUsage('s1', usage(100, 0, 0, 10), 'deepseek-flash')
    expect(projectedContextTokens('s1', session(messages()))).toBe(100)
  })

  it('表面未变时返回锚点', () => {
    const s = session(messages())
    noteContextUsage(
      's1',
      usage(100, 0, 0, 10),
      'deepseek-flash',
      estimateRequestSurfaceTokens(s)
    )
    expect(projectedContextTokens('s1', s)).toBe(100)
  })

  it('压缩后即时回落且不为负', () => {
    const before = session(messages())
    noteContextUsage(
      's1',
      usage(50, 0, 0, 10),
      'deepseek-flash',
      estimateRequestSurfaceTokens(before)
    )
    const after = session(messages())
    after.compression = { summary: '摘要', upToMessageId: 'a1', rounds: 1, at: 1 }
    const projected = projectedContextTokens('s1', after)
    expect(projected).toBeLessThan(50)
    expect(projected).toBeGreaterThanOrEqual(0)
  })
})

describe('上下文用量记录', () => {
  beforeEach(() => {
    clearAllContextUsage()
  })

  it('记下 token 与模型', () => {
    noteContextUsage('s1', usage(100, 800, 20, 50), 'deepseek-flash')
    expect(useContextUsage.getState().byId['s1']).toMatchObject({
      tokens: 920,
      model: 'deepseek-flash',
    })
  })

  it('token 为 0 不记录', () => {
    noteContextUsage('s1', usage(0, 0, 0, 50))
    expect(useContextUsage.getState().byId['s1']).toBeUndefined()
  })

  it('同一会话只保留最新值', () => {
    noteContextUsage('s1', usage(100, 0, 0, 50))
    noteContextUsage('s1', usage(200, 0, 0, 50))
    expect(useContextUsage.getState().byId['s1'].tokens).toBe(200)
  })

  it('删除会话时清除对应记录', () => {
    noteContextUsage('s1', usage(100, 0, 0, 50))
    noteContextUsage('s2', usage(200, 0, 0, 50))
    forgetContextUsage('s1')
    expect(useContextUsage.getState().byId['s1']).toBeUndefined()
    expect(useContextUsage.getState().byId['s2'].tokens).toBe(200)
  })
})
