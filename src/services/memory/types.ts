/**
 * 本地长期记忆的类型定义。
 *
 * 与上游项目（deepseek-memory-android）按会话隔离不同，这里改为**全局记忆**：
 * 长期记忆的意义就在于跨对话，切换会话后仍然记得对方是谁。
 * sourceSessionId 只用于回溯来源，检索与注入不看会话边界。
 */

/** 记忆类别；决定注入时的归类标签 */
export type MemoryKind =
  /** 客观事实：身份、背景、经历 */
  | 'fact'
  /** 稳定偏好：表达习惯、审美、做事方式 */
  | 'preference'
  /** 角色设定：扮演关系、性格约定、称呼 */
  | 'persona'
  /** 事件：发生过的、后续可能被提及的事 */
  | 'event'
  /** 摘要：由早期对话压缩而来，承载已移出上下文的长期内容 */
  | 'summary'

/**
 * 一条长期记忆。
 *
 * 衰减由 stability（记忆强度 S，单位「天」）与 difficulty（记忆难度 D，0-1）共同决定：
 * 保留率 R(t) = exp(-t / S)，t 为距上次复习的天数。S 越大忘得越慢，
 * 每次被检索命中即视为一次复习，按当前 R 反向强化。
 */
export type MemoryEntry = {
  id: string
  /** 来源会话，仅用于回溯 */
  sourceSessionId: string
  kind: MemoryKind
  /** 记忆正文，第三人称陈述句 */
  text: string
  /** 检索关键词，由抽取时生成 */
  keywords: string[]
  /** 记忆强度 S（天） */
  stability: number
  /** 记忆难度 D（0-1） */
  difficulty: number
  /** 累计复习次数 */
  reps: number
  /** 累计遗忘（跌入归档）次数 */
  lapses: number
  createdAt: number
  /** 上次复习时间；衰减从此刻起算 */
  lastReviewAt: number
  /** 来源消息 id，便于回溯；手动添加的为空数组 */
  sourceMessageIds: string[]
  /** 锁定：不参与衰减，始终以最高优先级注入 */
  pinned: boolean
  /** 已淡忘：R 跌破阈值后归档，不再注入但保留可恢复 */
  archived: boolean
  /** 用户手动添加 */
  manual: boolean
  /** 基础重要性 0-1，由抽取时评估 */
  importance: number
}

/** 记忆当前的强度档位，由保留率 R 划分 */
export type MemoryState =
  /** R ≥ 0.5，清晰 */
  | 'active'
  /** 0.2 ≤ R < 0.5，模糊 */
  | 'fading'
  /** R < 0.2，已淡忘 */
  | 'forgotten'

/** 注入预算：条目数与 token 上限 */
export type MemoryBudget = {
  maxEntries: number
  tokenBudget: number
}

export const DEFAULT_MEMORY_BUDGET: MemoryBudget = {
  maxEntries: 24,
  tokenBudget: 3000,
}

/** 一条记忆在某一时刻的可视化快照，供面板展示 */
export type MemoryView = {
  entry: MemoryEntry
  /** 当前保留率 0-1 */
  retention: number
  state: MemoryState
}

/** 抽取器返回的候选记忆，尚未落库 */
export type ExtractedMemory = {
  kind: Exclude<MemoryKind, 'summary'>
  text: string
  keywords: string[]
  importance: number
  difficulty: number
}
