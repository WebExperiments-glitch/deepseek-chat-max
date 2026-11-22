import { create } from 'zustand'
import { setLocale as setI18nLocale } from '../i18n/index.js'
import type { TtsVoice } from '../services/api/speech.js'
import {
  getProvider,
  isProviderId,
  PROVIDER_IDS,
  supportsDeepseekFeatures,
  type ProviderId,
} from '../services/api/providers.js'
import { getSearchProvider } from '../services/searchProviders.js'
import { currentTimeZoneLocation, normalizeLocation, type UserLocation } from '../services/location.js'
import type { ImageDetail } from '../services/api/toOpenAi.js'
import { readStorage, writeStorage } from '../services/platform/storage.js'
import { platform } from '../ports/platform.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 推理强度：对齐文档 output_config.effort 的 low / high / max 三档 */
export type EffortLevel = 'low' | 'high' | 'max'

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'high', 'max']

/** 阅读宽度：标准或更宽的消息列 */
export type ReadingWidth = 'standard' | 'wide'

/** 发送快捷键：Enter 发送，或 Ctrl/⌘+Enter 发送 */
export type SendShortcut = 'enter' | 'mod-enter'

/** 明暗主题各自的外观配色；空串表示使用默认样式 */
export type AppearanceColors = {
  userBubble: string
  assistantBubble: string
  /** 对话区背景，可填颜色、渐变或 url(...) */
  chatBackground: string
}

export type Appearance = {
  light: AppearanceColors
  dark: AppearanceColors
}

const emptyAppearance = (): Appearance => ({
  light: { userBubble: '', assistantBubble: '', chatBackground: '' },
  dark: { userBubble: '', assistantBubble: '', chatBackground: '' },
})

/** 各服务商的 API Key；没有配置时为 null */
export type ProviderApiKeys = Record<ProviderId, string | null>

/** 各服务商选中的模型；没有选择过时为 null，按服务商默认模型发请求 */
export type ProviderModels = Record<ProviderId, string | null>

/** 本机设置，存 localStorage：服务商与各自的 Key、模型、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  /** 当前用于对话的服务商 */
  provider: ProviderId
  /** 各服务商的 Key；DeepSeek 的 Key 同时用于附件、语音和联网检索 */
  apiKeys: ProviderApiKeys
  /** 各服务商当前选中的模型 */
  models: ProviderModels
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  /** 当前语音引擎 id */
  speechProviderId: string
  thinking: boolean
  /** 智能搜索开关。搜索/看网页的轮数不做固定档位，交给模型判断或用户在提问里显式指定。 */
  search: boolean
  /** 当前联网搜索商 id（deepseek-tools / deepseek-api / tavily / serper / brave） */
  searchProviderId: string
  /** 各搜索商的独立 API Key（第三方搜索 API 用） */
  searchKeys: Record<string, string>
  /** 采样温度 0–2；思考模式下服务端自行处理 */
  temperature: number
  /** 核采样阈值 0.01–1 */
  topP: number
  /** 每次回复的最大输出 Token；null 表示使用服务端默认值 */
  maxTokens: number | null
  /** DeepSeek 的 API 协议：Messages（默认）或 Responses */
  deepseekProtocol: 'messages' | 'responses'
  /** 推理强度；null 表示使用服务端默认（high） */
  effort: EffortLevel | null
  /** 图片细节级别：low 更快更省 token，其余保留原图 */
  imageDetail: ImageDetail
  /** 拒答时是否展示服务端给出的图片拦截说明 */
  showRefusalDetail: boolean
  /** 可选的 user_id：用于 KVCache 隔离、内容安全与调度隔离；空串表示不传 */
  userId: string
  /** 自定义系统提示词；空串表示使用官方身份说明 */
  customSystemPrompt: string
  /** 上下文压力达到阈值时自动压缩较早轮次 */
  autoCompress: boolean
  /** 本地长期记忆：读取（注入请求）与写入（自动抽取）分开控制 */
  /** 是否把记忆注入请求（读取） */
  memoryReadEnabled: boolean
  /** 是否在回复后自动抽取记忆（写入） */
  memoryWriteEnabled: boolean
  /** 是否开启安全审核（safety_check） */
  safetyCheck: boolean
  /** 是否把当前时间写进请求上下文 */
  timeContext: boolean
  /** 左上角品牌标识：DeepSeek Logo 或自定义文字 */
  brandMode: 'logo' | 'text'
  /** 自定义品牌文字；空串回落到默认应用名 */
  brandText: string
  siderCollapsed: boolean
  /** 要求模型返回合法 JSON 对象（response_format） */
  jsonMode: boolean
  /** OpenAI 格式的 tools JSON 数组；空串表示不启用函数调用 */
  toolsJson: string
  /** 消息列宽度 */
  readingWidth: ReadingWidth
  /** 代码块自动换行 */
  codeWrap: boolean
  /** 超过一定行数的代码块默认折叠 */
  codeCollapse: boolean
  /** 发送快捷键 */
  sendShortcut: SendShortcut
  /** 用户头像：data URL 或图片地址；空串表示不显示 */
  userAvatar: string
  /** 助手头像：data URL 或图片地址；空串表示不显示 */
  assistantAvatar: string
  /** 明暗独立的外观配色 */
  appearance: Appearance
}

