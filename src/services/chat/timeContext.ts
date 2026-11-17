import type { Locale } from '../settings.js'
import { formatDate } from '../../utils/format.js'

/**
 * 当前时间上下文。
 *
 * 为什么单独一段而不是塞进 latest_reminder：
 * latest_reminder 的格式被文档固定为 date,weekday,location,platform,language，
 * 没有时分；而模型需要知道「现在几点」。这段文本进入**本轮提问的末尾**，
 * 不会改变系统提示词与历史前缀，因此不会破坏提示词缓存。
 */
export const formatTimeContext = (locale: Locale, now = new Date()): string => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const date = formatDate(now)
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
