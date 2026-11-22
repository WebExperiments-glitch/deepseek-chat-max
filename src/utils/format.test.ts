import { describe, it, expect } from 'vitest'

const { formatDate, monthKey } = await import('./format.js')

describe('formatDate 日期格式化', () => {
  it('格式化 Date 对象', () => {
    expect(formatDate(new Date(2024, 0, 5))).toBe('2024-01-05')
  })

  it('格式化日期字符串', () => {
    expect(formatDate('2024-01-05T12:00:00')).toBe('2024-01-05')
  })

  it('格式化时间戳数字', () => {
    expect(formatDate(new Date(2024, 5, 9).getTime())).toBe('2024-06-09')
  })

  it('支持自定义斜杠分隔符', () => {
    expect(formatDate(new Date(2024, 0, 5), '/')).toBe('2024/01/05')
  })

  it('月和日补零到两位', () => {
    expect(formatDate(new Date(2024, 2, 3))).toBe('2024-03-03')
  })

  it('年份补到四位', () => {
    const date = new Date(2024, 0, 5)
    date.setFullYear(99)
    expect(formatDate(date)).toBe('0099-01-05')
  })

  it('非法输入返回 null', () => {
    expect(formatDate('not a date')).toBeNull()
    expect(formatDate(new Date('bad'))).toBeNull()
    expect(formatDate(NaN)).toBeNull()
  })
})

describe('monthKey 月份键', () => {
  it('返回年-月格式', () => {
    expect(monthKey(new Date(2024, 0, 5))).toBe('2024-01')
    expect(monthKey('2024-12-31T12:00:00')).toBe('2024-12')
    expect(monthKey(new Date(2024, 5, 9).getTime())).toBe('2024-06')
  })

  it('非法输入返回 null', () => {
    expect(monthKey('bad')).toBeNull()
    expect(monthKey(NaN)).toBeNull()
  })
})
