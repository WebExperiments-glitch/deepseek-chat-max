import { describe, it, expect } from 'vitest'
import { formatTimeContext } from './timeContext.js'
import { formatDate } from '../../utils/format.js'
import type { Locale } from '../settings.js'

const SATURDAY = new Date(2024, 5, 15, 10, 30, 0)
const MONDAY = new Date(2024, 0, 1, 9, 5, 0)
const EVENING = new Date(2024, 5, 15, 22, 15, 0)

const expected = (locale: Locale, now: Date): string => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const date = formatDate(now) ?? ''
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now)
  return locale === 'zh-CN'
    ? `当前时间：${date} ${time}（${weekday}，时区 ${timeZone}）`
    : `Current time: ${date} ${time} (${weekday}, ${timeZone})`
}

describe('formatTimeContext 中英文与固定时间', () => {
  it('中文输出与组合规则完全一致', () => {
    expect(formatTimeContext('zh-CN', SATURDAY)).toBe(expected('zh-CN', SATURDAY))
  })

  it('英文输出与组合规则完全一致', () => {
    expect(formatTimeContext('en-US', SATURDAY)).toBe(expected('en-US', SATURDAY))
  })

  it('使用注入时间的日期（YYYY-MM-DD）', () => {
    expect(formatTimeContext('zh-CN', SATURDAY)).toContain('2024-06-15')
    expect(formatTimeContext('en-US', SATURDAY)).toContain('2024-06-15')
    expect(formatTimeContext('en-US', SATURDAY)).not.toContain('2024/06/15')
  })

  it('中文星期与注入日期一致（2024-06-15 为星期六）', () => {
    expect(formatTimeContext('zh-CN', SATURDAY)).toContain('星期六')
  })

  it('英文星期与注入日期一致（2024-06-15 为 Saturday）', () => {
    expect(formatTimeContext('en-US', SATURDAY)).toContain('Saturday')
  })

  it('注入另一个日期时日期和星期同步变化（2024-01-01 为星期一 / Monday）', () => {
    const zh = formatTimeContext('zh-CN', MONDAY)
    const en = formatTimeContext('en-US', MONDAY)
    expect(zh).toContain('2024-01-01')
    expect(zh).toContain('星期一')
    expect(en).toContain('2024-01-01')
    expect(en).toContain('Monday')
  })

  it('包含注入时间的时分，且补零', () => {
    expect(formatTimeContext('zh-CN', SATURDAY)).toContain('10:30')
    expect(formatTimeContext('en-US', MONDAY)).toContain('09:05')
  })

  it('使用 24 小时制，晚上时间不出现 PM / 下午', () => {
    const zh = formatTimeContext('zh-CN', EVENING)
    const en = formatTimeContext('en-US', EVENING)
    expect(zh).toContain('22:15')
    expect(en).toContain('22:15')
    expect(en).not.toContain('PM')
    expect(zh).not.toContain('下午')
  })

  it('带上运行环境的时区', () => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    expect(formatTimeContext('zh-CN', SATURDAY)).toContain(`时区 ${timeZone}）`)
    expect(formatTimeContext('en-US', SATURDAY)).toContain(`, ${timeZone})`)
  })

  it('中文使用全角括号与逗号，英文使用半角', () => {
    expect(formatTimeContext('zh-CN', SATURDAY)).toMatch(/（.+，时区 .+）$/)
    expect(formatTimeContext('en-US', SATURDAY)).toMatch(/ \(.+, .+\)$/)
  })
})

describe('formatTimeContext 默认时间与边界', () => {
  it('不传 now 时仍生成结构完整的中文上下文', () => {
    expect(formatTimeContext('zh-CN')).toMatch(
      /^当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}（.+，时区 .+）$/
    )
  })

  it('不传 now 时仍生成结构完整的英文上下文', () => {
    expect(formatTimeContext('en-US')).toMatch(
      /^Current time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.+, .+\)$/
    )
  })

  it('不同注入时间产生不同结果', () => {
    expect(formatTimeContext('zh-CN', SATURDAY)).not.toBe(formatTimeContext('zh-CN', MONDAY))
  })
})
