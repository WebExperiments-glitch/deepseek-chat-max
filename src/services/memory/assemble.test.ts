import { describe, expect, it } from 'vitest'
import type { MemoryBudget, MemoryEntry, MemoryKind } from './types.js'
import { renderMemoryBlock, selectMemories } from './assemble.js'
import { estimateTokens } from './tokenEstimate.js'

const budget = (overrides: Partial<MemoryBudget> = {}): MemoryBudget => ({
  maxEntries: 16,
  tokenBudget: 1800,
  ...overrides,
})

const entry = (id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  sourceSessionId: 's1',
  kind: 'fact',
  text: `第 ${id} 条：对方住在上海，在跨境电商公司工作`,
  keywords: ['上海', '跨境电商'],
  stability: 7,
  difficulty: 0.3,
  reps: 0,
  lapses: 0,
  createdAt: 0,
  lastReviewAt: 0,
  sourceMessageIds: [],
  pinned: false,
  archived: false,
  manual: false,
  importance: 0.5,
  ...overrides,
})

describe('selectMemories', () => {
  it('没有可用记忆时返回空结果', () => {
    const result = selectMemories([], '上海', budget(), 0, 'zh-CN')
    expect(result.selected).toHaveLength(0)
    expect(result.reviewed).toHaveLength(0)
    expect(result.block).toBe('')
  })

  it('归档条目不参与注入', () => {
    const result = selectMemories(
      [entry('a', { archived: true })],
      '上海',
      budget(),
      0,
      'zh-CN'
    )
    expect(result.selected).toHaveLength(0)
  })

  it('已归档但锁定的条目仍参与注入', () => {
    const result = selectMemories(
      [entry('a', { archived: true, pinned: true })],
      '上海',
      budget(),
      0,
      'zh-CN'
    )
    expect(result.selected.map((item) => item.id)).toEqual(['a'])
  })

  it('锁定条目进入核心记忆', () => {
    const result = selectMemories(
      [entry('a', { pinned: true, importance: 0.1 })],
      '无关话题',
      budget(),
      0,
      'zh-CN'
    )
    expect(result.selected.map((item) => item.id)).toEqual(['a'])
  })

  it('persona 类别进入核心记忆', () => {
    const result = selectMemories(
      [entry('a', { kind: 'persona' })],
      '无关话题',
      budget(),
      0,
      'zh-CN'
    )
    expect(result.selected.map((item) => item.id)).toEqual(['a'])
  })

  it('goal 长期目标进入核心记忆且与话题无关也保留', () => {
    const result = selectMemories(
      [entry('a', { kind: 'goal', importance: 0.5 })],
      '完全无关的话题',
      budget(),
      0,
      'zh-CN'
    )
    expect(result.selected.map((item) => item.id)).toEqual(['a'])
    expect(result.block).toContain('[长期目标与追求]')
  })

  it('重要性达到阈值的条目进入核心记忆', () => {
    const result = selectMemories(
      [entry('a', { importance: 0.9 })],
      '无关话题',
      budget(),
      0,
      'zh-CN'
    )
    expect(result.selected.map((item) => item.id)).toEqual(['a'])
  })

  it('核心预算不足时跳过非锁定条目', () => {
    const result = selectMemories(
      [entry('a', { importance: 0.9 }), entry('b', { importance: 0.86 })],
      '上海',
      budget({ tokenBudget: 60 }),
      0,
      'zh-CN'
    )
    expect(result.selected.some((item) => item.id === 'a')).toBe(true)
  })

  it('锁定条目不受预算限制', () => {
    const result = selectMemories(
      [entry('a', { pinned: true })],
      '上海',
      budget({ tokenBudget: 1 }),
      0,
      'zh-CN'
    )
    expect(result.selected.map((item) => item.id)).toEqual(['a'])
  })

  it('遵守 maxEntries 上限', () => {
    const entries = Array.from({ length: 20 }, (_, index) => entry(`m${index}`))
    const result = selectMemories(entries, '上海', budget({ maxEntries: 3 }), 0, 'zh-CN')
    expect(result.selected).toHaveLength(3)
  })

  it('每类记忆有注入上限', () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      entry(`p${index}`, { kind: 'preference' as MemoryKind })
    )
    const result = selectMemories(entries, '上海跨境电商', budget({ maxEntries: 30 }), 0, 'zh-CN')
    expect(result.selected).toHaveLength(8)
  })

  it('相关度太低且已有足够记忆时跳过', () => {
    const core = Array.from({ length: 4 }, (_, index) =>
      entry(`c${index}`, { pinned: true })
    )
    const unrelated = [entry('x', { text: '完全无关的内容', keywords: ['天气'] })]
    const result = selectMemories(
      [...core, ...unrelated],
      '上海跨境电商',
      budget(),
      0,
      'zh-CN'
    )
    expect(result.selected.some((item) => item.id === 'x')).toBe(false)
  })

  it('recent 上下文参与相关度计算且不影响结构', () => {
    const target = entry('x', { text: '对方喜欢喝手冲咖啡', keywords: ['咖啡'] })
    const withRecent = selectMemories([target], '它呢', budget(), 0, 'zh-CN', ['咖啡'])
    expect(withRecent.selected.map((item) => item.id)).toEqual(['x'])
    expect(withRecent.block).toContain('对方喜欢喝手冲咖啡')
  })

  it('返回复习后的条目供写回', () => {
    const original = entry('a')
    const result = selectMemories([original], '上海', budget(), 5 * 86_400_000, 'zh-CN')
    expect(result.reviewed).toHaveLength(result.selected.length)
    expect(result.reviewed[0].reps).toBe(1)
    expect(result.reviewed[0].lastReviewAt).toBe(5 * 86_400_000)
  })
})

describe('renderMemoryBlock', () => {
  it('空列表返回空串', () => {
    expect(renderMemoryBlock([], 1800, 'zh-CN')).toBe('')
  })

  it('按类别输出中文标签与包裹标记', () => {
    const block = renderMemoryBlock(
      [entry('a', { kind: 'fact' }), entry('b', { kind: 'preference' })],
      1800,
      'zh-CN'
    )
    expect(block).toContain('<long_term_memory>')
    expect(block).toContain('</long_term_memory>')
    expect(block).toContain('[身份与背景]')
    expect(block).toContain('[偏好与语气]')
  })

  it('英文标签随 locale 切换', () => {
    const block = renderMemoryBlock([entry('a', { kind: 'persona' })], 1800, 'en-US')
    expect(block).toContain('[Agreements and persona]')
    expect(block).toContain('Use them naturally')
  })

  it('摘要类别单独成段', () => {
    const block = renderMemoryBlock([entry('a', { kind: 'summary' })], 1800, 'zh-CN')
    expect(block).toContain('[早期对话摘要]')
  })

  it('超预算时截断文本', () => {
    const text = '很长的记忆内容。'.repeat(50)
    const block = renderMemoryBlock([entry('a', { text })], 1, 'zh-CN')
    expect(block.length).toBeLessThan(text.length)
    expect(block).toContain('…')
  })

  it('estimateTokens 对中英文分别计数', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcd')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })
})
