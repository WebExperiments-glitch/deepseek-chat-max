import { describe, it, expect, vi } from 'vitest'

const {
  regionCodes,
  provinces,
  getRegionName,
  locationFromTimeZone,
  currentTimeZoneLocation,
  normalizeLocation,
} = await import('./location.js')

describe('省市与地区数据', () => {
  it('provinces 覆盖 34 个省级行政区', () => {
    expect(provinces).toHaveLength(34)
    const guangdong = provinces.find((item) => item.code === '440000')
    expect(guangdong?.name).toBe('广东省')
    expect(guangdong?.cities).toContainEqual({ code: '440300', name: '深圳市' })
  })

  it('城市按省份代码前两位归属', () => {
    const beijing = provinces.find((item) => item.code === '110000')
    expect(beijing?.cities).toEqual([{ code: '110100', name: '北京市' }])
    const jiangsu = provinces.find((item) => item.code === '320000')
    expect(jiangsu?.cities.some((city) => city.code === '320500' && city.name === '苏州市')).toBe(
      true
    )
    expect(jiangsu?.cities.some((city) => city.code === '110100')).toBe(false)
  })

  it('regionCodes 导出可用地区列表', () => {
    expect(regionCodes).toContain('CN')
    expect(regionCodes).toContain('US')
    expect(regionCodes).not.toContain('XX')
  })
})

describe('getRegionName 地区名称', () => {
  it('港澳台使用固定中英文名称', () => {
    expect(getRegionName('HK', 'zh-CN')).toBe('中国香港')
    expect(getRegionName('HK', 'en-US')).toBe('Hong Kong, China')
    expect(getRegionName('TW', 'zh-CN')).toBe('中国台湾')
    expect(getRegionName('MO', 'en-US')).toBe('Macao, China')
  })

  it('其他地区交给 Intl，非法代码返回空串', () => {
    expect(getRegionName('US', 'en-US')).toBe('United States')
    expect(getRegionName('US', 'zh-CN')).toBe('美国')
    expect(getRegionName('XX', 'en-US')).toBe('')
    expect(getRegionName('', 'en-US')).toBe('')
  })
})

describe('locationFromTimeZone 时区推断', () => {
  it('中国时区推断到省市', () => {
    expect(locationFromTimeZone('Asia/Shanghai')).toEqual({
      region: 'CN',
      province: '310000',
      city: '310100',
    })
    expect(locationFromTimeZone('Asia/Chongqing')).toEqual({
      region: 'CN',
      province: '500000',
      city: '500100',
    })
    expect(locationFromTimeZone('Asia/Harbin')).toEqual({
      region: 'CN',
      province: '230000',
      city: '230100',
    })
    expect(locationFromTimeZone('Asia/Urumqi')).toEqual({
      region: 'CN',
      province: '650000',
      city: '650100',
    })
  })

  it('未列出城市的中国时区只给国家', () => {
    expect(locationFromTimeZone('Asia/Kashgar')).toEqual({ region: 'CN' })
    expect(locationFromTimeZone('Asia/Hong_Kong')).toEqual({ region: 'HK' })
  })

  it('外国时区只给出地区', () => {
    expect(locationFromTimeZone('America/New_York')).toEqual({ region: 'US' })
    expect(locationFromTimeZone('Asia/Tokyo')).toEqual({ region: 'JP' })
    expect(locationFromTimeZone('Australia/Sydney')).toEqual({ region: 'AU' })
  })

  it('未知时区返回 null', () => {
    expect(locationFromTimeZone('Mars/Olympus')).toBeNull()
    expect(locationFromTimeZone('')).toBeNull()
  })

  it('currentTimeZoneLocation 读取系统时区', () => {
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ timeZone: 'Asia/Shanghai' } as never)
    expect(currentTimeZoneLocation()).toEqual({
      region: 'CN',
      province: '310000',
      city: '310100',
    })
    spy.mockRestore()
  })

  it('currentTimeZoneLocation 拿不到时区时返回 null', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({} as never)
    expect(currentTimeZoneLocation()).toBeNull()
    spy.mockRestore()
  })
})

describe('normalizeLocation 规范化', () => {
  it('拒绝非对象与非法地区', () => {
    expect(normalizeLocation(null)).toBeNull()
    expect(normalizeLocation('CN')).toBeNull()
    expect(normalizeLocation([])).toBeNull()
    expect(normalizeLocation({ region: 'XX' })).toBeNull()
    expect(normalizeLocation({ region: 123 })).toBeNull()
  })

  it('非中国地区只保留 region', () => {
    expect(normalizeLocation({ region: 'US', province: 'x', city: 'y' })).toEqual({ region: 'US' })
  })

  it('中国地区按省市编码校验与回退', () => {
    expect(normalizeLocation({ region: 'CN' })).toEqual({ region: 'CN' })
    expect(normalizeLocation({ region: 'CN', city: '440300' })).toBeNull()
    expect(normalizeLocation({ region: 'CN', province: '440000' })).toEqual({
      region: 'CN',
      province: '440000',
    })
    expect(normalizeLocation({ region: 'CN', province: '440000', city: '440300' })).toEqual({
      region: 'CN',
      province: '440000',
      city: '440300',
    })
    expect(normalizeLocation({ region: 'CN', province: '999999' })).toBeNull()
    expect(normalizeLocation({ region: 'CN', province: '440000', city: '110100' })).toBeNull()
  })
})
