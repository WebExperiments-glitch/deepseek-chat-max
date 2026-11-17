import { sqlAll, sqlTransaction } from '../platform/sqlite.js'
import type { MemoryEntry } from './types.js'

/**
 * 记忆层的本地存储。
 *
 * 与会话共用一个 SQLite 库，但独立一张 memories 表：
 * 会话淘汰、导入替换都只动 sessions / files，不会碰到记忆；
 * 反过来清空记忆也不会影响聊天记录。
 *
 * 所有数据只在本机，不上传服务端。
 */

type MemoryRow = {
  id: string
  sourceSessionId: string
  kind: string
  text: string
  keywords: string
  stability: number
  difficulty: number
  reps: number
  lapses: number
  createdAt: number
  lastReviewAt: number
  sourceMessageIds: string
  pinned: number
  archived: number
  manual: number
  importance: number
}

/** 存储不可用（隐私模式、WASM 加载失败）时的内存兜底，保证当次使用不中断 */
const fallback = new Map<string, MemoryEntry>()

const withFallback = async <T>(task: () => Promise<T>, backup: () => T): Promise<T> => {
  try {
    return await task()
  } catch {
    return backup()
  }
}

const parseArray = (raw: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

const toEntry = (row: MemoryRow): MemoryEntry => ({
  id: row.id,
  sourceSessionId: row.sourceSessionId,
  kind: row.kind as MemoryEntry['kind'],
  text: row.text,
  keywords: parseArray(row.keywords),
  stability: row.stability,
  difficulty: row.difficulty,
  reps: row.reps,
  lapses: row.lapses,
  createdAt: row.createdAt,
  lastReviewAt: row.lastReviewAt,
  sourceMessageIds: parseArray(row.sourceMessageIds),
  pinned: row.pinned === 1,
  archived: row.archived === 1,
  manual: row.manual === 1,
  importance: row.importance,
})

const paramsOf = (entry: MemoryEntry) => [
  entry.id,
  entry.sourceSessionId,
  entry.kind,
  entry.text,
  JSON.stringify(entry.keywords),
  entry.stability,
  entry.difficulty,
  entry.reps,
  entry.lapses,
  entry.createdAt,
  entry.lastReviewAt,
  JSON.stringify(entry.sourceMessageIds),
  entry.pinned ? 1 : 0,
  entry.archived ? 1 : 0,
  entry.manual ? 1 : 0,
  entry.importance,
]

const UPSERT = `INSERT OR REPLACE INTO memories
  (id, sourceSessionId, kind, text, keywords, stability, difficulty, reps, lapses,
   createdAt, lastReviewAt, sourceMessageIds, pinned, archived, manual, importance)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

export const listMemories = async (): Promise<MemoryEntry[]> =>
  withFallback(
    async () => (await sqlAll<MemoryRow>('SELECT * FROM memories ORDER BY createdAt ASC')).map(toEntry),
    () => [...fallback.values()].sort((a, b) => a.createdAt - b.createdAt)
  )

export const putMemory = async (entry: MemoryEntry): Promise<void> =>
  withFallback(
    async () => {
      await sqlTransaction((db) => {
        db.run(UPSERT, paramsOf(entry))
      })
    },
    () => {
      fallback.set(entry.id, entry)
    }
  )

export const putMemories = async (entries: MemoryEntry[]): Promise<void> => {
  if (entries.length === 0) {
    return
  }
  await withFallback(
    async () => {
      await sqlTransaction((db) => {
        for (const entry of entries) {
          db.run(UPSERT, paramsOf(entry))
        }
      })
    },
    () => {
      for (const entry of entries) {
        fallback.set(entry.id, entry)
      }
    }
  )
}

export const deleteMemory = async (id: string): Promise<void> =>
  withFallback(
    async () => {
      await sqlTransaction((db) => {
        db.run('DELETE FROM memories WHERE id = ?', [id])
      })
    },
    () => {
      fallback.delete(id)
    }
  )

export const clearMemories = async (): Promise<void> =>
  withFallback(
    async () => {
      await sqlTransaction((db) => {
        db.run('DELETE FROM memories')
      })
    },
    () => {
      fallback.clear()
    }
  )
