import { describe, expect, it } from 'vitest'
import {
  COMPACT_HEADROOM_TOKENS,
  COMPACT_THRESHOLD_RATIO,
  pressurePercent,
  reserveGeometry,
} from './contextPressure.js'

describe('reserveGeometry', () => {
  it('大窗口按 80% 阈值计算', () => {
    const reserve = reserveGeometry(1_000_000, 8192)
    expect(reserve).toBeDefined()
    expect(reserve?.threshold).toBe(Math.floor(1_000_000 * COMPACT_THRESHOLD_RATIO))
    expect(reserve?.output).toBe(8192)
    expect(reserve?.headroom).toBe(COMPACT_HEADROOM_TOKENS)
  })

  it('窗口较小时阈值受输出预留与余量约束', () => {
    const reserve = reserveGeometry(150_000, 40_000)
    expect(reserve?.threshold).toBe(150_000 - 40_000 - COMPACT_HEADROOM_TOKENS)
    expect(reserve?.threshold).toBeLessThan(Math.floor(150_000 * COMPACT_THRESHOLD_RATIO))
  })

  it('窗口装不下输出与余量时返回 undefined', () => {
    expect(reserveGeometry(50_000, 8192)).toBeUndefined()
  })

  it('输出预留被夹到窗口大小后压力预算为负，返回 undefined', () => {
    expect(reserveGeometry(100_000, 200_000)).toBeUndefined()
  })

  it('非法窗口返回 undefined', () => {
    expect(reserveGeometry(0, 8192)).toBeUndefined()
    expect(reserveGeometry(-1, 8192)).toBeUndefined()
    expect(reserveGeometry(Number.NaN, 8192)).toBeUndefined()
  })

  it('非法输出按 0 处理', () => {
    const reserve = reserveGeometry(1_000_000, Number.NaN)
    expect(reserve?.output).toBe(0)
  })
})

describe('pressurePercent', () => {
  it('按窗口折算', () => {
    expect(pressurePercent(500, 1000)).toBe(50)
    expect(pressurePercent(123, 1000)).toBe(12.3)
  })

  it('超过窗口时封顶 100', () => {
    expect(pressurePercent(2000, 1000)).toBe(100)
  })

  it('非法输入返回 0', () => {
    expect(pressurePercent(100, 0)).toBe(0)
    expect(pressurePercent(Number.NaN, 1000)).toBe(0)
  })
})
