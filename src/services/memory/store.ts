import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { showToast } from '../../components/base/toastState.js'
import { getDeepseekApiKey, useSettings } from '../settings.js'
import { selectMemories } from './assemble.js'
import {
  archive,
  initialStability,
  memoryState,
  mergeExtracted,
  restore,
  retention,
  review,
  textSimilarity,
} from './ebbinghaus.js'
import { extractFromRound } from './extract.js'
import { ensureServerMigrated } from '../platform/migrateToServer.js'
import * as db from './db.js'
import {
  DEFAULT_MEMORY_BUDGET,
  type ExtractedOperation,
  type MemoryEntry,
  type MemoryKind,
  type MemoryView,
} from './types.js'

/**
 * 长期记忆的状态与编排。
 *
 * 对外两类接口：
 * 1. 对话链路：memoryBlockForQuery（请求前取记忆块）、extractRoundMemory（回复后抽取）；
 * 2. 面板：列表、手动新增、置顶、恢复、删除。
 *
 * 记忆是全局的（跨会话），sourceSessionId 只用于回溯。
 */

type MemoryStoreState = {
  /** 是否已从本地读入 */
  ready: boolean
  entries: MemoryEntry[]
  /** 正在后台抽取的会话，用于面板显示「正在整理」 */
  extracting: Record<string, boolean>
}

export const useMemories = create<MemoryStoreState>(() => ({
  ready: false,
  entries: [],
  extracting: {},
}))

const { getState: get, setState: set } = useMemories

/** 读入全部记忆；顺手把已跌破阈值的条目标记为归档，避免每次渲染重算 */
export const initMemory = async (): Promise<void> => {
  if (get().ready) {
    return
  }
  await ensureServerMigrated().catch(() => {})
  const entries = await db.listMemories()
  const now = Date.now()
  const stale = entries.filter(
    (entry) => !entry.archived && !entry.pinned && retention(entry, now) < 0.2
  )
  if (stale.length > 0) {
    await db.putMemories(stale.map(archive))
    const byId = new Map(stale.map((entry) => [entry.id, archive(entry)]))
    set({ ready: true, entries: entries.map((entry) => byId.get(entry.id) ?? entry) })
    return
  }
  set({ ready: true, entries })
}

/**
 * 请求前取出本轮要注入的记忆块（同步读取内存态）。
 * 被选中的条目视为复习，写回强化后的强度。
 */
export const memoryBlockForQuery = (query: string, recent: string[] = []): string => {
  // 关掉读取开关后既不再注入，也不再因为「被选中」而强化条目
  if (!useSettings.getState().memoryReadEnabled) {
    return ''
  }
  const { entries } = get()
  if (entries.length === 0) {
    return ''
  }
  const selection = selectMemories(
    entries,
    query,
    DEFAULT_MEMORY_BUDGET,
    Date.now(),
    useSettings.getState().locale,
    recent
  )
  if (selection.reviewed.length === 0) {
    return selection.block
  }
  const byId = new Map(selection.reviewed.map((entry) => [entry.id, entry]))
  set({ entries: entries.map((entry) => byId.get(entry.id) ?? entry) })
  void db.putMemories(selection.reviewed)
  return selection.block
}

/** 面板视图：带上实时保留率与档位，锁定优先、已淡忘沉底 */
export const memoryViews = (entries: MemoryEntry[], now: number): MemoryView[] =>
  entries
    .map((entry) => {
      const r = retention(entry, now)
      return {
        entry,
        retention: r,
        state: entry.archived ? ('forgotten' as const) : memoryState(r),
      }
    })
    .sort((a, b) => {
      if (a.entry.pinned !== b.entry.pinned) {
        return a.entry.pinned ? -1 : 1
      }
      return b.retention - a.retention
    })

/** 手动新增：强度从高位起步，因为是用户明确写下的 */
export const addManualMemory = async (
  text: string,
  kind: Exclude<MemoryKind, 'summary'> = 'fact',
  importance = 0.9
): Promise<boolean> => {
  const trimmed = text.trim()
  if (!trimmed) {
    return false
  }
  const now = Date.now()
  const entry: MemoryEntry = {
    id: createId(),
    sourceSessionId: '',
    kind,
    text: trimmed.slice(0, 300),
    keywords: [],
    stability: initialStability(0.15),
    difficulty: 0.15,
    reps: 0,
    lapses: 0,
    createdAt: now,
    lastReviewAt: now,
    sourceMessageIds: [],
    pinned: false,
    archived: false,
    manual: true,
    importance: Math.min(1, Math.max(0, importance)),
  }
  await db.putMemory(entry)
  set((state) => ({ entries: [...state.entries, entry] }))
  return true
}