const KEYS = {
  /** 旧版本只存一个 DeepSeek Key，读取时迁移到 apiKeys.deepseek */
  legacyApiKey: 'chat-demo:api-key',
  provider: 'chat-demo:provider',
  apiKeys: 'chat-demo:api-keys',
  models: 'chat-demo:models',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  speechProviderId: 'chat-demo:speech-provider',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  searchProviderId: 'chat-demo:search-provider',
  searchKeys: 'chat-demo:search-keys',
  temperature: 'chat-demo:temperature',
  topP: 'chat-demo:top-p',
  maxTokens: 'chat-demo:max-tokens',
  deepseekProtocol: 'chat-demo:deepseek-protocol',
  effort: 'chat-demo:effort',
  userId: 'chat-demo:user-id',
  imageDetail: 'chat-demo:image-detail',
  showRefusalDetail: 'chat-demo:show-refusal-detail',
  customSystemPrompt: 'chat-demo:custom-system-prompt',
  autoCompress: 'chat-demo:auto-compress',
  legacyMemoryEnabled: 'chat-demo:memory-enabled',
  memoryReadEnabled: 'chat-demo:memory-read',
  memoryWriteEnabled: 'chat-demo:memory-write',
  safetyCheck: 'chat-demo:safety-check',
  timeContext: 'chat-demo:time-context',
  brandMode: 'chat-demo:brand-mode',
  brandText: 'chat-demo:brand-text',
  siderCollapsed: 'chat-demo:sider-collapsed',
  jsonMode: 'chat-demo:json-mode',
  toolsJson: 'chat-demo:tools-json',
  readingWidth: 'chat-demo:reading-width',
  codeWrap: 'chat-demo:code-wrap',
  codeCollapse: 'chat-demo:code-collapse',
  sendShortcut: 'chat-demo:send-shortcut',
  userAvatar: 'chat-demo:user-avatar',
  assistantAvatar: 'chat-demo:assistant-avatar',
  appearance: 'chat-demo:appearance',
} as const

const read = readStorage

const write = writeStorage

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean => {
  const lang = platform().userLanguage()
  return (lang || 'zh').toLowerCase().startsWith('zh')
}

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      // 没保存过位置：按浏览器时区推断一次并记住，latest_reminder 才不会缺地区
      const inferred = currentTimeZoneLocation()
      if (inferred) {
        write(KEYS.location, JSON.stringify(inferred))
      }
      return inferred
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const emptyApiKeys = (): ProviderApiKeys =>
  Object.fromEntries(PROVIDER_IDS.map((id) => [id, null])) as ProviderApiKeys

