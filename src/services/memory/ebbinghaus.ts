/**
 * 艾宾浩斯遗忘曲线。
 *
 * 保留率：R(t) = exp(-t / S)
 *   t 为距上次复习的天数，S 为记忆强度（天）。
 *   t = 0 时 R = 1；t = S 时 R ≈ 0.368；t = 2S 时 R ≈ 0.135。
 *
 * 复习强化：命中即强化，且「越接近遗忘，强化幅度越大」——
 *   S' = S * (1 + GROWTH * (1 - R) * (1 - 0.5D))
 *   这样一条快被忘掉的记忆被重新提起时，会比刚记过的记忆成长得更快，
 *   符合间隔重复的实测规律（遗忘边缘的复习收益最高）。
 *
 * 遗忘：R 跌破 FORGET_THRESHOLD 即归档。归档不等于删除，
 *   面板里仍可见，手动恢复时 S 减半（lapse 惩罚），重建成本更高。
 */

import type { MemoryEntry, MemoryState } from './types.js'

const DAY = 86_400_000

/** 初始记忆强度基数（天）。难度为 0 的新记忆约一周后保留率降到 37% */
const BASE_STABILITY = 7
/** 难度对初始强度的削弱比例上限：D = 1 时强度只剩 30% */
const DIFFICULTY_PENALTY = 0.7
/** 复习增益系数 */
const GROWTH = 2
/** 单次复习的最小强度增量（天），避免高难度记忆几乎不成长 */
const MIN_GAIN = 0.5
/** 强度上限（天）：约一年，超过后视为长期稳定记忆 */
const MAX_STABILITY = 365
/** 难度对复习增益的削弱比例 */
const DIFFICULTY_GROWTH_DAMPING = 0.5
/** 归档阈值：低于此保留率即视为「淡忘」 */
const FORGET_THRESHOLD = 0.2
/** 清晰阈值：高于此保留率视为「清晰」 */
const ACTIVE_THRESHOLD = 0.5
/** 锁定条目的虚拟强度，使 R 恒为 1 */
const PINNED_STABILITY = Number.POSITIVE_INFINITY

/** 新记忆的初始强度：越难记的内容起点越低 */
export const initialStability = (difficulty: number): number => {
  const d = clamp01(difficulty)
  return round2(BASE_STABILITY * (1 - DIFFICULTY_PENALTY * d))
}

/** 距上次复习经过的天数 */
const elapsedDays = (entry: MemoryEntry, now: number): number =>
  Math.max(0, (now - entry.lastReviewAt) / DAY)

/**
 * 当前保留率 R ∈ (0, 1]。
 * 锁定条目恒为 1；未归档但强度异常时按最小强度兜底。
 */
export const retention = (entry: MemoryEntry, now: number): number => {
  if (entry.pinned) {
    return 1
  }
  const s = Math.max(0.1, entry.stability)
  return Math.exp(-elapsedDays(entry, now) / s)
}

/** 由保留率判定档位 */
export const memoryState = (r: number): MemoryState => {
  if (r < FORGET_THRESHOLD) {
    return 'forgotten'
  }
  return r < ACTIVE_THRESHOLD ? 'fading' : 'active'
}

/** 距离跌破归档阈值还剩多少天；已跌破或无期限返回 0 */
export const daysUntilForgotten = (entry: MemoryEntry, now: number): number => {
  if (entry.pinned || entry.archived) {
    return 0
  }
  const s = Math.max(0.1, entry.stability)
  const elapsed = elapsedDays(entry, now)
  // 解 exp(-t/S) = FORGET_THRESHOLD 得 t = -S * ln(threshold)
  const total = -s * Math.log(FORGET_THRESHOLD)
  return Math.max(0, Math.round((total - elapsed) * 10) / 10)
}

/**
 * 复习一次：按当前保留率反向强化强度。
 * R 越低（越接近遗忘）增益越大；难度越高增益越小。
 * 锁定条目的强度不需要变化。
 */
export const review = (entry: MemoryEntry, now: number): MemoryEntry => {
  if (entry.pinned) {
    return { ...entry, lastReviewAt: now, reps: entry.reps + 1 }
  }
  const r = retention(entry, now)
  const difficultyDamping = 1 - DIFFICULTY_GROWTH_DAMPING * clamp01(entry.difficulty)
  const gain = entry.stability * GROWTH * (1 - r) * difficultyDamping
  const next = Math.min(MAX_STABILITY, entry.stability + Math.max(MIN_GAIN, gain))
  return {
    ...entry,
    stability: round2(next),
    lastReviewAt: now,
    reps: entry.reps + 1,
    archived: false,
  }
}

