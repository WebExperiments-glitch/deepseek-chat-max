/**
 * 模型目录：从 OpenCode 的实时目录（models.dev v2，MIT）加载完整模型元数据。
 *
 * 数据源 https://models.opencode.ai/experimental/v2.0/api.json?type=chat 浏览器可直连
 * （ACAO:*），每天自动更新。带 24h localStorage 缓存，失败降级到空目录。
 *
 * 这一层只负责「数据获取 + 归一化」，不含筛选/排序（在 modelPicker.ts）、不含 UI。
 * 纯函数 parseCatalog 可单测，符合"核心逻辑纯 TS、与 UI 解耦"的约束。
 */

import { create } from 'zustand'
import { readStorage, writeStorage } from '../services/platform/storage.js'
import { http } from '../ports/http.js'

export type ModelCapability = {
  tools: boolean
  reasoning: boolean
  effort?: string[]
  temperature: boolean
}

export type ModelApi = {
  protocol: 'chat-completions' | 'responses' | 'messages' | 'generate-content' | string
  baseURL: string
  sdk?: string
}

export type CatalogModel = {
  /** 全局唯一键（providerId/原始id）；同一模型可能出现在多个 provider，避免 key 冲突 */
  id: string
  /** 发给该 provider API 的原始模型 id */
  modelId: string
  name: string
  providerId: string
  providerName: string
  family?: string
  releaseDate?: string
  contextWindow?: number
  maxOutput?: number
  cost?: { input: number; output: number }
  capabilities: ModelCapability
  inputModalities: string[]
  outputModalities: string[]
  apis: ModelApi[]
  env: string[]
}

export type ModelCatalogState = {
  models: CatalogModel[]
  loading: boolean
  loaded: boolean
  updatedAt: number | null
}

const CATALOG_URL = 'https://models.opencode.ai/experimental/v2.0/api.json?type=chat'
const CACHE_KEY = 'chat-demo:model-catalog-v2'
const CACHE_TTL = 24 * 60 * 60 * 1000

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

/**
 * 把 OpenCode v2 api.json 归一化成 CatalogModel[]。
 * 只取选型器需要的字段，未知字段忽略；单个模型解析失败则跳过，不影响其他模型。
 */
export const parseCatalog = (raw: unknown): CatalogModel[] => {
  const root = record(raw)
  const out: CatalogModel[] = []
  for (const [providerId, providerValue] of Object.entries(root)) {
    const provider = record(providerValue)
    const providerName = typeof provider.name === 'string' ? provider.name : providerId
    const env = strList(provider.env)
    const models = record(provider.models)
    for (const [, modelValue] of Object.entries(models)) {
      try {
        const m = record(modelValue)
        const id = typeof m.id === 'string' ? m.id : ''
        if (!id) {
          continue
        }
        const limit = record(m.limit)
        const cost = record(m.cost)
        const text = record(cost.text)
        const input = record(text.input)
        const output = record(text.output)
        const caps = record(m.capabilities)
        const tools = record(caps.tools)
        const reasoning = record(caps.reasoning)
        const modalities = record(m.modalities)
        const api = record(m.api)
        const inputPrice = num(input.price)
        const outputPrice = num(output.price)

        out.push({
          id: `${providerId}/${id}`,
          modelId: id,
          name: typeof m.name === 'string' && m.name ? m.name : id,
          providerId,
          providerName,
          family: typeof m.family === 'string' ? m.family : undefined,
          releaseDate: typeof m.release_date === 'string' ? m.release_date : undefined,
          contextWindow: num(limit.context),
          maxOutput: num(limit.output),
          ...(inputPrice !== undefined && outputPrice !== undefined
            ? { cost: { input: inputPrice, output: outputPrice } }
            : {}),
          capabilities: {
            tools: tools.supported === true,
            reasoning: reasoning.supported === true,
            effort: strList(reasoning.effort),
            temperature: caps.temperature === true,
          },
          inputModalities: strList(modalities.input),
          outputModalities: strList(modalities.output),
          apis: Object.entries(api).flatMap(([protocol, value]) => {
            const entry = record(value)
            const baseURL = typeof entry.base_url === 'string' ? entry.base_url : ''
            if (!baseURL) {
              return []
            }
            const sdk = record(entry.sdk)
            return [
              {
                protocol,
                baseURL,
                ...(typeof sdk.aisdk === 'string' ? { sdk: sdk.aisdk } : {}),
              },
            ]
          }),
          env,
        })
      } catch {
        // 单条损坏不影响整目录
      }
    }
  }
  return out
}

/** 目录 store：与 modelMeta 独立，专门服务选型器 */
export const useModelCatalog = create<ModelCatalogState>(() => ({
  models: [],
  loading: false,
  loaded: false,
  updatedAt: null,
}))

const readCache = (): { at: number; models: CatalogModel[] } | null => {
  const raw = readStorage(CACHE_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { at?: unknown; models?: unknown }
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > CACHE_TTL) {
      return null
    }
    return {
      at: parsed.at,
      models: Array.isArray(parsed.models) ? (parsed.models as CatalogModel[]) : [],
    }
  } catch {
    return null
  }
}

let loadTask: Promise<void> | undefined

/**
 * 加载模型目录：先用缓存立即填充，再后台刷新一次。
 * 数据源是 OpenCode 的实时目录（每天更新），失败静默降级，不阻塞任何功能。
 */
export const loadModelCatalog = (): Promise<void> => {
  if (loadTask) {
    return loadTask
  }
  const cached = readCache()
  if (cached) {
    useModelCatalog.setState({ models: cached.models, loaded: true, updatedAt: cached.at })
  }
  loadTask = (async () => {
    useModelCatalog.setState({ loading: true })
    try {
      const response = await http(CATALOG_URL, { cache: 'no-store' })
      if (!response.ok) {
        throw new Error(`catalog ${response.status}`)
      }
      const models = parseCatalog(await response.json())
      if (models.length > 0) {
        const at = Date.now()
        useModelCatalog.setState({ models, loaded: true, updatedAt: at })
        writeStorage(CACHE_KEY, JSON.stringify({ at, models }))
      }
    } catch {
      // 实时目录拉取失败：保留缓存（若有），选型器仍可用缓存数据
    } finally {
      useModelCatalog.setState({ loading: false })
      loadTask = undefined
    }
  })()
  return loadTask
}