/** 合并重复记忆：同类别且文本相似度超过阈值时保留信息更全的一条 */
export const consolidateMemories = async (): Promise<number> => {
  const entries = get().entries
  const kept: MemoryEntry[] = []
  const removedIds: string[] = []
  for (const entry of entries) {
    if (entry.pinned || entry.manual) {
      kept.push(entry)
      continue
    }
    const index = kept.findIndex(
      (candidate) =>
        !candidate.pinned &&
        !candidate.manual &&
        candidate.kind === entry.kind &&
        textSimilarity(candidate.text, entry.text) >= 0.82
    )
    if (index < 0) {
      kept.push(entry)
      continue
    }
    const base = kept[index]
    kept[index] = {
      ...base,
      text: entry.text.length > base.text.length ? entry.text : base.text,
      keywords: [...new Set([...base.keywords, ...entry.keywords])].slice(0, 8),
      importance: Math.max(base.importance, entry.importance),
      stability: Math.max(base.stability, entry.stability),
      lastReviewAt: Math.max(base.lastReviewAt, entry.lastReviewAt),
      sourceMessageIds: [...new Set([...base.sourceMessageIds, ...entry.sourceMessageIds])],
    }
    removedIds.push(entry.id)
  }
  if (removedIds.length === 0) {
    return 0
  }
  await db.putMemories(kept)
  await Promise.all(removedIds.map((id) => db.deleteMemory(id)))
  set({ entries: kept })
  return removedIds.length
}

/** 导出全部记忆；格式与导入一致，便于换机或备份 */
export const exportMemories = (): string =>
  JSON.stringify({ version: 1, exportedAt: Date.now(), memories: get().entries }, null, 2)

/** 导入记忆：按 id 覆盖同一条，其余追加；返回导入条数 */
export const importMemories = async (raw: string): Promise<number> => {
  const parsed: unknown = JSON.parse(raw)
  const list =
    parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { memories?: unknown }).memories)
      ? ((parsed as { memories: unknown[] }).memories)
      : Array.isArray(parsed)
        ? parsed
        : []
  const validKinds = new Set(['goal', 'fact', 'preference', 'persona', 'event', 'summary'])
  const imported: MemoryEntry[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') {
      continue
    }
    const record = item as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (!text) {
      continue
    }
    const now = Date.now()
    const kind = typeof record.kind === 'string' && validKinds.has(record.kind)
      ? (record.kind as MemoryKind)
      : 'fact'
    const number = (value: unknown, fallback: number) =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback
    imported.push({
      id: typeof record.id === 'string' && record.id ? record.id : createId(),
      sourceSessionId: typeof record.sourceSessionId === 'string' ? record.sourceSessionId : '',
      kind,
      text: text.slice(0, 300),
      keywords: Array.isArray(record.keywords)
        ? record.keywords.filter((word): word is string => typeof word === 'string').slice(0, 8)
        : [],
      stability: Math.max(0.1, number(record.stability, initialStability(0.3))),
      difficulty: Math.min(1, Math.max(0, number(record.difficulty, 0.3))),
      reps: Math.max(0, number(record.reps, 0)),
      lapses: Math.max(0, number(record.lapses, 0)),
      createdAt: number(record.createdAt, now),
      lastReviewAt: number(record.lastReviewAt, now),
      sourceMessageIds: Array.isArray(record.sourceMessageIds)
        ? record.sourceMessageIds.filter((id): id is string => typeof id === 'string')
        : [],
      pinned: record.pinned === true,
      archived: record.archived === true,
      manual: record.manual === true,
      importance: Math.min(1, Math.max(0, number(record.importance, 0.6))),
    })
  }
  if (imported.length === 0) {
    return 0
  }
  const byId = new Map(get().entries.map((entry) => [entry.id, entry]))
  for (const entry of imported) {
    byId.set(entry.id, entry)
  }
  const entries = [...byId.values()]
  await db.putMemories(entries)
  set({ entries })
  return imported.length
}

/** 改写正文视为重新确认，按复习处理，强度回升 */
export const updateMemoryText = async (id: string, text: string): Promise<void> => {
  const trimmed = text.trim()
  const target = get().entries.find((entry) => entry.id === id)
  if (!target || !trimmed) {
    return
  }
  const next = { ...review(target, Date.now()), text: trimmed.slice(0, 300), manual: true }
  await db.putMemory(next)
  set((state) => ({ entries: state.entries.map((entry) => (entry.id === id ? next : entry)) }))
}

