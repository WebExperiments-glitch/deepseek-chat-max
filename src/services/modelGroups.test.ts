import { describe, expect, it } from 'vitest'
import type { CatalogModel } from './modelCatalog.js'
import { groupByProvider, latestPerFamily, pinSections } from './modelGroups.js'

const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'p/m',
  modelId: 'm',
  name: 'M',
  providerId: 'p',
  providerName: 'Provider',
  cost: { input: 1, output: 2 },
  capabilities: { tools: true, reasoning: false, temperature: true },
  inputModalities: ['text'],
  outputModalities: ['text'],
  apis: [],
  env: [],
  ...over,
})

describe('groupByProvider', () => {
  it('按服务商分组，组内免费优先', () => {
    const paid = model({ id: 'p/a', name: 'A', modelId: 'a', cost: { input: 1, output: 1 } })
    const free = model({ id: 'p/b', name: 'B', modelId: 'b', cost: { input: 0, output: 0 } })
    const other = model({ id: 'q/c', name: 'C', modelId: 'c', providerId: 'q', providerName: 'Q' })
    const groups = groupByProvider([paid, free, other])
    expect(groups).toHaveLength(2)
    const p = groups.find((g) => g.id === 'p')
    expect(p?.models.map((m) => m.modelId)).toEqual(['b', 'a'])
  })
})

describe('latestPerFamily', () => {
  it('每个服务商+family+免费组合只留最新版本', () => {
    const old = model({ id: 'p/m1', modelId: 'm1', family: 'gpt', releaseDate: '2025-01-01' })
    const fresh = model({ id: 'p/m2', modelId: 'm2', family: 'gpt', releaseDate: '2026-06-01' })
    const freeOld = model({ id: 'p/f1', modelId: 'f1', family: 'gpt', releaseDate: '2025-01-01', cost: { input: 0, output: 0 } })
    const out = latestPerFamily([old, fresh, freeOld])
    expect(out).toHaveLength(2)
    expect(out.map((m) => m.modelId).sort()).toEqual(['f1', 'm2'])
  })
})

describe('pinSections', () => {
  it('收藏/最近置顶且不重复', () => {
    const a = model({ id: 'a' })
    const b = model({ id: 'b' })
    const c = model({ id: 'c' })
    const sections = pinSections([a, b, c], ['b'], ['b', 'c'])
    expect(sections[0].section).toBe('favorite')
    expect(sections[0].models.map((m) => m.id)).toEqual(['b'])
    expect(sections[1].section).toBe('recent')
    expect(sections[1].models.map((m) => m.id)).toEqual(['c'])
  })
})
