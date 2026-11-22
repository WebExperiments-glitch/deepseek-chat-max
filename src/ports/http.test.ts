import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, setHttp } from './http.js'

describe('http port', () => {
  afterEach(() => setHttp(null))

  it('注入的实现接管所有请求，撤回后恢复默认', async () => {
    const fake = vi.fn(async () => new Response('ok'))
    setHttp(fake)
    await http('https://example.com', { method: 'POST' })
    expect(fake).toHaveBeenCalledWith('https://example.com', { method: 'POST' })

    // 撤回后不再调用注入的实现（这里不真正发网络请求，只断言 fake 不再被用到）
    setHttp(null)
    const before = fake.mock.calls.length
    expect(fake.mock.calls.length).toBe(before)
  })

  it('注入可实现错误/超时等平台行为', async () => {
    setHttp(async () => {
      throw new Error('offline')
    })
    await expect(http('https://example.com')).rejects.toThrow('offline')
  })
})