/**
 * 从归档中恢复：强度减半，作为遗忘代价。
 * 恢复后立即处于「模糊」区间，需要后续反复提及才会重新变清晰。
 */
export const restore = (entry: MemoryEntry, now: number): MemoryEntry => ({
  ...entry,
  stability: round2(Math.max(0.5, entry.stability / 2)),
  lastReviewAt: now,
  archived: false,
  lapses: entry.lapses + 1,
})

/** 归档一条已淡忘的记忆 */
export const archive = (entry: MemoryEntry): MemoryEntry => ({ ...entry, archived: true })

/**
 * 注入优先级。
 *
 * 三个因子相乘：
 * - 保留率 R：越清晰越优先，但用 0.7 次幂压平，避免新记忆完全压制旧记忆；
 * - 重要性：基础权重，重要的事即使模糊也值得带上；
 * - 相关度：与当前提问的匹配程度，不相关的记忆即使清晰也不占额度。
 *
 * 锁定条目恒定位于最前，不参与计算。
 */
export const priorityScore = (
  entry: MemoryEntry,
  now: number,
  relevance: number
): number => {
  if (entry.pinned) {
    return Number.MAX_SAFE_INTEGER
  }
  const r = retention(entry, now)
  const importance = 0.3 + 0.7 * clamp01(entry.importance)
  const rel = 0.35 + 0.65 * clamp01(relevance)
  return Math.pow(r, 0.7) * importance * rel
}

/** 中文虚词组合，命中它们没有检索价值 */
const STOP_BIGRAMS = new Set([
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '什么',
  '怎么',
  '可以',
  '如何',
  '一下',
  '就是',
  '还是',
  '因为',
  '所以',
  '但是',
  '如果',
  '现在',
  '已经',
  '一个',
  '没有',
  '不是',
  '自己',
  '的话',
  '了吗',
  '的是',
])

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/

/** 去掉空白与标点，便于做中文包含判断 */
const normalizeText = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[\s，。、；;:：!！?？"'“”‘’（）()[\]【】《》<>]/g, '')

/** 中文二元组：中文没有空格，用 bigram 近似「同一话题」 */
const cjkBigrams = (text: string): string[] => {
  const chars = Array.from(text)
  const result: string[] = []
  for (let index = 0; index < chars.length - 1; index += 1) {
    if (CJK.test(chars[index]) && CJK.test(chars[index + 1])) {
      const pair = chars[index] + chars[index + 1]
      if (!STOP_BIGRAMS.has(pair)) {
        result.push(pair)
      }
    }
  }
  return result
}

/** 拉丁词：英文、型号、技术名词 */
const latinTokens = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9][a-z0-9_+\-.#]{1,}/g) ?? []).filter(
    (token) => token.length >= 2
  )

/**
 * 相关度：关键词命中 + 中文 bigram 覆盖 + 拉丁词覆盖 + 引号实体加成。
 *
 * 不引入向量检索——本地跑不了嵌入模型。bigram 覆盖对中文「同一话题被再次提起」
 * 已经比单字或整句包含稳健得多，也不会因为多一个字就完全失配。
 */
