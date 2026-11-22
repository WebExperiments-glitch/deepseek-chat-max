import { describe, expect, it } from 'vitest'

const { parseCatalog } = await import('./modelCatalog.js')

const v2Sample = {
  'some-provider': {
    id: 'some-provider',
    name: 'Some Provider',
    env: ['SOME_API_KEY'],
    models: {
      m1: {
        id: 'm1',
        name: 'Model One',
        family: 'one',
        release_date: '2026-06-04',
        limit: { context: 262144, output: 128000 },
        cost: {
          text: {
            input: { price: 0.8, cache: { read: 0.14 } },
            output: { price: 3 },
          },
        },
        capabilities: {
          tools: { supported: true },
          reasoning: { supported: true, effort: ['none', 'high'] },
          temperature: true,
        },
        modalities: { input: ['text', 'image'], output: ['text'] },
        api: {
          'chat-completions': {
            base_url: 'https://api.example.com/v1',
            sdk: { aisdk: '@ai-sdk/openai-compatible' },
          },
        },
      },
      bad: {
        /* 缺 id，应跳过 */
      },
    },
  },
}

describe('parseCatalog', () => {
  it('解析 v2 结构为 CatalogModel，跳过损坏条目', () => {
    const models = parseCatalog(v2Sample)
    expect(models).toHaveLength(1)
    const m = models[0]
    expect(m.id).toBe('m1')
    expect(m.providerId).toBe('some-provider')
    expect(m.providerName).toBe('Some Provider')
    expect(m.contextWindow).toBe(262144)
    expect(m.maxOutput).toBe(128000)
    expect(m.cost).toEqual({ input: 0.8, output: 3 })
    expect(m.capabilities.tools).toBe(true)
    expect(m.capabilities.reasoning).toBe(true)
    expect(m.capabilities.effort).toEqual(['none', 'high'])
    expect(m.inputModalities).toEqual(['text', 'image'])
    expect(m.outputModalities).toEqual(['text'])
    expect(m.apis).toEqual([
      {
        protocol: 'chat-completions',
        baseURL: 'https://api.example.com/v1',
        sdk: '@ai-sdk/openai-compatible',
      },
    ])
    expect(m.env).toEqual(['SOME_API_KEY'])
  })

  it('非对象输入返回空数组', () => {
    expect(parseCatalog(null)).toEqual([])
    expect(parseCatalog('nope')).toEqual([])
  })

  it('缺失价格不产生 cost（不误判为免费）', () => {
    const models = parseCatalog({
      p: {
        id: 'p',
        name: 'P',
        env: [],
        models: { x: { id: 'x', name: 'X', limit: {}, modalities: {}, capabilities: {}, api: {} } },
      },
    })
    expect(models[0].cost).toBeUndefined()
  })
})
