/**
 * 模型选型器核心：筛选 / 排序 / 对比。纯函数、与 UI 解耦、可单测。
 *
 * 设计原则（借鉴 dsh-ai-credits）：
 * - 未知价格显示未知，绝不填 0，也不误判为免费；
 * - 价格区间筛选时「未知价格」的模型单独保留（可选排除），不悄悄当成 0；
 * - 价格排序时未知排末尾，避免污染"最低价"。
 */

import type { CatalogModel } from './modelCatalog.js'

export type Modality = 'text' | 'image' | 'audio' | 'video' | 'pdf'

export type SortKey =
  | 'price-asc'
  | 'price-desc'
  | 'context-desc'
  | 'released-desc'
  | 'name-asc'
  | 'default'

export type ModelFilter = {
  /** 文本搜索：名称 / id / provider 名三字段 */
  text?: string
  /** 免费（输入价与输出价都为 0） */
  free?: boolean
  /** 价格区间（USD / 1M，按输入价）；未知价格的模型是否保留由 includeUnknownPrice 决定 */
  price?: [number, number]
  includeUnknownPrice?: boolean
  /** 上下文窗口区间 */
  context?: [number, number]
  /** 要求的输出模态（全部满足） */
  modalities?: Modality[]
  /** 仅纯文本模型（输出模态恰为 text） */
  textOnly?: boolean
  reasoning?: boolean
  tools?: boolean
  /** 供应商白名单 */
  providers?: string[]
}

const normalize = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')

/** 免费 = 输入价与输出价都为 0；无价格数据不算免费 */
export const isFree = (m: CatalogModel): boolean =>
  !!m.cost && m.cost.input === 0 && m.cost.output === 0

/** 名称 / id / provider 名三字段的紧凑匹配（借鉴 OpenCode matchesModelSearch） */
export const matchesText = (model: CatalogModel, text: string): boolean => {
  const needle = normalize(text)
  if (!needle) {
    return true
  }
  const fields = [model.name, model.id, model.providerName].map(normalize)
  return fields.some((f) => f.includes(needle))
}

const inRange = (value: number | undefined, range?: [number, number]): boolean => {
  if (!range) {
    return true
  }
  if (value === undefined) {
    return false
  }
  return value >= range[0] && value <= range[1]
}

/** 按条件筛选；条件之间是「与」关系 */
export const filterModels = (models: CatalogModel[], filter: ModelFilter): CatalogModel[] =>
  models.filter((m) => {
    if (filter.text && !matchesText(m, filter.text)) {
      return false
    }
    if (filter.free === true && !isFree(m)) {
      return false
    }
    if (filter.free === false && isFree(m)) {
      return false
    }
    if (filter.price) {
      const input = m.cost?.input
      if (input === undefined) {
        if (filter.includeUnknownPrice !== true) {
          return false
        }
      } else if (!inRange(input, filter.price)) {
        return false
      }
    }
    if (filter.context && !inRange(m.contextWindow, filter.context)) {
      return false
    }
    if (filter.modalities?.length) {
      const output = new Set(m.outputModalities)
      if (!filter.modalities.every((x) => output.has(x))) {
        return false
      }
    }
    if (filter.textOnly === true) {
      const output = m.outputModalities
      if (output.length !== 1 || output[0] !== 'text') {
        return false
      }
    }
    if (filter.reasoning === true && !m.capabilities.reasoning) {
      return false
    }
    if (filter.tools === true && !m.capabilities.tools) {
      return false
    }
    if (filter.providers?.length && !filter.providers.includes(m.providerId)) {
      return false
    }
    return true
  })

const priceOf = (m: CatalogModel): number | undefined => m.cost?.input

/** 排序：未知价格排在末尾（不论升降序），避免污染最低价 */
export const sortModels = (models: CatalogModel[], sort: SortKey): CatalogModel[] => {
  const list = [...models]
  switch (sort) {
    case 'price-asc':
      return list.sort((a, b) => {
        const pa = priceOf(a)
        const pb = priceOf(b)
        if (pa === undefined) {
          return pb === undefined ? 0 : 1
        }
        if (pb === undefined) {
          return -1
        }
        return pa - pb
      })
    case 'price-desc':
      return list.sort((a, b) => {
        const pa = priceOf(a)
        const pb = priceOf(b)
        if (pa === undefined) {
          return pb === undefined ? 0 : 1
        }
        if (pb === undefined) {
          return -1
        }
        return pb - pa
      })
    case 'context-desc':
      return list.sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))
    case 'released-desc':
      return list.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
    case 'name-asc':
      return list.sort((a, b) => a.name.localeCompare(b.name))
    default:
      return list
  }
}

/** 一键筛选 + 排序 */
export const selectModels = (
  models: CatalogModel[],
  filter: ModelFilter,
  sort: SortKey = 'default'
): CatalogModel[] => sortModels(filterModels(models, filter), sort)

/** 对比：挑出待对比模型，按价格升序排列便于横向阅读 */
export const compareModels = (models: CatalogModel[], selectedIds: string[]): CatalogModel[] => {
  const set = new Set(selectedIds)
  return sortModels(
    models.filter((m) => set.has(m.id)),
    'price-asc'
  )
}

/** 对比表里的一行（UI 直接渲染） */
export type CompareRow = {
  label: string
  values: string[]
}
