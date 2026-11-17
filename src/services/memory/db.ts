import { deleteJson, getJson, putJson } from '../api/localServer.js'
import type { MemoryEntry } from './types.js'

/**
 * 记忆层的本地存储。
 *
 * 与会话共用一个本机 SQLite 库，但独立 memories 表：
 * 会话淘汰、导入替换都只动 sessions / files，不会碰到记忆；
 * 反过来清空记忆也不会影响聊天记录。
 *
 * 所有数据只在本机，不上传外部服务。
 */

/** 本地服务不可用时的内存兜底，保证当次使用不中断 */
const fallback = new Map<string, MemoryEntry>()

const withFallback = async <T>(task: () => Promise<T>, backup: () => T): Promise<T> => {
  try {
    return await task()
  } catch {
    return backup()
  }
}

const sorted = () => [...fallback.values()].sort((a, b) => a.createdAt - b.createdAt)

export const listMemories = async (): Promise<MemoryEntry[]> =>
  withFallback(async () => (await getJson<{ memories: MemoryEntry[] }>('/api/memories')).memories, sorted)

export const putMemory = async (entry: MemoryEntry): Promise<void> =>
  withFallback(
    async () => {
      await putJson('/api/memories', { entries: [entry] })
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
      await putJson('/api/memories', { entries })
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
      await deleteJson(`/api/memories/${encodeURIComponent(id)}`)
    },
    () => {
      fallback.delete(id)
    }
  )

export const clearMemories = async (): Promise<void> =>
  withFallback(
    async () => {
      await deleteJson('/api/memories')
    },
    () => {
      fallback.clear()
    }
  )
