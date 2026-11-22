import { describe, expect, it } from 'vitest'
import type { CatalogModel } from './modelCatalog.js'
import {
  compareModels,
  filterModels,
  isFree,
  matchesText,
  selectModels,
  sortModels,
} from './modelPicker.js'

const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'p/m',
  modelId: 'm',
  name: 'Model M',
  providerId: 'p',
  providerName: 'Provider P',
  contextWindow: 128000,
  maxOutput: 32000,
  cost: { input: 1, output: 2 },
  capabilities: { tools: true, reasoning: false, temperature: true },
  inputModalities: ['text'],
  outputModalities: ['text'],
  apis: [],
  env: [],
  ...over,
})

describe('isFree', () => {
  it('输入价与输出价都为 0 才算免费', () => {
    expect(isFree(model({ cost: { input: 0, output: 0 } }))).toBe(true)
    expect(isFree(model({ cost: { input: 0, output: 1 } }))).toBe(false)
    expect(isFree(model({ cost: undefined }))).toBe(false)
  })
})

describe('matchesText', () => {
  it('匹配名称 / id / provider 名，且忽略标点与紧凑匹配', () => {
    expect(matchesText(model(), 'model m')).toBe(true)
    expect(matchesText(model(), 'provider-p')).toBe(true)
    expect(matchesText(model(), 'MODELM')).toBe(true)
    expect(matchesText(model(), 'nomatch')).toBe(false)
  })
})

describe('filterModels', () => {
  const mFree = model({ id: 'free', name: 'Free One', cost: { input: 0, output: 0 } })
  const mPaid = model({ id: 'paid', name: 'Paid One', cost: { input: 2, output: 4 } })
  const mUnknown = model({ id: 'unknown', name: 'Unknown', cost: undefined })
  const mVideo = model({
    id: 'video',
    name: 'Video Gen',
    outputModalities: ['video'],
    capabilities: { tools: false, reasoning: true, temperature: true },
  })

  it('free 筛选只返回免费模型', () => {
    expect(filterModels([mFree, mPaid, mUnknown], { free: true }).map((m) => m.id)).toEqual([
      'free',
    ])
  })

  it('价格区间默认排除未知价格，includeUnknownPrice 可保留', () => {
    expect(filterModels([mPaid, mUnknown], { price: [0, 5] }).map((m) => m.id)).toEqual(['paid'])
    expect(
      filterModels([mPaid, mUnknown], { price: [0, 5], includeUnknownPrice: true }).map((m) => m.id)
    ).toEqual(['paid', 'unknown'])
  })

  it('多模态筛选要求输出模态全部满足', () => {
    expect(filterModels([mVideo, mPaid], { modalities: ['video'] }).map((m) => m.id)).toEqual([
      'video',
    ])
    expect(filterModels([mVideo, mPaid], { textOnly: true }).map((m) => m.id)).toEqual(['paid'])
  })

  it('reasoning / tools / providers / 区间上下文筛选', () => {
    expect(filterModels([mVideo, mPaid], { reasoning: true }).map((m) => m.id)).toEqual(['video'])
    expect(filterModels([mVideo, mPaid], { tools: true }).map((m) => m.id)).toEqual(['paid'])
    expect(filterModels([mPaid], { providers: ['p'] }).map((m) => m.id)).toEqual(['paid'])
    expect(filterModels([mPaid], { providers: ['other'] })).toEqual([])
    expect(filterModels([mPaid], { context: [100000, 200000] }).map((m) => m.id)).toEqual(['paid'])
    expect(filterModels([mPaid], { context: [200000, 300000] })).toEqual([])
  })
})

describe('sortModels', () => {
  const cheap = model({ id: 'cheap', cost: { input: 0.1, output: 0.2 } })
  const pricey = model({ id: 'pricey', cost: { input: 5, output: 10 } })
  const unknown = model({ id: 'unknown', cost: undefined })

  it('价格升序便宜在前，未知排末尾', () => {
    expect(sortModels([pricey, unknown, cheap], 'price-asc').map((m) => m.id)).toEqual([
      'cheap',
      'pricey',
      'unknown',
    ])
  })

  it('价格降序贵在前，未知排末尾', () => {
    expect(sortModels([cheap, unknown, pricey], 'price-desc').map((m) => m.id)).toEqual([
      'pricey',
      'cheap',
      'unknown',
    ])
  })

  it('上下文降序', () => {
    const small = model({ id: 'small', contextWindow: 8000 })
    expect(sortModels([small, pricey], 'context-desc').map((m) => m.id)).toEqual([
      'pricey',
      'small',
    ])
  })
})

describe('selectModels / compareModels', () => {
  it('一键筛选+排序', () => {
    const a = model({ id: 'a', cost: { input: 3, output: 3 } })
    const b = model({ id: 'b', cost: { input: 1, output: 1 } })
    expect(selectModels([a, b], {}, 'price-asc').map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('对比按价格升序排列并只含选中项', () => {
    const a = model({ id: 'a', cost: { input: 3, output: 3 } })
    const b = model({ id: 'b', cost: { input: 1, output: 1 } })
    const c = model({ id: 'c', cost: { input: 2, output: 2 } })
    expect(compareModels([a, b, c], ['a', 'c']).map((m) => m.id)).toEqual(['c', 'a'])
  })
})