const emptyModels = (): ProviderModels =>
  Object.fromEntries(PROVIDER_IDS.map((id) => [id, null])) as ProviderModels

/** 读 JSON 对象；解析失败按空对象处理，不抛出 */
const readRecord = (key: string): Record<string, unknown> => {
  const raw = read(key)
  if (!raw) {
    return {}
  }
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** 合并已保存的 Key；旧版本的单个 Key 迁移到 deepseek，迁移后删除旧条目 */
const initialApiKeys = (): ProviderApiKeys => {
  const apiKeys = emptyApiKeys()
  for (const [id, value] of Object.entries(readRecord(KEYS.apiKeys))) {
    if (isProviderId(id) && typeof value === 'string' && value) {
      apiKeys[id] = value
    }
  }
  if (!apiKeys.deepseek) {
    const legacy = read(KEYS.legacyApiKey)
    if (legacy) {
      apiKeys.deepseek = legacy
      write(KEYS.apiKeys, JSON.stringify(apiKeys))
      write(KEYS.legacyApiKey, null)
    }
  }
  return apiKeys
}

const initialModels = (): ProviderModels => {
  const models = emptyModels()
  for (const [id, value] of Object.entries(readRecord(KEYS.models))) {
    if (isProviderId(id) && typeof value === 'string' && value) {
      models[id] = value
    }
  }
  return models
}

/** 未保存过时使用服务端默认强度（high），只有显式选择才带上 output_config */
const initialEffort = (): EffortLevel | null => {
  const saved = read(KEYS.effort)
  return saved === 'low' || saved === 'high' || saved === 'max' ? saved : null
}

/** 未保存过时使用 DeepSeek */
/** 默认 auto，与服务端默认行为一致；必须在 useSettings 之前定义，否则是 TDZ 错误 */
const initialImageDetail = (): ImageDetail => {
  const saved = read(KEYS.imageDetail)
  return saved === 'low' || saved === 'high' ? saved : 'auto'
}

const initialProvider = (): ProviderId => {
  const saved = read(KEYS.provider)
  return isProviderId(saved) ? saved : 'deepseek'
}

/** 读数值设置：缺失或非法时用默认值，并夹在区间内 */
const initialNumber = (key: string, fallback: number, min: number, max: number): number => {
  const raw = read(key)
  if (raw === null) {
    return fallback
  }
  const value = Number(raw)
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/**
 * 搜索开关初始值。兼容旧版的 search-rounds 档位键：轮数 > 0 视为开启，
 * 之后统一只用 search:boolean，轮数不再做固定档位。
 */
const initialSearchEnabled = (): boolean => {
  const legacy = read('chat-demo:search-rounds')
  if (legacy !== null) {
    return Number(legacy) > 0
  }
  return read(KEYS.search) === 'true'
}

const initialSearchProviderId = (): string => {
  const saved = read(KEYS.searchProviderId)
  return saved && ['deepseek-tools', 'deepseek-api', 'tavily', 'serper', 'brave'].includes(saved)
    ? saved
    : 'deepseek-tools'
}

const initialSearchKeys = (): Record<string, string> => {
  const raw = read(KEYS.searchKeys)
  if (!raw) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') {
      return {}
    }
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') {
        out[key] = value
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 读可留空的数值设置：缺失、非法或非正数时为 null，表示使用服务端默认值 */
const initialOptionalNumber = (key: string, min: number, max: number): number | null => {
  const raw = read(key)
  if (raw === null) {
    return null
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min) {
    return null
  }
  return Math.min(max, Math.round(value))
}

/** 外观配色：缺失或损坏时使用空配色 */
const initialAppearance = (): Appearance => {
  const base = emptyAppearance()
  const raw = read(KEYS.appearance)
  if (!raw) {
    return base
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') {
      return base
    }
    const record = parsed as Record<string, unknown>
    const pick = (theme: 'light' | 'dark'): AppearanceColors => {
      const value = record[theme]
      if (value === null || typeof value !== 'object') {
        return base[theme]
      }
      const colors = value as Record<string, unknown>
      return {
        userBubble: typeof colors.userBubble === 'string' ? colors.userBubble : '',
        assistantBubble:
          typeof colors.assistantBubble === 'string' ? colors.assistantBubble : '',
        chatBackground: typeof colors.chatBackground === 'string' ? colors.chatBackground : '',
      }
    }
    return { light: pick('light'), dark: pick('dark') }
  } catch {
    return base
  }
}

/**
 * 记忆读/写分别初始化。
 * - 读取（把已有记忆注入上下文）默认开：纯本地检索，不额外调用 API；
 * - 写入（每轮回复后台调 deepseek-flash 抽取）默认关：它是一次额外的付费 API 调用，
 *   且与「数据不出本机」的口号存在张力。用户需主动开启才生效。
 * 旧版单一总开关的值在拆分时各自继承，但新用户默认写关闭。
 */
const initialMemoryFlags = (): { read: boolean; write: boolean } => {
  const legacy = read(KEYS.legacyMemoryEnabled)
  const legacyRead = legacy === null ? true : legacy !== 'false'
  const readSaved = read(KEYS.memoryReadEnabled)
  const writeSaved = read(KEYS.memoryWriteEnabled)
  return {
    read: readSaved === null ? legacyRead : readSaved !== 'false',
    write: writeSaved === null ? false : writeSaved !== 'false',
  }
}

const initialMemory = initialMemoryFlags()

export const useSettings = create<Settings>(() => ({
  provider: initialProvider(),
  apiKeys: initialApiKeys(),
  models: initialModels(),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  speechProviderId: read(KEYS.speechProviderId) || 'deepseek',
  thinking: read(KEYS.thinking) === 'true',
  search: initialSearchEnabled(),
  searchProviderId: initialSearchProviderId(),
  searchKeys: initialSearchKeys(),
  temperature: initialNumber(KEYS.temperature, 1, 0, 2),
  topP: initialNumber(KEYS.topP, 1, 0.01, 1),
  maxTokens: initialOptionalNumber(KEYS.maxTokens, 1, 65536),
  deepseekProtocol: read(KEYS.deepseekProtocol) === 'responses' ? 'responses' : 'messages',
  effort: initialEffort(),
  userId: read(KEYS.userId) ?? '',
  imageDetail: initialImageDetail(),
  showRefusalDetail: read(KEYS.showRefusalDetail) !== 'false',
  customSystemPrompt: read(KEYS.customSystemPrompt) ?? '',
  // 默认开启：窗口较大的模型很少触发，窗口小的模型才是真正需要它的场景
  autoCompress: read(KEYS.autoCompress) !== 'false',
  memoryReadEnabled: initialMemory.read,
  memoryWriteEnabled: initialMemory.write,
  safetyCheck: read(KEYS.safetyCheck) !== 'false',
  timeContext: read(KEYS.timeContext) !== 'false',
  brandMode: read(KEYS.brandMode) === 'text' ? 'text' : 'logo',
  brandText: read(KEYS.brandText) ?? '',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  jsonMode: read(KEYS.jsonMode) === 'true',
  toolsJson: read(KEYS.toolsJson) ?? '',
  readingWidth: read(KEYS.readingWidth) === 'wide' ? 'wide' : 'standard',
  codeWrap: read(KEYS.codeWrap) === 'true',
  // 长代码块默认折叠，喜欢直接看全文可以在设置里关掉
  codeCollapse: read(KEYS.codeCollapse) !== 'false',
  sendShortcut: read(KEYS.sendShortcut) === 'mod-enter' ? 'mod-enter' : 'enter',
  userAvatar: read(KEYS.userAvatar) ?? '',
  assistantAvatar: read(KEYS.assistantAvatar) ?? '',
  appearance: initialAppearance(),
}))

/** 当前服务商的 Key；没有配置时为空串，调用方按空串处理 */
export const getCurrentApiKey = (): string => {
  const { provider, apiKeys } = useSettings.getState()
  return apiKeys[provider] ?? ''
}

/** DeepSeek 的 Key：附件、语音、联网检索都只认这一份 */
export const getDeepseekApiKey = (): string => useSettings.getState().apiKeys.deepseek ?? ''

/** 当前服务商实际使用的模型：用户选择过就用选择，否则用默认模型 */
export const getCurrentModel = (): string => {
  const { provider, models } = useSettings.getState()
  return models[provider] || getProvider(provider).defaultModel
}

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
  setI18nLocale(locale)
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setSpeechProvider = (speechProviderId: string) => {
  write(KEYS.speechProviderId, speechProviderId)
  useSettings.setState({ speechProviderId })
}

/** 切换对话服务商；各家的 Key 与模型互相独立，切回时沿用上次的选择 */
export const setProvider = (provider: ProviderId) => {
  write(KEYS.provider, provider)
  // 只有 DeepSeek 专属的服务端工具搜索（deepseek-tools）会在切离 DeepSeek 时失效；
  // 第三方独立搜索（Tavily/Serper/Brave/deepseek-api）走本地代理，与当前服务商无关，
  // 不该被静默关掉——否则「可插拔搜索」的声明与按钮行为自相矛盾。
  const state = useSettings.getState()
  const currentSearchIsServerTool = getSearchProvider(state.searchProviderId).kind === 'server-tool'
  const resetSearch = !supportsDeepseekFeatures(provider) && state.search && currentSearchIsServerTool
  if (resetSearch) {
    write(KEYS.search, 'false')
  }
  useSettings.setState({
    provider,
    ...(resetSearch ? { search: false } : {}),
  })
}

export const setProviderApiKey = (provider: ProviderId, apiKey: string | null) => {
  const apiKeys = { ...useSettings.getState().apiKeys, [provider]: apiKey }
  write(KEYS.apiKeys, JSON.stringify(apiKeys))
  useSettings.setState({ apiKeys })
}

export const setProviderModel = (provider: ProviderId, model: string | null) => {
  const models = { ...useSettings.getState().models, [provider]: model }
  write(KEYS.models, JSON.stringify(models))
  useSettings.setState({ models })
}

/** 兼容旧调用：写入当前服务商的 Key */
export const setApiKey = (apiKey: string | null) =>
  setProviderApiKey(useSettings.getState().provider, apiKey)

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSearchProvider = (id: string) => {
  write(KEYS.searchProviderId, id)
  useSettings.setState({ searchProviderId: id })
}

export const setSearchKey = (providerId: string, key: string) => {
  const keys = { ...useSettings.getState().searchKeys, [providerId]: key }
  write(KEYS.searchKeys, JSON.stringify(keys))
  useSettings.setState({ searchKeys: keys })
}

export const setTemperature = (temperature: number) => {
  write(KEYS.temperature, String(temperature))
  useSettings.setState({ temperature })
}

export const setTopP = (topP: number) => {
  write(KEYS.topP, String(topP))
  useSettings.setState({ topP })
}

/** null 表示回到服务端默认值，此时删除本地条目而不是存 'null' */
export const setMaxTokens = (maxTokens: number | null) => {
  write(KEYS.maxTokens, maxTokens === null ? null : String(maxTokens))
  useSettings.setState({ maxTokens })
}

export const setShowRefusalDetail = (showRefusalDetail: boolean) => {
  write(KEYS.showRefusalDetail, String(showRefusalDetail))
  useSettings.setState({ showRefusalDetail })
}

export const setJsonMode = (jsonMode: boolean) => {
  write(KEYS.jsonMode, String(jsonMode))
  useSettings.setState({ jsonMode })
}

export const setToolsJson = (toolsJson: string) => {
  write(KEYS.toolsJson, toolsJson)
  useSettings.setState({ toolsJson })
}

export const setReadingWidth = (readingWidth: ReadingWidth) => {
  write(KEYS.readingWidth, readingWidth)
  useSettings.setState({ readingWidth })
}

export const setCodeWrap = (codeWrap: boolean) => {
  write(KEYS.codeWrap, String(codeWrap))
  useSettings.setState({ codeWrap })
}

export const setCodeCollapse = (codeCollapse: boolean) => {
  write(KEYS.codeCollapse, String(codeCollapse))
  useSettings.setState({ codeCollapse })
}

export const setSendShortcut = (sendShortcut: SendShortcut) => {
  write(KEYS.sendShortcut, sendShortcut)
  useSettings.setState({ sendShortcut })
}

export const setUserAvatar = (userAvatar: string) => {
  write(KEYS.userAvatar, userAvatar === '' ? null : userAvatar)
  useSettings.setState({ userAvatar })
}

export const setAssistantAvatar = (assistantAvatar: string) => {
  write(KEYS.assistantAvatar, assistantAvatar === '' ? null : assistantAvatar)
  useSettings.setState({ assistantAvatar })
}

export const setAppearanceColor = (
  theme: 'light' | 'dark',
  key: keyof AppearanceColors,
  value: string
) => {
  const appearance: Appearance = {
    ...useSettings.getState().appearance,
    [theme]: { ...useSettings.getState().appearance[theme], [key]: value },
  }
  write(KEYS.appearance, JSON.stringify(appearance))
  useSettings.setState({ appearance })
}

export const resetAppearance = (theme: 'light' | 'dark') => {
  const appearance: Appearance = { ...useSettings.getState().appearance, [theme]: emptyAppearance()[theme] }
  write(KEYS.appearance, JSON.stringify(appearance))
  useSettings.setState({ appearance })
}

export const setImageDetail = (imageDetail: ImageDetail) => {
  write(KEYS.imageDetail, imageDetail)
  useSettings.setState({ imageDetail })
}

export const setUserId = (userId: string) => {
  write(KEYS.userId, userId === '' ? null : userId)
  useSettings.setState({ userId })
}

export const setDeepseekProtocol = (deepseekProtocol: 'messages' | 'responses') => {
  write(KEYS.deepseekProtocol, deepseekProtocol)
  useSettings.setState({ deepseekProtocol })
}

export const setEffort = (effort: EffortLevel | null) => {
  write(KEYS.effort, effort)
  useSettings.setState({ effort })
}

export const setCustomSystemPrompt = (customSystemPrompt: string) => {
  write(KEYS.customSystemPrompt, customSystemPrompt === '' ? null : customSystemPrompt)
  useSettings.setState({ customSystemPrompt })
}

export const setAutoCompress = (autoCompress: boolean) => {
  write(KEYS.autoCompress, String(autoCompress))
  useSettings.setState({ autoCompress })
}

export const setBrandMode = (brandMode: 'logo' | 'text') => {
  write(KEYS.brandMode, brandMode)
  useSettings.setState({ brandMode })
}

export const setBrandText = (brandText: string) => {
  write(KEYS.brandText, brandText === '' ? null : brandText)
  useSettings.setState({ brandText })
}

/** 恢复默认：DeepSeek Logo + 空的自定义文字 */
export const resetBrand = () => {
  write(KEYS.brandMode, null)
  write(KEYS.brandText, null)
  useSettings.setState({ brandMode: 'logo', brandText: '' })
}

export const setSafetyCheck = (safetyCheck: boolean) => {
  write(KEYS.safetyCheck, String(safetyCheck))
  useSettings.setState({ safetyCheck })
}

export const setTimeContext = (timeContext: boolean) => {
  write(KEYS.timeContext, String(timeContext))
  useSettings.setState({ timeContext })
}

export const setMemoryReadEnabled = (memoryReadEnabled: boolean) => {
  write(KEYS.memoryReadEnabled, String(memoryReadEnabled))
  useSettings.setState({ memoryReadEnabled })
}

export const setMemoryWriteEnabled = (memoryWriteEnabled: boolean) => {
  write(KEYS.memoryWriteEnabled, String(memoryWriteEnabled))
  useSettings.setState({ memoryWriteEnabled })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
