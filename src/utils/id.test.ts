import { describe, it, expect, vi, afterEach } from 'vitest'

const { createId } = await import('./id.js')

const realCrypto = globalThis.crypto

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createId ID 生成', () => {
  it('默认使用 crypto.randomUUID', () => {
    const fn = vi.fn(() => 'uuid-123')
    vi.stubGlobal('crypto', { randomUUID: fn })
    expect(createId()).toBe('uuid-123')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('按 randomUUID 的返回值原样输出', () => {
    let counter = 0
    vi.stubGlobal('crypto', { randomUUID: () => `id-${++counter}` })
    expect([createId(), createId(), createId()]).toEqual(['id-1', 'id-2', 'id-3'])
  })

  it('真实环境生成标准 UUID', () => {
    vi.stubGlobal('crypto', realCrypto)
    expect(createId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('多次生成互不重复', () => {
    vi.stubGlobal('crypto', realCrypto)
    const ids = Array.from({ length: 100 }, () => createId())
    expect(new Set(ids).size).toBe(100)
  })

  it('总是返回非空字符串', () => {
    vi.stubGlobal('crypto', realCrypto)
    const id = createId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('randomUUID 不可用时回落到时间戳+随机数', () => {
    vi.stubGlobal('crypto', { randomUUID: undefined })
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(createId()).toBe('rs-i')
  })

  it('回落分支的时间戳使用 36 进制', () => {
    vi.stubGlobal('crypto', { randomUUID: null })
    vi.spyOn(Date, 'now').mockReturnValue(1296) // 36^2 => '100'
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(createId()).toBe('100-i')
  })

  it('回落分支随随机数变化', () => {
    vi.stubGlobal('crypto', {})
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const rand = vi.spyOn(Math, 'random')
    rand.mockReturnValueOnce(0.5).mockReturnValueOnce(0.25)
    const first = createId()
    const second = createId()
    expect(first).toBe('rs-i')
    expect(second).not.toBe(first)
  })
})
