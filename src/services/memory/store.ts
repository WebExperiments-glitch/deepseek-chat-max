import { create } from 'zustand'
import { createId } from '../../utils/id.js'
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
} from './ebbinghaus.js'
import { extractFromRound } from './extract.js'
import { ensureServerMigrated } from '../platform/migrateToServer.js'
import * as db from './db.js'
import { DEFAULT_MEMORY_BUDGET, type MemoryEntry, type MemoryView } from './types.js'

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
export const memoryBlockForQuery = (query: string): string => {
  // 关掉开关后既不再注入，也不再因为「被选中」而强化条目
  if (!useSettings.getState().memoryEnabled) {
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
    useSettings.getState().locale
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
export const addManualMemory = async (text: string): Promise<boolean> => {
  const trimmed = text.trim()
  if (!trimmed) {
    return false
  }
  const now = Date.now()
  const entry: MemoryEntry = {
    id: createId(),
    sourceSessionId: '',
    kind: 'fact',
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
    importance: 0.9,
  }
  await db.putMemory(entry)
  set((state) => ({ entries: [...state.entries, entry] }))
  return true
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

/**
 * 回复结束后抽取记忆。
 * 只在开启记忆、有 DeepSeek Key 且该会话没有正在抽取时执行；
 * 同一会话串行，避免连续发言时并发请求。
 */
export const extractRoundMemory = async (
  sessionId: string,
  userText: string,
  replyText: string,
  sourceMessageIds: string[]
): Promise<void> => {
  const settings = useSettings.getState()
  if (!settings.memoryEnabled) {
    return
  }
  const apiKey = getDeepseekApiKey()
  if (!apiKey || get().extracting[sessionId]) {
    return
  }
  set((state) => ({ extracting: { ...state.extracting, [sessionId]: true } }))
  try {
    const extracted = await extractFromRound({
      apiKey,
      locale: settings.locale,
      sourceSessionId: sessionId,
      userText,
      replyText,
      sourceMessageIds,
    })
    if (extracted.length === 0) {
      return
    }
    const now = Date.now()
    let entries = get().entries
    for (const candidate of extracted) {
      entries = mergeExtracted(entries, candidate, now).entries
    }
    // 条目量级很小（几十到几百），整体回写比逐条 diff 更简单可靠
    await db.putMemories(entries)
    set({ entries })
  } finally {
    set((state) => ({
      extracting: Object.fromEntries(
        Object.entries(state.extracting).filter(([id]) => id !== sessionId)
      ),
    }))
  }
}
