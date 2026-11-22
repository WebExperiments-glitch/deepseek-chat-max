/**
 * 模型选择器的分组逻辑（抄 OpenCode / DSH 模型选择器）。纯函数、与 UI 解耦、可单测。
 * - groupByProvider：按服务商分组，组内免费优先、再按名称；
 * - latestPerFamily：每个「服务商 + family + 是否免费」只保留最新版本（OpenCode 默认视图）；
 * - pinSections：收藏 / 最近置顶分组。
 */
import type { CatalogModel } from './modelCatalog.js'
import { isFree } from './modelPicker.js'

export type ModelGroup = {
  id: string
  name: string
  models: CatalogModel[]
}

/** 按服务商分组；组内免费优先、再按名称。传 alreadySorted=true 时保持入参顺序 */
export const groupByProvider = (models: CatalogModel[]): ModelGroup[] => {
  const map = new Map<string, CatalogModel[]>()
  for (const m of models) {
    const list = map.get(m.providerId) ?? []
    list.push(m)
    map.set(m.providerId, list)
  }
  return [...map.entries()]
    .map(([id, list]) => ({
      id,
      name: list[0]?.providerName ?? id,
      models: [...list].sort((a, b) => {
        const fa = isFree(a) ? 0 : 1
        const fb = isFree(b) ? 0 : 1
        return fa !== fb ? fa - fb : a.name.localeCompare(b.name)
      }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 每个「服务商 + family + 免费与否」只保留 releaseDate 最新的一条。
 * 无 family 的模型各自独立保留；无发布日期的排在有日期的之后。
 */
export const latestPerFamily = (models: CatalogModel[]): CatalogModel[] => {
  const groups = new Map<string, CatalogModel[]>()
  for (const m of models) {
    const family = m.family ?? `__solo__:${m.id}`
    const key = `${m.providerId}::${family}::${isFree(m) ? 'free' : 'paid'}`
    const list = groups.get(key) ?? []
    list.push(m)
    groups.set(key, list)
  }
  const out: CatalogModel[] = []
  for (const list of groups.values()) {
    const best = list.reduce((a, b) =>
      (b.releaseDate ?? '') > (a.releaseDate ?? '') ? b : a
    )
    out.push(best)
  }
  return out
}

/** 收藏 / 最近置顶分组（去重：已在较高优先级分组的不重复出现） */
export const pinSections = (
  models: CatalogModel[],
  favorites: string[],
  recent: string[]
): { section: string; models: CatalogModel[] }[] => {
  const byId = new Map(models.map((m) => [m.id, m]))
  const used = new Set<string>()
  const pick = (ids: string[]): CatalogModel[] => {
    const out: CatalogModel[] = []
    for (const id of ids) {
      const m = byId.get(id)
      if (m && !used.has(id)) {
        out.push(m)
        used.add(id)
      }
    }
    return out
  }
  return [
    { section: 'favorite', models: pick(favorites) },
    { section: 'recent', models: pick(recent) },
  ].filter((s) => s.models.length > 0)
}
