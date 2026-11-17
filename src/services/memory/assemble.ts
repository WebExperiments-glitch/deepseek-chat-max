import type { Locale } from '../settings.js'
import { priorityScore, relevance, review } from './ebbinghaus.js'
import { estimateTokens, truncateToBudget } from './tokenEstimate.js'
import type { MemoryBudget, MemoryEntry, MemoryKind } from './types.js'

/**
 * 记忆的检索、排序与提示词注入。
 *
 * 注入方式与 DeepSeek 官网一致：不新增消息轮次，而是拼进 system prompt。
 * 记忆不占对话轮次、不留历史痕迹，模型看到的是「它本来就知道」，
 * 而不是「有人递给它一份档案」。
 */

type Kind = Exclude<MemoryKind, 'summary'>

const KIND_ORDER: Kind[] = ['persona', 'fact', 'preference', 'event']

const LABELS: Record<Locale, Record<Kind | 'summary', string>> = {
  'zh-CN': {
    persona: '约定与设定',
    fact: '身份与背景',
    preference: '偏好与习惯',
    event: '过往事件',
    summary: '早期对话摘要',
  },
  'en-US': {
    persona: 'Agreements and persona',
    fact: 'Identity and background',
    preference: 'Preferences and habits',
    event: 'Past events',
    summary: 'Earlier conversation summaries',
  },
}

const WRAPPER: Record<Locale, { open: string; intro: string[]; close: string }> = {
  'zh-CN': {
    open: '<long_term_memory>',
    intro: [
      '以下是你与对方长期相处中已经知道的事情。自然地运用它们，不要主动提及这些内容本身，',
      '也不要说「根据我的记忆」「记录显示」之类的话。',
    ],
    close: '</long_term_memory>',
  },
  'en-US': {
    open: '<long_term_memory>',
    intro: [
      'These are things you already know about this person from your ongoing relationship.',
      'Use them naturally; never mention that you keep memory, and never say "according to my memory".',
    ],
    close: '</long_term_memory>',
  },
}

/** 排序后的选中结果，附带复习后的条目，供调用方持久化 */
export type MemorySelection = {
  selected: MemoryEntry[]
  /** 已执行复习的条目（需写回存储）；未被选中的不复习 */
  reviewed: MemoryEntry[]
  /** 注入用的记忆块；没有记忆时为空串 */
  block: string
}

const EMPTY: MemorySelection = { selected: [], reviewed: [], block: '' }

/**
 * 按「保留率 × 重要性 × 相关度」挑出本轮要注入的记忆。
 * 预算按 token 计算：先保证锁定条目，再按分数从高到低装入，装不下就少带，
 * 宁可少带也不让记忆挤占正文生成空间。
 */
export const selectMemories = (
  entries: MemoryEntry[],
  query: string,
  budget: MemoryBudget,
  now: number,
  locale: Locale
): MemorySelection => {
  const usable = entries.filter((entry) => !entry.archived || entry.pinned)
  if (usable.length === 0) {
    return EMPTY
  }
  const scored = usable
    .map((entry) => ({ entry, score: priorityScore(entry, now, relevance(entry, query)) }))
    .sort((a, b) => b.score - a.score)

  const selected: MemoryEntry[] = []
  let used = 0
  // 包裹标签本身的占用
  const overhead = 60
  for (const { entry } of scored) {
    if (selected.length >= budget.maxEntries) {
      break
    }
    const cost = estimateTokens(entry.text) + 8
    if (used + cost + overhead > budget.tokenBudget && !entry.pinned) {
      continue
    }
    selected.push(entry)
    used += cost
  }
  if (selected.length === 0) {
    return EMPTY
  }
  return {
    selected,
    reviewed: selected.map((entry) => review(entry, now)),
    block: renderMemoryBlock(selected, budget.tokenBudget, locale),
  }
}

/** 把选中的记忆渲染成提示词片段；超预算时整体截断 */
export const renderMemoryBlock = (
  entries: MemoryEntry[],
  tokenBudget: number,
  locale: Locale
): string => {
  if (entries.length === 0) {
    return ''
  }
  const labels = LABELS[locale]
  const sections: string[] = []
  for (const kind of KIND_ORDER) {
    const items = entries.filter((entry) => entry.kind === kind)
    if (items.length > 0) {
      sections.push(`[${labels[kind]}]\n${items.map((entry) => `- ${entry.text}`).join('\n')}`)
    }
  }
  const summaries = entries.filter((entry) => entry.kind === 'summary')
  if (summaries.length > 0) {
    sections.push(
      `[${labels.summary}]\n${summaries.map((entry) => `- ${entry.text}`).join('\n')}`
    )
  }
  if (sections.length === 0) {
    return ''
  }
  const wrapper = WRAPPER[locale]
  return [
    wrapper.open,
    ...wrapper.intro,
    '',
    truncateToBudget(sections.join('\n\n'), tokenBudget),
    wrapper.close,
  ].join('\n')
}