export const removeMemory = async (id: string): Promise<void> => {
  await db.deleteMemory(id)
  set((state) => ({ entries: state.entries.filter((entry) => entry.id !== id) }))
}

export const toggleMemoryPin = async (id: string): Promise<void> => {
  const target = get().entries.find((entry) => entry.id === id)
  if (!target) {
    return
  }
  const next: MemoryEntry = {
    ...target,
    pinned: !target.pinned,
    // 锁定前先复习一次，解锁后不会立刻掉进遗忘区
    lastReviewAt: Date.now(),
    archived: false,
  }
  await db.putMemory(next)
  set((state) => ({ entries: state.entries.map((entry) => (entry.id === id ? next : entry)) }))
}

export const restoreMemory = async (id: string): Promise<void> => {
  const target = get().entries.find((entry) => entry.id === id)
  if (!target) {
    return
  }
  const next = restore(target, Date.now())
  await db.putMemory(next)
  set((state) => ({ entries: state.entries.map((entry) => (entry.id === id ? next : entry)) }))
}

export const clearAllMemory = async (): Promise<void> => {
  await db.clearMemories()
  set({ entries: [] })
}

/** 把抽取出的写操作应用到现有条目上；手动与锁定条目不会被自动改写或删除 */
const applyOperations = (
  entries: MemoryEntry[],
  operations: ExtractedOperation[],
  now: number
): { entries: MemoryEntry[]; added: number; updated: number; deleted: string[] } => {
  let next = [...entries]
  const indexById = new Map(next.map((entry, index) => [entry.id, index]))
  const rebuild = () => {
    indexById.clear()
    next.forEach((entry, index) => indexById.set(entry.id, index))
  }
  let added = 0
  let updated = 0
  const deleted: string[] = []

  for (const operation of operations) {
    if (operation.op === 'delete') {
      const index = indexById.get(operation.id)
      if (index === undefined) {
        continue
      }
      const target = next[index]
      if (target.pinned || target.manual) {
        continue
      }
      next.splice(index, 1)
      deleted.push(target.id)
      rebuild()
      continue
    }
    if (operation.op === 'add') {
      // 仍然走一次相似合并，避免模型漏判导致的同义重复
      const result = mergeExtracted(next, operation.entry, now)
      next = result.entries
      if (result.merged) {
        updated += 1
      } else {
        added += 1
      }
      rebuild()
      continue
    }
    const index = indexById.get(operation.id)
    if (index === undefined) {
      continue
    }
    const target = next[index]
    if (target.pinned || target.manual) {
      continue
    }
    next[index] = {
      ...review(target, now),
      text: operation.entry.text,
      keywords: [...new Set([...target.keywords, ...operation.entry.keywords])].slice(0, 8),
      importance: Math.max(target.importance, operation.entry.importance),
      sourceMessageIds: [
        ...new Set([...target.sourceMessageIds, ...operation.entry.sourceMessageIds]),
      ],
    }
    updated += 1
  }
  return { entries: next, added, updated, deleted }
}

/**
 * 回复结束后抽取记忆。
 * 只在开启「自动记忆」、有 DeepSeek Key 且该会话没有正在抽取时执行；
 * 同一会话串行，避免连续发言时并发请求。
 */
export const extractRoundMemory = async (
  sessionId: string,
  userText: string,
  replyText: string,
  sourceMessageIds: string[]
): Promise<void> => {
  const settings = useSettings.getState()
  if (!settings.memoryWriteEnabled) {
    return
  }
  const apiKey = getDeepseekApiKey()
  if (!apiKey || get().extracting[sessionId]) {
    return
  }
  set((state) => ({ extracting: { ...state.extracting, [sessionId]: true } }))
  try {
    const operations = await extractFromRound({
      apiKey,
      locale: settings.locale,
      existing: get().entries,
      sourceSessionId: sessionId,
      userText,
      replyText,
      sourceMessageIds,
    })
    if (operations.length === 0) {
      return
    }
    const { entries, added, updated, deleted } = applyOperations(
      get().entries,
      operations,
      Date.now()
    )
    // 条目量级很小（几十到几百），整体回写比逐条 diff 更简单可靠
    await db.putMemories(entries)
    if (deleted.length > 0) {
      await Promise.all(deleted.map((id) => db.deleteMemory(id)))
    }
    set({ entries })
    if (added + updated + deleted.length > 0) {
      showToast({
        key: 'memoryUpdatedToast',
        params: { added, updated, deleted: deleted.length },
      })
    }
  } finally {
    set((state) => ({
      extracting: Object.fromEntries(
        Object.entries(state.extracting).filter(([id]) => id !== sessionId)
      ),
    }))
  }
}