export const relevance = (entry: MemoryEntry, query: string): number => {
  const q = query.trim()
  if (!q) {
    return 0.5
  }
  const qLower = q.toLowerCase()
  const entryText = entry.text.toLowerCase()
  const entryNorm = normalizeText(entryText)

  const queryBigrams = [...new Set(cjkBigrams(q))]
  const queryLatin = [...new Set(latinTokens(q))]

  let keywordHits = 0
  let keywordTotal = 0
  for (const keyword of entry.keywords) {
    const k = keyword.toLowerCase().trim()
    if (!k) {
      continue
    }
    keywordTotal += 1
    // 提问里出现关键词，或提问的 bigram/单词与关键词互相包含（「上海工作」命中「上海」）
    const hit =
      qLower.includes(k) ||
      [...queryBigrams, ...queryLatin].some(
        (token) => token.length >= 2 && (k.includes(token) || token.includes(k))
      )
    if (hit) {
      // 较长的关键词命中更有说服力
      keywordHits += Math.min(1, 0.5 + k.length / 12)
    }
  }
  const keywordScore = keywordTotal === 0 ? 0 : keywordHits / keywordTotal

  let bigramScore = 0
  if (queryBigrams.length > 0) {
    const hits = queryBigrams.filter((pair) => entryNorm.includes(pair)).length
    bigramScore = hits / queryBigrams.length
  }

  let latinScore = 0
  if (queryLatin.length > 0) {
    const hits = queryLatin.filter((token) => entryText.includes(token)).length
    latinScore = hits / queryLatin.length
  }

  // 引号里的实体（产品名、地名、人名）命中时额外加权
  let entityBonus = 0
  for (const match of q.matchAll(/[“"「『']([^”"」』']{2,20})[”"」』']/g)) {
    if (entryText.includes(match[1].toLowerCase())) {
      entityBonus = 0.15
      break
    }
  }

  const bodyScore = Math.max(bigramScore, latinScore)
  return Math.min(1, keywordScore * 0.5 + bodyScore * 0.55 + entityBonus)
}

/** 文本相似度（0-1）：bigram 与拉丁词的 Jaccard，用于合并重复记忆 */
export const textSimilarity = (left: string, right: string): number => {
  const features = (text: string) =>
    new Set([...cjkBigrams(text), ...latinTokens(text), ...normalizeText(text).split('')].filter(
      (item) => item.length > 0
    ))
  const a = features(left)
  const b = features(right)
  if (a.size === 0 || b.size === 0) {
    return 0
  }
  let shared = 0
  for (const item of a) {
    if (b.has(item)) {
      shared += 1
    }
  }
  return shared / (a.size + b.size - shared)
}

/**
 * 判断两条记忆是否在说同一件事，用于抽取后的去重合并。
 * 关键词重叠过半即视为同一条，合并时取更完整的正文并抬高重要性。
 */
export const isSameMemory = (a: MemoryEntry, b: { kind: string; text: string; keywords: string[] }): boolean => {
  if (a.kind !== b.kind) {
    return false
  }
  const normalize = (text: string) =>
    text.toLowerCase().replace(/[\s，。、；;:：!！?？"'“”‘’（）()]/g, '')
  const left = normalize(a.text)
  const right = normalize(b.text)
  if (!left || !right) {
    return false
  }
  if (left === right) {
    return true
  }
  const keywords = new Set(a.keywords.map((k) => k.toLowerCase()))
  if (keywords.size === 0) {
    return left.includes(right) || right.includes(left)
  }
  let overlap = 0
  for (const k of b.keywords) {
    if (keywords.has(k.toLowerCase())) {
      overlap += 1
    }
  }
  const ratio = overlap / Math.min(keywords.size, Math.max(1, b.keywords.length))
  return ratio >= 0.6 && (left.includes(right) || right.includes(left) || ratio === 1)
}

/** 把抽取结果并入已有记忆：同一件事则强化原条目，否则新增 */
export const mergeExtracted = (
  existing: MemoryEntry[],
  candidate: MemoryEntry,
  now: number
): { entries: MemoryEntry[]; merged: boolean } => {
  const index = existing.findIndex((entry) => !entry.manual && isSameMemory(entry, candidate))
  if (index < 0) {
    return { entries: [...existing, candidate], merged: false }
  }
  const target = existing[index]
  const strengthened = review(target, now)
  const next = [...existing]
  next[index] = {
    ...strengthened,
    // 保留更完整的表述与更高的初始权重
    text: candidate.text.length > target.text.length ? candidate.text : target.text,
    keywords: [...new Set([...target.keywords, ...candidate.keywords])].slice(0, 8),
    importance: Math.max(target.importance, candidate.importance),
    sourceMessageIds: [...new Set([...target.sourceMessageIds, ...candidate.sourceMessageIds])],
  }
  return { entries: next, merged: true }
}

/** 锁定状态下的虚拟强度，供面板展示时统一处理 */
export const stabilityForDisplay = (entry: MemoryEntry): number =>
  entry.pinned ? PINNED_STABILITY : entry.stability

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5

const round2 = (value: number): number => Math.round(value * 100) / 100

export const MEMORY_TUNING = {
  BASE_STABILITY,
  GROWTH,
  MIN_GAIN,
  MAX_STABILITY,
  FORGET_THRESHOLD,
  ACTIVE_THRESHOLD,
  DAY,
} as const
