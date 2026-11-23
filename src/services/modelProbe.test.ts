import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api/client.js'
import type { Provider } from './api/providers.js'
import { probeAvailableModels } from './modelProbe.js'

const provider: Provider = {
  id: 'deepseek',
  name: 'DeepSeek',
  protocol: 'openai',
  baseURL: 'https://api.deepseek.com',
  modelsURL: 'https://api.deepseek.com/models',
  defaultModel: 'deepseek-flash',
  capabilities: { deepseekTools: true, files: true, voice: true, title: true },
}

const ok = async () => {}
const err = (status: number, msg: string) => () => {
  throw new ApiError('http', msg, status)
}

describe('probeAvailableModels：/models 优先（零成本）', () => {
  it('/models 返回清单时直接采用，不探测', async () => {
    const probeOne = vi.fn(ok)
    const result = await probeAvailableModels(provider, 'k', {
      candidates: ['a', 'b'],
      listModels: async () => [
        { id: 'deepseek-flash', label: 'Flash' },
        { id: 'deepseek-v4-pro', label: 'Pro' },
      ],
      probeOne,
    })
    expect(result).toEqual({
      models: ['deepseek-flash', 'deepseek-v4-pro'],
      source: 'models-endpoint',
      tested: 0,
    })
    expect(probeOne).not.toHaveBeenCalled()
  })
})

describe('probeAvailableModels：/models 不可用时降级探测', () => {
  it('只保留探测成功的模型', async () => {
    const result = await probeAvailableModels(provider, 'k', {
      candidates: ['good-1', 'bad', 'good-2'],
      listModels: async () => {
        throw new Error('no /models')
      },
      probeOne: async (model) => {
        if (model === 'bad') {
          throw new ApiError('http', 'The supported API model names are a, b, but you passed bad.', 400)
        }
      },
    })
    expect(result.source).toBe('probe')
    expect(result.models).toEqual(['good-1', 'good-2'])
    expect(result.tested).toBe(3)
  })

  it('鉴权错误立即中止', async () => {
    const calls: string[] = []
    const result = await probeAvailableModels(provider, 'bad-key', {
      candidates: ['a', 'b', 'c', 'd'],
      concurrency: 1,
      listModels: async () => [],
      probeOne: async (model) => {
        calls.push(model)
        if (model === 'b') {
          throw new ApiError('http', 'invalid api key', 401)
        }
      },
    })
    expect(result.aborted).toBe('auth')
    // b 之后不应继续探测 c/d
    expect(calls).not.toContain('c')
    expect(calls).not.toContain('d')
  })

  it('余额不足立即中止', async () => {
    const result = await probeAvailableModels(provider, 'k', {
      candidates: ['a', 'b'],
      concurrency: 1,
      listModels: async () => [],
      probeOne: err(402, 'insufficient balance'),
    })
    expect(result.aborted).toBe('balance')
  })

  it('unsupported_model 只是跳过该候选，不中止', async () => {
    const result = await probeAvailableModels(provider, 'k', {
      candidates: ['bad', 'good'],
      concurrency: 1,
      listModels: async () => [],
      probeOne: async (model) => {
        if (model === 'bad') {
          throw new ApiError('http', 'unsupported model: bad', 400)
        }
      },
    })
    expect(result.aborted).toBeUndefined()
    expect(result.models).toEqual(['good'])
  })

  it('并发受限 + 进度回调', async () => {
    const progress: Array<[number, number]> = []
    let active = 0
    let maxActive = 0
    const result = await probeAvailableModels(provider, 'k', {
      candidates: ['a', 'b', 'c', 'd', 'e'],
      concurrency: 2,
      listModels: async () => [],
      probeOne: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 5))
        active -= 1
      },
      onProgress: (done, total) => progress.push([done, total]),
    })
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(result.tested).toBe(5)
    expect(progress.at(-1)).toEqual([5, 5])
  })

  it('候选去重 + 限制上限', async () => {
    const seen: string[] = []
    const result = await probeAvailableModels(provider, 'k', {
      candidates: ['a', 'a', 'b', 'c', 'd'],
      limit: 3,
      listModels: async () => [],
      probeOne: async (m) => {
        seen.push(m)
      },
    })
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(result.tested).toBe(3)
  })
})
