import { create } from 'zustand'
import { createId } from '../utils/id.js'
import { readStorage, writeStorage } from './platform/storage.js'
import { getCurrentModel, useSettings } from './settings.js'
import { getRegionName, provinces } from './location.js'
import { getDraft, setDraftText } from './chat/drafts.js'
import { getSession } from './chat/store/state.js'

/**
 * 提示词预设（含角色卡）。
 *
 * 预设只存在本机 localStorage：启用一套预设后，系统提示词优先使用它的正文，
 * 没有启用时才回落到设置里的「自定义系统提示词」。
 */
export type PromptPreset = {
  id: string
  name: string
  content: string
  /** 角色卡开场白：在空会话里启用预设时填入输入框，不伪造助手消息 */
  openingMessage?: string
}

type PresetState = {
  presets: PromptPreset[]
  activeId: string | null
}

const KEYS = {
  presets: 'chat-demo:prompt-presets',
  active: 'chat-demo:active-preset',
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const readPresets = (): PromptPreset[] => {
  const raw = readStorage(KEYS.presets)
  if (!raw) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.flatMap((item) => {
      if (
        !isRecord(item) ||
        typeof item.id !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.content !== 'string'
      ) {
        return []
      }
      return [
        {
          id: item.id,
          name: item.name,
          content: item.content,
          ...(typeof item.openingMessage === 'string' && item.openingMessage !== ''
            ? { openingMessage: item.openingMessage }
            : {}),
        },
      ]
    })
  } catch {
    return []
  }
}

const readActiveId = (presets: PromptPreset[]): string | null => {
  const id = readStorage(KEYS.active)
  return id && presets.some((preset) => preset.id === id) ? id : null
}

const initialPresets = readPresets()

export const usePresets = create<PresetState>(() => ({
  presets: initialPresets,
  activeId: readActiveId(initialPresets),
}))

const save = (presets: PromptPreset[], activeId: string | null) => {
  writeStorage(KEYS.presets, JSON.stringify(presets))
  writeStorage(KEYS.active, activeId)
  usePresets.setState({ presets, activeId })
}

export const createPreset = (input: {
  name: string
  content: string
  openingMessage?: string
}): PromptPreset => {
  const preset: PromptPreset = {
    id: createId(),
    name: input.name.trim(),
    content: input.content.trim(),
    ...(input.openingMessage?.trim() ? { openingMessage: input.openingMessage.trim() } : {}),
  }
  const { presets, activeId } = usePresets.getState()
  save([...presets, preset], activeId)
  return preset
}

export const updatePreset = (
  id: string,
  patch: Partial<Pick<PromptPreset, 'name' | 'content' | 'openingMessage'>>
) => {
  const { presets, activeId } = usePresets.getState()
  save(
    presets.map((preset) => {
      if (preset.id !== id) {
        return preset
      }
      const next: PromptPreset = {
        ...preset,
        ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
        ...(patch.content === undefined ? {} : { content: patch.content.trim() }),
      }
      if (patch.openingMessage !== undefined) {
        if (patch.openingMessage.trim()) {
          next.openingMessage = patch.openingMessage.trim()
        } else {
          delete next.openingMessage
        }
      }
      return next
    }),
    activeId
  )
}

export const deletePreset = (id: string) => {
  const { presets, activeId } = usePresets.getState()
  save(
    presets.filter((preset) => preset.id !== id),
    activeId === id ? null : activeId
  )
}

export const setActivePreset = (id: string | null) => {
  const { presets } = usePresets.getState()
  save(presets, id && presets.some((preset) => preset.id === id) ? id : null)
}

export const getActivePreset = (): PromptPreset | null => {
  const { presets, activeId } = usePresets.getState()
  return activeId ? (presets.find((preset) => preset.id === activeId) ?? null) : null
}

