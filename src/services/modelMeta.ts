import { create } from 'zustand'
import type { ModelOption } from './api/client.js'
import { readStorage, writeStorage } from './platform/storage.js'

/**
 * models.dev 的模型元数据。
 *
 * 只做增强：拉取失败或字段缺失时保持原有模型清单不变。
 * 结果缓存在 localStorage 24 小时，避免每次启动都请求。
 */
export type ModelCost = { input: number; output: number }

export type ModelMeta = {
  id: string
  name: string
  providerId: string
  providerName: string
  contextWindow?: number
  maxOutput?: number
  inputModalities?: string[]
  reasoning?: boolean
  /** 每百万 token 的美元价格；.models.dev 的 cost.input/output 已是该单位 */
  cost?: ModelCost
}

/**
 * 免费模型判断：输入价与输出价都为 0（且价格数据存在）。
 * 不绑定特定供应商——任意 provider 的免费模型都能标注。
 * 免费是计费属性，不影响 token 统计。
 */
export const isFreeModel = (model: { cost?: ModelCost | null } | null | undefined): boolean => {
  const cost = model?.cost
  return !!cost && cost.input === 0 && cost.output === 0
}

type ModelMetaState = {
  entries: Record<string, ModelMeta>
  loading: boolean
  loaded: boolean
}

const META_URL = 'https://models.dev/api.json'
const CACHE_KEY = 'chat-demo:models-dev'
const CACHE_TTL = 24 * 60 * 60 * 1000

export const useModelMeta = create<ModelMetaState>(() => ({
  entries: {},
  loading: false,
  loaded: false,
}))

const positiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined

const stringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }
  const list = value.filter((item): item is string => typeof item === 'string' && item !== '')
  return list.length > 0 ? list : undefined
}

const parseMeta = (raw: unknown): Record<string, ModelMeta> => {
  if (raw === null || typeof raw !== 'object') {
    return {}
  }
  const entries: Record<string, ModelMeta> = {}
  for (const [providerId, providerValue] of Object.entries(raw as Record<string, unknown>)) {
    if (providerValue === null || typeof providerValue !== 'object') {
      continue
    }
    const provider = providerValue as Record<string, unknown>
    const providerName =
      typeof provider.name === 'string' ? provider.name : providerId
    const models = provider.models
    if (models === null || typeof models !== 'object') {
      continue
    }
    for (const [modelId, modelValue] of Object.entries(models as Record<string, unknown>)) {
      if (modelValue === null || typeof modelValue !== 'object') {
        continue
      }
      const model = modelValue as Record<string, unknown>
      const limit =
        model.limit !== null && typeof model.limit === 'object'
          ? (model.limit as Record<string, unknown>)
          : {}
      const modalities =
        model.modalities !== null && typeof model.modalities === 'object'
          ? (model.modalities as Record<string, unknown>)
          : {}
      const costRaw = model.cost !== null && typeof model.cost === 'object'
        ? (model.cost as Record<string, unknown>)
        : {}
      const inputCost = typeof costRaw.input === 'number' ? costRaw.input : undefined
      const outputCost = typeof costRaw.output === 'number' ? costRaw.output : undefined
      entries[modelId] = {
        id: modelId,
        name: typeof model.name === 'string' && model.name ? model.name : modelId,
        providerId,
        providerName,
        contextWindow: positiveInt(limit.context),
        maxOutput: positiveInt(limit.output),
        inputModalities: stringList(modalities.input),
        reasoning: model.reasoning === true,
        ...(inputCost !== undefined && outputCost !== undefined
          ? { cost: { input: inputCost, output: outputCost } }
          : {}),
      }
    }
  }
  return entries
}

const readCache = (): Record<string, ModelMeta> | null => {
  const raw = readStorage(CACHE_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') {
      return null
    }
    const record = parsed as { at?: unknown; entries?: unknown }
    if (typeof record.at !== 'number' || Date.now() - record.at > CACHE_TTL) {
      return null
    }
    return record.entries !== null && typeof record.entries === 'object'
      ? (record.entries as Record<string, ModelMeta>)
      : null
  } catch {
    return null
  }
}

let loadTask: Promise<void> | undefined

/** 启动时调用；有缓存先用缓存，再在后台刷新一次 */
export const loadModelMeta = (): Promise<void> => {
  if (loadTask) {
    return loadTask
  }
  const cached = readCache()
  if (cached) {
    useModelMeta.setState({ entries: cached, loaded: true })
  }
  loadTask = (async () => {
    useModelMeta.setState({ loading: true })
    try {
      const response = await fetch(META_URL, { cache: 'no-store' })
      if (!response.ok) {
        throw new Error(`models.dev ${response.status}`)
      }
      const entries = parseMeta(await response.json())
      if (Object.keys(entries).length > 0) {
        useModelMeta.setState({ entries, loaded: true })
        writeStorage(CACHE_KEY, JSON.stringify({ at: Date.now(), entries }))
      }
    } catch {
      // 元数据只是增强，失败时保留已有清单
    } finally {
      useModelMeta.setState({ loading: false })
      loadTask = undefined
    }
  })()
  return loadTask
}

export const getModelMeta = (id: string): ModelMeta | undefined =>
  useModelMeta.getState().entries[id]

/** 用 models.dev 补全缺失的上下文窗口、输出上限与输入模态 */
export const mergeModelMeta = (models: ModelOption[]): ModelOption[] =>
  models.map((model) => {
    const meta = getModelMeta(model.id)
    if (!meta) {
      return model
    }
    return {
      ...model,
      label: model.label === model.id && meta.name !== model.id ? meta.name : model.label,
      ...(model.contextWindow === undefined && meta.contextWindow !== undefined
        ? { contextWindow: meta.contextWindow }
        : {}),
      ...(model.maxOutputTokens === undefined && meta.maxOutput !== undefined
        ? { maxOutputTokens: meta.maxOutput }
        : {}),
      ...(model.inputModalities === undefined && meta.inputModalities !== undefined
        ? { inputModalities: meta.inputModalities }
        : {}),
      ...(model.cost === undefined && meta.cost !== undefined ? { cost: meta.cost } : {}),
    }
  })
