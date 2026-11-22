import { describe, it, expect, vi } from 'vitest'
import { formatDate } from '../../utils/format.js'
import type { Locale } from '../settings.js'
import type { UserLocation } from '../location.js'

// i18n 的 translate 依赖 settings，而 settings 的依赖链读取构建期全局常量：先桩后动态导入
vi.stubGlobal('__API_ORIGIN__', 'https://api.deepseek.com')
vi.stubGlobal('__DEV_PROXY_PREFIX__', '')

const { createLatestReminder } = await import('./latestReminder.js')
const { useSettings } = await import('../settings.js')
const { getRegionName } = await import('../location.js')

const setLocale = (locale: Locale) => useSettings.setState({ locale })

/** 2024-06-15 是星期六；用本地时间分量构造，避免时区导致的跨日 */
const SATURDAY = new Date(2024, 5, 15, 10, 30, 0)
const MONDAY = new Date(2024, 0, 1, 9, 5, 0)

const weekday = (locale: Locale, now: Date) =>
  new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now)

const fields = (reminder: string) => reminder.split(',')

describe('createLatestReminder 中英文与结构', () => {
  it('中文：日期、星期、空位置、Web、语言五个字段，逗号分隔', () => {
    setLocale('zh-CN')
    const reminder = createLatestReminder({ locale: 'zh-CN', location: null }, SATURDAY)
    const date = formatDate(SATURDAY) ?? ''

    expect(fields(reminder)).toEqual([date, weekday('zh-CN', SATURDAY), '', 'Web', '中文'])
    expect(reminder).toBe(`${date},${weekday('zh-CN', SATURDAY)},,Web,中文`)
  })

  it('英文：语言字段为 English，星期为英文', () => {
    setLocale('en-US')
    const reminder = createLatestReminder({ locale: 'en-US', location: null }, SATURDAY)
    const date = formatDate(SATURDAY) ?? ''

    expect(fields(reminder)).toEqual([date, weekday('en-US', SATURDAY), '', 'Web', 'English'])
    expect(reminder).toContain('Saturday')
  })

  it('注入不同日期时日期与星期同步变化', () => {
    setLocale('zh-CN')
    const saturday = createLatestReminder({ locale: 'zh-CN', location: null }, SATURDAY)
    const monday = createLatestReminder({ locale: 'zh-CN', location: null }, MONDAY)

    expect(saturday).toContain(formatDate(SATURDAY) ?? '')
    expect(saturday).toContain('星期六')
    expect(monday).toContain(formatDate(MONDAY) ?? '')
    expect(monday).toContain('星期一')
  })

  it('英文固定日期的星期与日期一致', () => {
    setLocale('en-US')
    const reminder = createLatestReminder({ locale: 'en-US', location: null }, MONDAY)
    expect(reminder).toContain(formatDate(MONDAY) ?? '')
    expect(reminder).toContain('Monday')
  })

  it('不传 now 时仍生成五个字段且平台为 Web', () => {
    setLocale('zh-CN')
    const parts = fields(createLatestReminder({ locale: 'zh-CN', location: null }))
    expect(parts).toHaveLength(5)
    expect(parts[3]).toBe('Web')
    expect(parts[4]).toBe('中文')
  })
})

describe('createLatestReminder 位置字段', () => {
  it('中国 + 中文：省市区号解析到城市名', () => {
    setLocale('zh-CN')
    const location: UserLocation = { region: 'CN', province: '330000', city: '330100' }
    const reminder = createLatestReminder({ locale: 'zh-CN', location }, SATURDAY)
    expect(fields(reminder)[2]).toBe('杭州市')
  })

  it('中国 + 中文：只有省时回落到省名', () => {
    setLocale('zh-CN')
    const location: UserLocation = { region: 'CN', province: '330000' }
    const reminder = createLatestReminder({ locale: 'zh-CN', location }, SATURDAY)
    expect(fields(reminder)[2]).toBe('浙江省')
  })

  it('中国 + 中文：省市区号无效时回落到国家名', () => {
    setLocale('zh-CN')
    const location: UserLocation = { region: 'CN', province: 'bad', city: 'bad' }
    const reminder = createLatestReminder({ locale: 'zh-CN', location }, SATURDAY)
    expect(fields(reminder)[2]).toBe(getRegionName('CN', 'zh-CN'))
  })

  it('中国 + 英文：不展开省市，直接使用国家名', () => {
    setLocale('en-US')
    const location: UserLocation = { region: 'CN', province: '330000', city: '330100' }
    const reminder = createLatestReminder({ locale: 'en-US', location }, SATURDAY)
    expect(fields(reminder)[2]).toBe(getRegionName('CN', 'en-US'))
    expect(fields(reminder)[2]).not.toContain('杭州')
  })

  it('非中国地区按语言给出地区名', () => {
    setLocale('zh-CN')
    const location: UserLocation = { region: 'US' }
    expect(fields(createLatestReminder({ locale: 'zh-CN', location }, SATURDAY))[2]).toBe(
      getRegionName('US', 'zh-CN')
    )

    setLocale('en-US')
    expect(fields(createLatestReminder({ locale: 'en-US', location }, SATURDAY))[2]).toBe(
      getRegionName('US', 'en-US')
    )
  })

  it('港澳台使用固定的中英文名称', () => {
    setLocale('zh-CN')
    expect(createLatestReminder({ locale: 'zh-CN', location: { region: 'HK' } }, SATURDAY)).toContain('中国香港')

    setLocale('en-US')
    const reminder = createLatestReminder({ locale: 'en-US', location: { region: 'HK' } }, SATURDAY)
    // 官方规范：location 允许包含逗号（Hong Kong, China），服务端按位置解析，不能删
    expect(reminder).toContain('Hong Kong, China')
    expect(reminder.endsWith('Web,English')).toBe(true)
  })

  it('未知地区代码的位置字段为空', () => {
    setLocale('en-US')
    const reminder = createLatestReminder({ locale: 'en-US', location: { region: 'XX' } }, SATURDAY)
    expect(fields(reminder)[2]).toBe('')
    expect(fields(reminder)).toHaveLength(5)
  })
})
