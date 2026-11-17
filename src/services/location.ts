import { cityNames, regionCodes, regionNameOverrides, provinceNames } from './locationData.js'

export { regionCodes } from './locationData.js'

export const provinces = Object.entries(provinceNames).map(([code, name]) => ({
  code,
  name,
  cities: Object.entries(cityNames)
    .filter(([city]) => city.startsWith(code.slice(0, 2)))
    .map(([code, name]) => ({ code, name })),
}))

export type UserLocation = {
  region: string
  province?: string
  city?: string
}

const regions = new Set(regionCodes)
const regionNames = {
  'zh-CN': new Intl.DisplayNames(['zh-CN'], { type: 'region' }),
  'en-US': new Intl.DisplayNames(['en-US'], { type: 'region' }),
}

export const getRegionName = (code: string, locale: 'zh-CN' | 'en-US'): string =>
  regions.has(code)
    ? (regionNameOverrides[locale][code] ?? regionNames[locale].of(code) ?? code)
    : ''

/** 时区 → 国家/地区；只覆盖常见时区，未命中返回 null，不猜 */
const TIME_ZONE_REGIONS: Record<string, string> = {
  'Asia/Shanghai': 'CN',
  'Asia/Chongqing': 'CN',
  'Asia/Harbin': 'CN',
  'Asia/Urumqi': 'CN',
  'Asia/Kashgar': 'CN',
  'Asia/Hong_Kong': 'HK',
  'Asia/Macau': 'MO',
  'Asia/Taipei': 'TW',
  'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KR',
  'Asia/Singapore': 'SG',
  'Asia/Bangkok': 'TH',
  'Asia/Kolkata': 'IN',
  'Asia/Dubai': 'AE',
  'Europe/London': 'GB',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Moscow': 'RU',
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Los_Angeles': 'US',
  'America/Toronto': 'CA',
  'America/Sao_Paulo': 'BR',
  'Australia/Sydney': 'AU',
  'Pacific/Auckland': 'NZ',
}

/** 中国时区里能确定的城市，填到市一级，模型回答「你在哪」时更准确 */
const TIME_ZONE_CITIES: Record<string, { province: string; city: string }> = {
  'Asia/Shanghai': { province: '上海市', city: '上海市' },
  'Asia/Chongqing': { province: '重庆市', city: '重庆市' },
  'Asia/Harbin': { province: '黑龙江省', city: '哈尔滨市' },
  'Asia/Urumqi': { province: '新疆维吾尔自治区', city: '乌鲁木齐市' },
}

/**
 * 按浏览器时区推断所在地，作为「位置信息」未填写时的默认值。
 * 没有保存过位置时用它兜底，避免 latest_reminder 的地区字段一直是空的。
 */
export const locationFromTimeZone = (timeZone: string): UserLocation | null => {
  const region = TIME_ZONE_REGIONS[timeZone]
  if (!region) {
    return null
  }
  if (region !== 'CN') {
    return { region }
  }
  const target = TIME_ZONE_CITIES[timeZone]
  if (!target) {
    return { region }
  }
  const province = provinces.find((item) => item.name === target.province)
  const city = province?.cities.find((item) => item.name === target.city)
  return province
    ? { region, province: province.code, ...(city ? { city: city.code } : {}) }
    : { region }
}

/** 当前环境时区推断出的位置；拿不到时区时返回 null */
export const currentTimeZoneLocation = (): UserLocation | null => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return timeZone ? locationFromTimeZone(timeZone) : null
}

export const normalizeLocation = (value: unknown): UserLocation | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const location = value as Record<string, unknown>
  const { region, province, city } = location
  if (typeof region !== 'string' || !regions.has(region)) {
    return null
  }
  if (region !== 'CN') {
    return { region }
  }
  if (province === undefined) {
    return city === undefined ? { region } : null
  }
  const selectedProvince = provinces.find((item) => item.code === province)
  if (!selectedProvince) {
    return null
  }
  if (city === undefined) {
    return { region, province: selectedProvince.code }
  }
  const selectedCity = selectedProvince.cities.find((item) => item.code === city)
  return selectedCity ? { region, province: selectedProvince.code, city: selectedCity.code } : null
}
