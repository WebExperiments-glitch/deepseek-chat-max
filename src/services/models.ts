import { create } from 'zustand'
import { listModels, type ModelOption } from './api/client.js'
import {
  getProvider,
  parseCustomModels,
  PROVIDER_IDS,
  useCustomProvider,
  type ProviderId,
} from './api/providers.js'
import { useSettings } from './settings.js'
import { mergeModelMeta } from './modelMeta.js'

/**
 * 各服务商的模型清单缓存。
 * 只缓存在内存里：切换服务商或重新校验 Key 时重新拉取，失败保留上一次的结果。
 */
type ModelState = {
  /** 各服务商拉到的模型；尚未拉取时为空数组 */
  lists: Record<ProviderId, ModelOption[]>
  /** 正在拉取的服务商 */
  loading: Record<ProviderId, boolean>
}

const emptyLists = (): Record<ProviderId, ModelOption[]> =>
  Object.fromEntries(PROVIDER_IDS.map((id) => [id, [] as ModelOption[]])) as Record<
    ProviderId,
    ModelOption[]
  >

const emptyLoading = (): Record<ProviderId, boolean> =>
  Object.fromEntries(PROVIDER_IDS.map((id) => [id, false])) as Record<ProviderId, boolean>

const initialLists = (): Record<ProviderId, ModelOption[]> => ({
  ...emptyLists(),
  custom: parseCustomModels(useCustomProvider.getState().config),
})

export const useModels = create<ModelState>(() => ({
  lists: initialLists(),
  loading: emptyLoading(),
}))

/** 自定义服务商的手动模型清单；配置变化后立即同步到下拉框 */
export const syncCustomModels = () => {
  const models = parseCustomModels(useCustomProvider.getState().config)
  useModels.setState((state) => ({ lists: { ...state.lists, custom: models } }))
  return models
}

/** 用已保存的 Key 拉取模型清单；没有 Key 或请求失败时保留原值 */
export const refreshModels = async (providerId: ProviderId): Promise<void> => {
  if (providerId === 'custom') {
    syncCustomModels()
    const provider = getProvider('custom')
    if (!provider.modelsURL || !useCustomProvider.getState().config.modelsURL) {
      return
    }
  }
  const apiKey = useSettings.getState().apiKeys[providerId]
  if (!apiKey || useModels.getState().loading[providerId]) {
    return
  }
  useModels.setState((state) => ({ loading: { ...state.loading, [providerId]: true } }))
  try {
    const models = await listModels(getProvider(providerId), apiKey)
    useModels.setState((state) => ({ lists: { ...state.lists, [providerId]: mergeModelMeta(models) } }))
  } catch {
    // 拉取失败不影响使用：仍然可以按默认模型请求
  } finally {
    useModels.setState((state) => ({ loading: { ...state.loading, [providerId]: false } }))
  }
}

/** 用尚未保存的 Key 拉一次清单：既校验 Key，也立刻得到模型选项 */
export const loadModelsWithKey = async (
  providerId: ProviderId,
  apiKey: string
): Promise<ModelOption[]> => {
  if (providerId === 'custom') {
    const manual = syncCustomModels()
    const provider = getProvider('custom')
    if (!provider.modelsURL || !useCustomProvider.getState().config.modelsURL) {
      return manual
    }
  }
  const models = await listModels(getProvider(providerId), apiKey)
  const merged = mergeModelMeta(models)
  useModels.setState((state) => ({ lists: { ...state.lists, [providerId]: merged } }))
  return merged
}
