import { describe, it, expect, vi, beforeEach } from 'vitest'

const { useModelMeta, loadModelMeta, getModelMeta, mergeModelMeta, isFreeModel } = await import(
  './modelMeta.js'
)

const makeStorage = () => {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
  }
}

const okResponse = (data: unknown) => ({ ok: true, status: 200, json: async () => data })
const failResponse = (status = 500) => ({ ok: false, status })

let storage: ReturnType<typeof makeStorage>
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  storage = makeStorage()
  vi.stubGlobal('localStorage', storage)
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  useModelMeta.setState({ entries: {}, loading: false, loaded: false })
})

describe('loadModelMeta 解析与缓存', () => {
  it('解析 models.dev 载荷并写入状态', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        openai: {
          name: 'OpenAI',
          models: {
            'gpt-4o': {
              name: 'GPT-4o',
              limit: { context: 128000, output: 16384 },
              modalities: { input: ['text', 'image'] },
              reasoning: false,
            },
            o1: { limit: { context: 200000, output: 100000 }, reasoning: true },
          },
        },
      })
    )
    await loadModelMeta()
    expect(fetchMock).toHaveBeenCalledWith('https://models.dev/api.json', { cache: 'no-store' })
    expect(getModelMeta('gpt-4o')).toMatchObject({
      id: 'gpt-4o',
      name: 'GPT-4o',
      providerId: 'openai',
      providerName: 'OpenAI',
      contextWindow: 128000,
      maxOutput: 16384,
      inputModalities: ['text', 'image'],
      reasoning: false,
    })
    expect(getModelMeta('o1')).toMatchObject({ name: 'o1', providerId: 'openai', reasoning: true })
    expect(useModelMeta.getState().loaded).toBe(true)
    expect(useModelMeta.getState().loading).toBe(false)
  })

  it('provider.name 缺失时回落到 providerId', async () => {
    fetchMock.mockResolvedValue(okResponse({ anthropic: { models: { m: {} } } }))
    await loadModelMeta()
    expect(getModelMeta('m')?.providerName).toBe('anthropic')
  })

  it('limit 正数取整、非正数忽略', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        p: {
          models: {
            a: { limit: { context: 12.7, output: 0 } },
            b: { limit: { context: -5, output: '99' } },
          },
        },
      })
    )
    await loadModelMeta()
    expect(getModelMeta('a')?.contextWindow).toBe(13)
    expect(getModelMeta('a')?.maxOutput).toBeUndefined()
    expect(getModelMeta('b')?.contextWindow).toBeUndefined()
    expect(getModelMeta('b')?.maxOutput).toBeUndefined()
  })

  it('modalities.input 过滤空值，全空时视为未知', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        p: {
          models: {
            a: { modalities: { input: ['text', '', 'image', 123] } },
            b: { modalities: { input: [''] } },
          },
        },
      })
    )
    await loadModelMeta()
    expect(getModelMeta('a')?.inputModalities).toEqual(['text', 'image'])
    expect(getModelMeta('b')?.inputModalities).toBeUndefined()
  })

  it('reasoning 仅显式 true 为真', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ p: { models: { a: { reasoning: true }, b: { reasoning: 1 }, c: { reasoning: 'true' } } } })
    )
    await loadModelMeta()
    expect(getModelMeta('a')?.reasoning).toBe(true)
    expect(getModelMeta('b')?.reasoning).toBe(false)
    expect(getModelMeta('c')?.reasoning).toBe(false)
  })

  it('跳过非法 provider 与 model 节点', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        bad1: null,
        bad2: { models: 'oops' },
        good: { models: { ok: { name: 'OK' }, bad: null, str: 'x' } },
      })
    )
    await loadModelMeta()
    expect(Object.keys(useModelMeta.getState().entries)).toEqual(['ok'])
  })

  it('成功后写入带时间戳的缓存', async () => {
    fetchMock.mockResolvedValue(okResponse({ p: { models: { m: { name: 'M' } } } }))
    await loadModelMeta()
    const raw = storage.getItem('chat-demo:models-dev')
    expect(raw).toBeTruthy()
    const cached = JSON.parse(raw as string)
    expect(cached.entries.m.name).toBe('M')
    expect(typeof cached.at).toBe('number')
  })

  it('有有效缓存时先用缓存，请求失败保留缓存', async () => {
    storage.setItem(
      'chat-demo:models-dev',
      JSON.stringify({
        at: Date.now(),
        entries: { cached: { id: 'cached', name: 'Cached', providerId: 'p', providerName: 'P' } },
      })
    )
    fetchMock.mockRejectedValue(new Error('offline'))
    await loadModelMeta()
    expect(useModelMeta.getState().entries.cached.name).toBe('Cached')
    expect(useModelMeta.getState().loaded).toBe(true)
    expect(useModelMeta.getState().loading).toBe(false)
  })

  it('过期缓存被忽略', async () => {
    storage.setItem(
      'chat-demo:models-dev',
      JSON.stringify({
        at: Date.now() - 25 * 60 * 60 * 1000,
        entries: { old: { id: 'old' } },
      })
    )
    fetchMock.mockResolvedValue(okResponse({ p: { models: { fresh: { name: 'Fresh' } } } }))
    await loadModelMeta()
    expect(getModelMeta('fresh')).toBeTruthy()
    expect(getModelMeta('old')).toBeUndefined()
  })

  it('损坏的缓存被忽略', async () => {
    storage.setItem('chat-demo:models-dev', '{not json')
    fetchMock.mockResolvedValue(okResponse({ p: { models: { m: {} } } }))
    await loadModelMeta()
    expect(getModelMeta('m')).toBeTruthy()
  })

  it('非 2xx 响应不更新条目', async () => {
    fetchMock.mockResolvedValue(failResponse(503))
    await loadModelMeta()
    expect(useModelMeta.getState().entries).toEqual({})
    expect(useModelMeta.getState().loaded).toBe(false)
    expect(useModelMeta.getState().loading).toBe(false)
  })

  it('空元数据不覆盖已有条目也不写缓存', async () => {
    useModelMeta.setState({
      entries: { keep: { id: 'keep', name: 'Keep', providerId: 'p', providerName: 'P' } },
      loaded: true,
    })
    fetchMock.mockResolvedValue(okResponse({}))
    await loadModelMeta()
    expect(getModelMeta('keep')).toBeTruthy()
    expect(storage.getItem('chat-demo:models-dev')).toBeNull()
  })

  it('并发调用共用同一个请求', async () => {
    let resolve!: (value: unknown) => void
    fetchMock.mockReturnValue(new Promise((r) => { resolve = r }))
    const first = loadModelMeta()
    const second = loadModelMeta()
    expect(first).toBe(second)
    resolve(okResponse({ p: { models: { m: {} } } }))
    await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('mergeModelMeta 元数据补全', () => {
  it('补全缺失的 label/上下文/输出/模态', () => {
    useModelMeta.setState({
      entries: {
        m: {
          id: 'm',
          name: 'Nice Name',
          providerId: 'p',
          providerName: 'P',
          contextWindow: 100,
          maxOutput: 50,
          inputModalities: ['text', 'image'],
          reasoning: false,
        },
      },
    })
    const merged = mergeModelMeta([
      { id: 'm', label: 'm' },
      { id: 'unknown', label: 'unknown' },
    ])
    expect(merged[0]).toEqual({
      id: 'm',
      label: 'Nice Name',
      contextWindow: 100,
      maxOutputTokens: 50,
      inputModalities: ['text', 'image'],
    })
    expect(merged[1]).toEqual({ id: 'unknown', label: 'unknown' })
  })

  it('不覆盖已有的 label 与字段', () => {
    useModelMeta.setState({
      entries: {
        m: { id: 'm', name: 'Meta Name', providerId: 'p', providerName: 'P', contextWindow: 100, maxOutput: 50 },
      },
    })
    const model = {
      id: 'm',
      label: 'My Label',
      contextWindow: 999,
      maxOutputTokens: 888,
      inputModalities: ['text'],
    }
    expect(mergeModelMeta([model])[0]).toEqual(model)
  })
})

describe('isFreeModel', () => {
  it('输入价与输出价都为 0 才是免费', () => {
    expect(isFreeModel({ cost: { input: 0, output: 0 } })).toBe(true)
    expect(isFreeModel({ cost: { input: 0, output: 1 } })).toBe(false)
    expect(isFreeModel({ cost: { input: 2, output: 0 } })).toBe(false)
  })

  it('无价格数据不算免费', () => {
    expect(isFreeModel({})).toBe(false)
    expect(isFreeModel({ cost: undefined })).toBe(false)
    expect(isFreeModel(null)).toBe(false)
    expect(isFreeModel(undefined)).toBe(false)
  })
})