const weekday = (locale: string, date: Date): string => {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date)
  } catch {
    return ''
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 当前时间、模型与位置的变量上下文；请求前即时求值 */
export const resolvePromptVariables = (content: string): string => {
  const { locale, location, provider, models } = useSettings.getState()
  const now = new Date()
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`

  let locationText = ''
  if (location?.region) {
    if (location.region === 'CN') {
      const province = provinces.find((item) => item.code === location.province)
      const city = province?.cities.find((item) => item.code === location.city)
      locationText = [province?.name, city?.name].filter(Boolean).join(' ')
    } else {
      locationText = getRegionName(location.region, locale)
    }
  }

  const values: Record<string, string> = {
    cur_date: date,
    cur_time: time,
    cur_weekday: weekday(locale, now),
    model_name: models[provider] || getCurrentModel(),
    locale,
    location: locationText,
  }
  return content.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match)
}

/**
 * 已解析的预设正文，按会话缓存。
 *
 * DSH 的 KV Cache 结论：同一路由下，此前消息与系统提示词必须逐字节一致才能复用前缀。
 * 预设里的 {{cur_time}} 如果每轮重新求值，system 每分钟都会变，整个前缀缓存直接失效。
 * 因此会话内冻结首次解析结果；切换预设、模型、语言或位置时 key 变化，自然重新解析。
 * 当前时间仍然每轮通过请求尾部的 timeContext 注入。
 */
const resolvedBySession = new Map<string, { key: string; text: string }>()
const RESOLVED_LIMIT = 200

const presetCacheKey = (preset: PromptPreset): string => {
  const { locale, location, provider, models } = useSettings.getState()
  return [
    preset.id,
    preset.content,
    locale,
    provider,
    models[provider] ?? '',
    location?.region ?? '',
    location?.province ?? '',
    location?.city ?? '',
  ].join('|')
}

/** 会话删除后可调用；不调用也只是少量内存，超过上限会整体清空 */
export const clearResolvedPresetPrompt = (sessionId: string) => {
  resolvedBySession.delete(sessionId)
}

/**
 * 启用预设且正文非空时返回解析后的系统提示词；否则返回 null，由调用方回落到自定义提示词。
 * 传入 sessionId 时按会话冻结；不传（如设置页预览）则实时解析。
 */
export const getActivePresetPrompt = (sessionId?: string | null): string | null => {
  const preset = getActivePreset()
  if (!preset || preset.content.trim() === '') {
    return null
  }
  if (!sessionId) {
    return resolvePromptVariables(preset.content)
  }
  const key = presetCacheKey(preset)
  const cached = resolvedBySession.get(sessionId)
  if (cached?.key === key) {
    return cached.text
  }
  const text = resolvePromptVariables(preset.content)
  if (resolvedBySession.size >= RESOLVED_LIMIT) {
    resolvedBySession.clear()
  }
  resolvedBySession.set(sessionId, { key, text })
  return text
}

/**
 * 切换启用项。在空会话里带开场白的预设会填进输入框（仅草稿为空时），
 * 避免覆盖用户正在写的内容。
 */
export const applyPreset = (id: string | null, sessionId: string | null) => {
  setActivePreset(id)
  const preset = id ? usePresets.getState().presets.find((item) => item.id === id) : null
  if (!preset?.openingMessage) {
    return
  }
  if (sessionId !== null && (getSession(sessionId)?.messages.length ?? 0) > 0) {
    return
  }
  if (getDraft(sessionId).text.trim() !== '') {
    return
  }
  setDraftText(sessionId, preset.openingMessage)
}

export const exportPresets = (): string =>
  JSON.stringify(
    {
      version: 1,
      presets: usePresets.getState().presets.map((preset) => ({
        name: preset.name,
        content: preset.content,
        ...(preset.openingMessage ? { openingMessage: preset.openingMessage } : {}),
      })),
    },
    null,
    2
  )

/**
 * 导入预设：接受 { version, presets } 或直接数组，逐项校验后生成新 id 合并。
 * JSON 语法错误会抛出，由调用方提示导入失败。
 */
export const importPresets = (raw: string): number => {
  const parsed: unknown = JSON.parse(raw)
  let list: unknown[] = []
  if (Array.isArray(parsed)) {
    list = parsed
  } else if (isRecord(parsed) && Array.isArray(parsed.presets)) {
    list = parsed.presets
  }
  const imported = list.flatMap((item): PromptPreset[] => {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      typeof item.content !== 'string' ||
      item.name.trim() === '' ||
      item.content.trim() === ''
    ) {
      return []
    }
    return [
      {
        id: createId(),
        name: item.name.trim(),
        content: item.content.trim(),
        ...(typeof item.openingMessage === 'string' && item.openingMessage.trim()
          ? { openingMessage: item.openingMessage.trim() }
          : {}),
      },
    ]
  })
  if (imported.length === 0) {
    throw new Error('no valid presets')
  }
  const { presets, activeId } = usePresets.getState()
  save([...presets, ...imported], activeId)
  return imported.length
}
