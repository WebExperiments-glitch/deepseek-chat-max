import { describe, expect, it } from 'vitest'
import type { MemoryEntry } from './types.js'
import {
  archive,
  daysUntilForgotten,
  initialStability,
  isSameMemory,
  MEMORY_TUNING,
  mergeExtracted,
  memoryState,
  priorityScore,
  relevance,
  restore,
  retention,
  review,
  stabilityForDisplay,
  textSimilarity,
} from './ebbinghaus.js'

const DAY = MEMORY_TUNING.DAY

const entry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: 'm1',
  sourceSessionId: 's1',
  kind: 'fact',
  text: '对方住在上海，在一家跨境电商公司工作',
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

describe('initialStability', () => {
  it('难度为 0 时使用基础强度', () => {
    expect(initialStability(0)).toBe(7)
  })

  it('难度越高初始强度越低', () => {
    expect(initialStability(1)).toBeCloseTo(2.1)
    expect(initialStability(0.5)).toBeCloseTo(4.55)
  })

  it('难度被夹在 0 到 1 之间', () => {
    expect(initialStability(-1)).toBe(7)
    expect(initialStability(2)).toBeCloseTo(2.1)
    expect(initialStability(Number.NaN)).toBeCloseTo(4.55)
  })
})

describe('retention', () => {
  it('刚复习过时保留率为 1', () => {
    expect(retention(entry(), 0)).toBe(1)
  })

  it('经过一个强度周期后约为 36.8%', () => {
    expect(retention(entry({ stability: 10 }), 10 * DAY)).toBeCloseTo(Math.exp(-1), 5)
  })

  it('锁定条目恒为 1', () => {
    expect(retention(entry({ pinned: true }), 1000 * DAY)).toBe(1)
  })

  it('异常强度按最小强度兜底', () => {
    expect(retention(entry({ stability: 0 }), DAY)).toBeLessThan(1)
  })
})

describe('memoryState', () => {
  it('按阈值划分三档', () => {
    expect(memoryState(0.8)).toBe('active')
    expect(memoryState(0.5)).toBe('active')
    expect(memoryState(0.3)).toBe('fading')
    expect(memoryState(0.2)).toBe('fading')
    expect(memoryState(0.1)).toBe('forgotten')
  })
})

describe('daysUntilForgotten', () => {
  it('锁定或已归档返回 0', () => {
    expect(daysUntilForgotten(entry({ pinned: true }), 0)).toBe(0)
    expect(daysUntilForgotten(entry({ archived: true }), 0)).toBe(0)
  })

  it('新记忆距离淡忘约 11 天', () => {
    expect(daysUntilForgotten(entry({ stability: 7 }), 0)).toBeCloseTo(11.3, 1)
  })

  it('随着时间流逝剩余天数减少', () => {
    const fresh = daysUntilForgotten(entry({ stability: 7 }), 0)
    const later = daysUntilForgotten(entry({ stability: 7 }), 5 * DAY)
    expect(later).toBeLessThan(fresh)
  })

  it('已跌破阈值返回 0', () => {
    expect(daysUntilForgotten(entry({ stability: 1 }), 100 * DAY)).toBe(0)
  })
})

describe('review', () => {
  it('锁定条目只增加复习次数与时间', () => {
    const original = entry({ pinned: true, stability: 7 })
    const result = review(original, DAY)
    expect(result.stability).toBe(7)
    expect(result.reps).toBe(1)
    expect(result.lastReviewAt).toBe(DAY)
  })

  it('接近遗忘时复习收益更大', () => {
    const fresh = review(entry({ stability: 7, lastReviewAt: 0 }), 0)
    const fading = review(entry({ stability: 7, lastReviewAt: 0 }), 10 * DAY)
    expect(fading.stability - 7).toBeGreaterThan(fresh.stability - 7)
  })

  it('至少增加最小增益', () => {
    const result = review(entry({ stability: 7, difficulty: 1 }), 0)
    expect(result.stability).toBeGreaterThanOrEqual(7)
  })

  it('复习会解除归档并增加次数', () => {
    const result = review(entry({ archived: true }), DAY)
    expect(result.archived).toBe(false)
    expect(result.reps).toBe(1)
  })

  it('强度不超过上限', () => {
    const result = review(entry({ stability: MEMORY_TUNING.MAX_STABILITY }), 100 * DAY)
    expect(result.stability).toBeLessThanOrEqual(MEMORY_TUNING.MAX_STABILITY)
  })
})

