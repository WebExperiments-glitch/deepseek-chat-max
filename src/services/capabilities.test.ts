import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from './capabilities.js'

describe('CapabilityRegistry', () => {
  it('找不到 id 时降级到 fallback，绝不返回空', () => {
    const fallback = { id: 'builtin', value: 'fallback-value' }
    const registry = new CapabilityRegistry(fallback)
    expect(registry.get('nonexistent')).toBe('fallback-value')
  })

  it('切换时先释放旧实现，再激活新实现', () => {
    const calls: string[] = []
    const fallback = { id: 'builtin', value: 'fallback' }
    const registry = new CapabilityRegistry(fallback)
    const disposeA = vi.fn(() => calls.push('disposeA'))
    registry.register({ id: 'a', value: 'A', dispose: disposeA })
    registry.register({ id: 'b', value: 'B' })
    registry.activate('a')
    expect(registry.get()).toBe('A')
    registry.activate('b')
    expect(registry.get()).toBe('B')
    expect(disposeA).toHaveBeenCalledTimes(1)
  })

  it('disposer 幂等，重复调用只释放一次', () => {
    const dispose = vi.fn()
    const registry = new CapabilityRegistry({ id: 'builtin', value: 'f' })
    const d = registry.register({ id: 'x', value: 'X', dispose })
    d()
    d()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('disposeAll 逆序释放且幂等', () => {
    const order: string[] = []
    const registry = new CapabilityRegistry({ id: 'builtin', value: 'f' })
    registry.register({ id: 'a', value: 'A', dispose: () => order.push('a') })
    registry.register({ id: 'b', value: 'B', dispose: () => order.push('b') })
    registry.disposeAll()
    registry.disposeAll()
    expect(order).toEqual(['b', 'a'])
  })

  it('订阅者在切换时收到通知，取消后不再收到', () => {
    const registry = new CapabilityRegistry({ id: 'builtin', value: 'f' })
    const listener = vi.fn()
    const off = registry.subscribe(listener)
    registry.activate('builtin')
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    registry.activate('builtin')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
