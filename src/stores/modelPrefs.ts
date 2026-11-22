/**
 * 模型收藏 / 最近使用。localStorage 持久化，平台层可替换（iOS 移植）。
 * 借鉴 OpenCode：最近去重保留 N 条，收藏最新插入最前。
 */
import { create } from 'zustand'
import { readStorage, writeStorage } from '../services/platform/storage.js'

const KEY = 'chat-demo:model-prefs'
const RECENT_LIMIT = 8

export type ModelPrefs = {
  favorite: string[]
  recent: string[]
}

type PrefsState = ModelPrefs & {
  loaded: boolean
}

const defaults = (): ModelPrefs => ({ favorite: [], recent: [] })

const read = (): ModelPrefs => {
  const raw = readStorage(KEY)
  if (!raw) {
    return defaults()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ModelPrefs>
    return {
      favorite: Array.isArray(parsed.favorite)
        ? parsed.favorite.filter((x) => typeof x === 'string')
        : [],
      recent: Array.isArray(parsed.recent)
        ? parsed.recent.filter((x) => typeof x === 'string')
        : [],
    }
  } catch {
    return defaults()
  }
}

export const useModelPrefs = create<PrefsState>(() => ({
  ...read(),
  loaded: true,
}))

const persist = (next: ModelPrefs) => {
  writeStorage(KEY, JSON.stringify(next))
  useModelPrefs.setState(next)
}

/** 记录一次使用：去重后置顶，最多保留 RECENT_LIMIT 条 */
export const pushRecent = (id: string) => {
  const { favorite, recent } = useModelPrefs.getState()
  const next = [id, ...recent.filter((x) => x !== id)].slice(0, RECENT_LIMIT)
  persist({ favorite, recent: next })
}

/** 切换收藏：已收藏则取消，未收藏则置顶 */
export const toggleFavorite = (id: string) => {
  const { favorite, recent } = useModelPrefs.getState()
  const next = favorite.includes(id)
    ? favorite.filter((x) => x !== id)
    : [id, ...favorite.filter((x) => x !== id)]
  persist({ favorite: next, recent })
}

export const isFavorite = (id: string): boolean => useModelPrefs.getState().favorite.includes(id)
