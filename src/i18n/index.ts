import { useSyncExternalStore } from 'react'
import { en } from './en.js'
import { zh } from './zh.js'

export type TranslationKey = keyof typeof zh
export type TranslationParams = Record<string, string | number>
export type TranslationMessage = { key: TranslationKey; params?: TranslationParams }
/** 带文字链接的提示：link 跟在正文后，在新窗口打开；type 为 error 时前面带错误图标 */
export type LinkedMessage = TranslationMessage & {
  type?: 'error'
  link?: { key: TranslationKey; href: string }
}

export const isTranslationKey = (key: unknown): key is TranslationKey =>
  typeof key === 'string' && Object.hasOwn(zh, key)

const createTranslate =
  (messages: Record<TranslationKey, string>) =>
  (key: TranslationKey, params?: TranslationParams): string =>
    messages[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
      const value = params?.[name]
      return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder
    })

const translators = {
  'zh-CN': createTranslate(zh),
  'en-US': createTranslate(en),
}

/**
 * 语言状态由 i18n 自己持有（端口），不再读 settings store——断开
 * i18n → settings → speech → client → i18n 的循环依赖。
 * settings 切换语言时调用 setLocale，两侧保持同步（见 bootstrap）。
 */
let currentLocale = 'zh-CN'
const localeListeners = new Set<() => void>()

export const setLocale = (locale: string): void => {
  const next = locale === 'en-US' ? 'en-US' : 'zh-CN'
  if (next === currentLocale) {
    return
  }
  currentLocale = next
  for (const listener of localeListeners) {
    listener()
  }
}

export const getLocale = (): string => currentLocale

const subscribeLocale = (listener: () => void): (() => void) => {
  localeListeners.add(listener)
  return () => localeListeners.delete(listener)
}

/** 组件订阅语言变化（React useSyncExternalStore，不依赖 zustand）。 */
export const useTranslate = () => {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  return translators[locale as 'zh-CN' | 'en-US'] ?? translators['zh-CN']
}

export const translate = (
  key: TranslationKey,
  params?: TranslationParams,
  locale?: string
): string =>
  translators[(locale ?? currentLocale) as 'zh-CN' | 'en-US'](key, params)
