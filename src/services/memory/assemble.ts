import type { Locale } from '../settings.js'
import { priorityScore, relevance, review } from './ebbinghaus.js'
import { estimateTokens, truncateToBudget } from './tokenEstimate.js'
import type { MemoryBudget, MemoryEntry, MemoryKind } from './types.js'

/**
 * 记忆的检索、排序与提示词注入。
 *
 * 注入位置在本轮 user 消息的末尾（由 store/stream 写入 question.requestContext），
 * 不新增对话轮次，也不碰 system prompt：system 与历史前缀必须逐轮稳定，
 * 否则服务端的提示词缓存永远命不中。选中的记忆会冻结到该轮消息上，
 * 下一轮回放历史时原样带上，请求 N+1 始终是 N 的严格超集。
 * 模型看到的是「它本来就知道」，而不是「有人递给它一份档案」。
 */

type Kind = Exclude<MemoryKind, 'summary'>

const KIND_ORDER: Kind[] = ['goal', 'persona', 'preference', 'fact', 'event']

const LABELS: Record<Locale, Record<Kind | 'summary', string>> = {
  'zh-CN': {
    goal: '长期目标与追求',
    persona: '约定与设定',
    preference: '偏好与语气',
    fact: '身份与背景',
    event: '过往事件',
    summary: '早期对话摘要',
  },
  'en-US': {
    goal: 'Long-term goals',
    persona: 'Agreements and persona',
    preference: 'Preferences and tone',
    fact: 'Identity and background',
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
      '如果对方明确要求你记住某事，自然接受即可，不要声称自己无法长期记忆。',
    ],
    close: '</long_term_memory>',
  },
  'en-US': {
    open: '<long_term_memory>',
    intro: [
      'These are things you already know about this person from your ongoing relationship.',
      'Use them naturally; never mention that you keep memory, and never say "according to my memory".',
      'If they explicitly ask you to remember something, accept it naturally and never claim you cannot keep long-term memory.',
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

/** 类别先验：长期目标最重要，其次是设定与偏好，一次性事件最低 */
const KIND_PRIOR: Record<Kind | 'summary', number> = {
  goal: 1.4,
  persona: 1.2,
  preference: 1.1,
  fact: 1.0,
  event: 0.9,
  summary: 0.8,
}

/** 每类记忆的注入条数上限，避免某一类挤满预算 */
const KIND_CAP = 8
/** 核心记忆的条数上限与预算占比 */
const CORE_MAX_ENTRIES = 8
const CORE_BUDGET_RATIO = 0.45

/**
 * 按「保留率 × 重要性 × 相关度」挑出本轮要注入的记忆。
 *
 * 分两层（对齐主流产品的 core / recall 分层）：
 * - 核心记忆：锁定、角色设定、重要性 ≥ 0.85 的条目，每轮都带上；
 * - 相关回忆：其余条目按分数竞争剩余预算，相关度太低的直接跳过。
 * 预算按 token 计算，宁可少带也不让记忆挤占正文生成空间。
 *
 * recent 是最近几轮用户消息：追问「那它呢」时只靠当前句会丢失话题。
 */
export const selectMemories = (
  entries: MemoryEntry[],
  query: string,
  budget: MemoryBudget,
  now: number,
  locale: Locale,
  recent: string[] = []
): MemorySelection => {
  const usable = entries.filter((entry) => !entry.archived || entry.pinned)
  if (usable.length === 0) {
    return EMPTY
  }
  const context = [...recent.filter((text) => text.trim() !== ''), query]
    .join('\n')
    .slice(0, 2000)

  const selected: MemoryEntry[] = []
  let used = 0
  // 包裹标签本身的占用
  const overhead = 60
  const coreBudget = Math.floor(budget.tokenBudget * CORE_BUDGET_RATIO)
  let coreUsed = 0
  const coreIds = new Set<string>()

  const coreCandidates = usable
    .filter(
      (entry) =>
        entry.pinned ||
        entry.kind === 'goal' ||
        entry.kind === 'persona' ||
        entry.importance >= 0.85
    )
    .sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1
      }
      return b.importance - a.importance
    })
  for (const entry of coreCandidates) {
    if (coreIds.size >= CORE_MAX_ENTRIES) {
      break
    }
    const cost = estimateTokens(entry.text) + 8
    if (!entry.pinned && coreUsed + cost > coreBudget) {
      continue
    }
    coreIds.add(entry.id)
    coreUsed += cost
    selected.push(entry)
  }

  const scored = usable
    .filter((entry) => !coreIds.has(entry.id))
    .map((entry) => {
      const rel = relevance(entry, context)
      return {
        entry,
        rel,
        score: priorityScore(entry, now, rel) * KIND_PRIOR[entry.kind],
      }
    })
    .sort((a, b) => b.score - a.score)

  const perKind = new Map<string, number>()
  for (const entry of selected) {
    perKind.set(entry.kind, (perKind.get(entry.kind) ?? 0) + 1)
  }

  for (const { entry, rel } of scored) {
    if (selected.length >= budget.maxEntries) {
      break
    }
    // 与话题完全无关的回忆不占用预算；但记忆很少时仍带几条，保证个性化不至于消失
    if (rel < 0.08 && selected.length >= 4) {
      continue
    }
    if ((perKind.get(entry.kind) ?? 0) >= KIND_CAP) {
      continue
    }
    const cost = estimateTokens(entry.text) + 8
    if (used + cost + overhead > budget.tokenBudget && !entry.pinned) {
      continue
    }
    selected.push(entry)
    perKind.set(entry.kind, (perKind.get(entry.kind) ?? 0) + 1)
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