describe('restore 与 archive', () => {
  it('归档只改变 archived 标记', () => {
    const result = archive(entry())
    expect(result.archived).toBe(true)
    expect(result.stability).toBe(7)
  })

  it('恢复时强度减半、遗忘次数加一', () => {
    const result = restore(entry({ stability: 8, archived: true, lapses: 1 }), DAY)
    expect(result.stability).toBe(4)
    expect(result.lapses).toBe(2)
    expect(result.archived).toBe(false)
    expect(result.lastReviewAt).toBe(DAY)
  })

  it('恢复强度不低于 0.5', () => {
    expect(restore(entry({ stability: 0.4 }), 0).stability).toBe(0.5)
  })
})

describe('priorityScore', () => {
  it('锁定条目恒为最大', () => {
    expect(priorityScore(entry({ pinned: true }), 0, 0)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('重要性和相关度越高分数越高', () => {
    const low = priorityScore(entry({ importance: 0.2 }), 0, 0.2)
    const high = priorityScore(entry({ importance: 0.9 }), 0, 0.9)
    expect(high).toBeGreaterThan(low)
  })

  it('相关度为 0 时仍有基础权重', () => {
    expect(priorityScore(entry(), 0, 0)).toBeGreaterThan(0)
  })
})

describe('stabilityForDisplay', () => {
  it('锁定条目返回无限强度供面板展示', () => {
    expect(stabilityForDisplay(entry({ pinned: true }))).toBe(Number.POSITIVE_INFINITY)
    expect(stabilityForDisplay(entry())).toBe(7)
  })
})

describe('relevance', () => {
  it('空查询返回中性值', () => {
    expect(relevance(entry(), '')).toBe(0.5)
  })

  it('关键词命中提高相关度', () => {
    const hit = relevance(entry(), '上海跨境电商')
    const miss = relevance(entry(), '今天天气怎么样')
    expect(hit).toBeGreaterThan(miss)
  })

  it('中文 bigram 覆盖生效', () => {
    expect(relevance(entry(), '跨境电商工作')).toBeGreaterThan(
      relevance(entry(), '完全无关的话题')
    )
  })

  it('英文与型号词命中生效', () => {
    const tech = entry({ text: '偏好使用 React 和 TypeScript', keywords: ['React'] })
    expect(relevance(tech, 'React')).toBeGreaterThan(relevance(tech, '园艺'))
  })

  it('引号实体命中额外加权', () => {
    const base = relevance(entry(), '上海')
    const withEntity = relevance(entry(), '“上海”')
    expect(withEntity).toBeGreaterThanOrEqual(base)
  })

  it('相关度不超过 1', () => {
    expect(relevance(entry(), entry().text)).toBeLessThanOrEqual(1)
  })
})

describe('textSimilarity', () => {
  it('相同文本相似度为 1', () => {
    expect(textSimilarity('对方住在上海', '对方住在上海')).toBe(1)
  })

  it('完全不同文本相似度很低', () => {
    expect(textSimilarity('对方住在上海', '今天天气很好')).toBeLessThan(0.3)
  })

  it('空文本相似度为 0', () => {
    expect(textSimilarity('', '内容')).toBe(0)
  })
})

describe('isSameMemory', () => {
  const candidate = { kind: 'fact', text: '对方住在上海，在跨境电商公司工作', keywords: ['上海', '跨境电商'] }

  it('类别不同直接判定为不同', () => {
    expect(isSameMemory(entry({ kind: 'preference' }), candidate)).toBe(false)
  })

  it('正文完全相同判定为同一条', () => {
    expect(isSameMemory(entry({ text: candidate.text }), candidate)).toBe(true)
  })

  it('关键词高度重叠且正文互相包含判定为同一条', () => {
    expect(isSameMemory(entry(), candidate)).toBe(true)
  })

  it('关键词无重叠判定为不同', () => {
    expect(isSameMemory(entry({ keywords: ['天气'] }), candidate)).toBe(false)
  })
})

describe('mergeExtracted', () => {
  it('没有匹配条目时新增', () => {
    const result = mergeExtracted([], entry(), 0)
    expect(result.merged).toBe(false)
    expect(result.entries).toHaveLength(1)
  })

  it('匹配到同一件事时强化原条目并合并字段', () => {
    const original = entry()
    const candidate = entry({
      id: 'm2',
      text: original.text,
      keywords: ['上海', '工作'],
      importance: 0.9,
    })
    const result = mergeExtracted([original], candidate, 10 * DAY)
    expect(result.merged).toBe(true)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].importance).toBe(0.9)
    expect(result.entries[0].keywords).toContain('工作')
    expect(result.entries[0].reps).toBe(1)
  })

  it('手动条目不参与自动合并', () => {
    const manual = entry({ manual: true })
    const result = mergeExtracted([manual], entry({ id: 'm2' }), 0)
    expect(result.merged).toBe(false)
    expect(result.entries).toHaveLength(2)
  })
})
