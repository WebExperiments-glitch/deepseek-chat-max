/**
 * 服务商注册表：决定对话走哪套协议、请求发到哪里，以及哪些能力需要额外的 DeepSeek Key。
 *
 * - deepseek：Anthropic 兼容 Messages / Files API，搜索、附件、语音都是原生能力。
 * - openrouter / opencode-go / opencode-zen / opendesign：OpenAI 兼容 chat/completions + Bearer，
 *   只提供对话；联网搜索、附件、语音与朗读仅在 DeepSeek 服务商下开放。
 *
 * 关于地址（2026-11 实测）：
 * - OpenCode 的模型清单在 /zen/{go/}v1/models，但对话接口在 /inference/{go/openai/}v1。
 *   清单里每条模型都带 api["chat-completions"].base_url，这里按它取值；
 *   用 /zen/v1/chat/completions 会得到 400/404。
 * - OpenCode Go 还要求每个会话带稳定的 x-opencode-session，并建议使用可识别的
 *   User-Agent；缺少 session 会被 400 拒绝，见 https://opencode.ai/v2/docs/console/go/。
 * - OpenDesign 的鉴权失败响应不带 CORS 头，浏览器直连时会被读成网络错误，
 *   因此开发模式统一走开发服务器代理（见 rspack.config.ts）；生产静态站点需要自建反向代理。
 */

import { create } from 'zustand'
import { readStorage, writeStorage } from '../services/platform/storage.js'
import { PROVIDER_CATALOG } from '../services/api/providerCatalog.generated.js'

/**
 * 界面上可选的服务商。类型放宽为 string：内置 6 个 + 从 models.dev(MIT) 生成的
 * 品牌清单（83 家），另有 custom 走用户自定义配置。动态 id 无需改代码即可接入。
 */
export type ProviderId = string

/** 对话协议：anthropic 为 Messages API，openai 为 chat/completions */
export type WireProtocol = 'anthropic' | 'openai'

/** 服务商能力位（数据化，替代 id==='deepseek' 的单点硬编码） */
export type ProviderCapabilities = {
  /** 服务端联网工具（deepseek_web_search / deepseek_read_url） */
  deepseekTools: boolean
  /** Files API 附件上传 */
  files: boolean
  /** 语音（ASR / TTS） */
  voice: boolean
  /** 服务端自动生成标题 */
  title: boolean
}

const DEEPSEEK_CAPABILITIES: ProviderCapabilities = {
  deepseekTools: true,
  files: true,
  voice: true,
  title: true,
}
const GENERIC_CAPABILITIES: ProviderCapabilities = {
  deepseekTools: false,
  files: false,
  voice: false,
  title: false,
}

export type Provider = {
  id: ProviderId
  /** 设置里展示的名称，不翻译 */
  name: string
  protocol: WireProtocol
  /** 对话接口的根路径，不含结尾斜杠 */
  baseURL: string
  /** 校验 Key 与拉取模型清单的地址 */
  modelsURL: string
  /** 默认模型，用户没有选择时使用 */
  defaultModel: string
  /** 对话请求需要额外携带的固定请求头 */
  headers?: Record<string, string>
  /** 该服务商支持的能力位 */
  capabilities: ProviderCapabilities
}

/** DeepSeek 的固定地址前缀：附件、语音与联网检索都只走这里 */
export const DEEPSEEK_ORIGIN = __API_ORIGIN__
export const DEEPSEEK_ANTHROPIC_BASE_URL = `${DEEPSEEK_ORIGIN}/anthropic/v1`
/** 语音接口 */
export const DEEPSEEK_TOOLS_BASE_URL = `${DEEPSEEK_ORIGIN}/v1/tools`

/**
 * 开发模式下各服务商的同源前缀，由开发服务器代理到真实地址。
 * 生产构建没有开发服务器时为空串，调用方回退到真实地址。
 */
const DEV_PROXY_PREFIX = __DEV_PROXY_PREFIX__

/**
 * 真实地址 → 实际使用的地址。
 * 开发模式把「协议 + 主机」替换成同源前缀，路径原样保留：
 * https://opencode.ai/inference/go/openai/v1 → /provider/opencode-go/inference/go/openai/v1
 * 这样同一服务商的对话与模型清单可以共用一个代理规则（见 rspack.config.ts）。
 */
const route = (url: string, prefix: string) => {
  if (!DEV_PROXY_PREFIX) {
    return url
  }
  const { pathname } = new URL(url)
  return `${DEV_PROXY_PREFIX}/${prefix}${pathname}`
}

/**
 * 应用的 User-Agent 标识。浏览器禁止脚本设置 User-Agent，
 * 这里用服务端要求的自定义标识头发同样的信息，便于上游识别客户端。
 */
export const CLIENT_ID_HEADERS: Record<string, string> = {
  'x-title': 'chat-demo',
}

/**
 * OpenAI 兼容服务：对话与模型清单可能不同源，分别给出真实地址。
 * modelsBase 是模型清单的根（清单接口就是它本身，不再追加路径）。
 */
const openaiProvider = (
  id: ProviderId,
  name: string,
  chatBase: string,
  modelsURL: string,
  proxyPrefix: string,
  headers?: Record<string, string>,
  capabilities: ProviderCapabilities = GENERIC_CAPABILITIES
): Provider => ({
  id,
  name,
  protocol: 'openai',
  baseURL: route(chatBase, proxyPrefix),
  modelsURL: route(modelsURL, proxyPrefix),
  // 网关的模型清单是动态的，这里不硬编码模型名：清单拉到后由设置页自动选中第一条
  defaultModel: '',
  ...(headers ? { headers } : {}),
  capabilities,
})

export const PROVIDERS: Record<ProviderId, Provider> = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'anthropic',
    // DeepSeek 的 CORS 响应完整，开发与生产都直连
    baseURL: DEEPSEEK_ANTHROPIC_BASE_URL,
    modelsURL: `${DEEPSEEK_ORIGIN}/models`,
    defaultModel: 'deepseek-flash',
    capabilities: DEEPSEEK_CAPABILITIES,
  },
  'opencode-go': openaiProvider(
    'opencode-go',
    'OpenCode Go',
    'https://opencode.ai/inference/go/openai/v1',
    'https://opencode.ai/zen/go/v1/models',
    'opencode-go',
    CLIENT_ID_HEADERS
  ),
  'opencode-zen': openaiProvider(
    'opencode-zen',
    'OpenCode Zen',
    'https://opencode.ai/inference/openai/v1',
    'https://opencode.ai/zen/v1/models',
    'opencode-zen',
    CLIENT_ID_HEADERS
  ),
  openrouter: openaiProvider(
    'openrouter',
    'OpenRouter',
    'https://openrouter.ai/api/v1',
    'https://openrouter.ai/api/v1/models',
    'openrouter',
    CLIENT_ID_HEADERS
  ),
  opendesign: openaiProvider(
    'opendesign',
    'OpenDesign',
    'https://amr-link.open-design.ai/v1',
    'https://amr-link.open-design.ai/v1/models',
    'opendesign'
  ),
  // 自定义服务商：实际配置由 useCustomProvider 提供，getProvider 会动态组装
  custom: {
    id: 'custom',
    name: '自定义',
    protocol: 'openai',
    baseURL: '',
    modelsURL: '',
    defaultModel: '',
    capabilities: GENERIC_CAPABILITIES,
  },
}

/**
 * 从 models.dev 品牌清单注册供应商。与上面 6 个原生配置同名的跳过，
 * 保留经过实测调优的地址（如 deepseek 的 anthropic 端点、OpenCode 的代理前缀）。
 */
for (const item of PROVIDER_CATALOG) {
  if (Object.hasOwn(PROVIDERS, item.id)) {
    continue
  }
  // 品牌清单里的供应商走本地通用代理（/provider/:id/...），绕开浏览器 CORS。
  // 本地 Node 服务把请求转发到真实端点；开发时 rspack 再把 /provider 转到本地服务。
  const proxyBase = `/provider/${item.id}`
  PROVIDERS[item.id] = {
    id: item.id,
    name: item.name,
    protocol: item.protocol,
    baseURL: proxyBase,
    modelsURL: `${proxyBase}/models`,
    defaultModel: '',
    capabilities: GENERIC_CAPABILITIES,
  }
}

/** 设置里的展示顺序：原生 6 个在前，其余按品牌清单顺序，custom 收尾 */
export const PROVIDER_IDS: ProviderId[] = [
  'deepseek',
  'openrouter',
  'opencode-go',
  'opencode-zen',
  'opendesign',
  ...PROVIDER_CATALOG.map((item) => item.id).filter((id) => !Object.hasOwn({
    deepseek: 1, openrouter: 1, 'opencode-go': 1, 'opencode-zen': 1, opendesign: 1,
  }, id)),
  'custom',
]

export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === 'string' && Object.hasOwn(PROVIDERS, value)

/** 自定义服务商配置：endpoint、协议与手动模型清单 */
export type CustomProviderConfig = {
  name: string
  baseURL: string
  protocol: WireProtocol
  /** 模型清单地址；留空表示不请求，直接使用手动模型列表 */
  modelsURL: string
  /** 一行一个模型，支持 `id|显示名` */
  models: string
  defaultModel: string
}

const CUSTOM_KEY = 'chat-demo:custom-provider'

const defaultCustomProvider = (): CustomProviderConfig => ({
  name: '自定义',
  baseURL: '',
  protocol: 'openai',
  modelsURL: '',
  models: '',
  defaultModel: '',
})

const readCustomProvider = (): CustomProviderConfig => {
  const raw = readStorage(CUSTOM_KEY)
  if (!raw) {
    return defaultCustomProvider()
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') {
      return defaultCustomProvider()
    }
    const record = parsed as Record<string, unknown>
    return {
      name: typeof record.name === 'string' ? record.name : '自定义',
      baseURL: typeof record.baseURL === 'string' ? record.baseURL : '',
      protocol: record.protocol === 'anthropic' ? 'anthropic' : 'openai',
      modelsURL: typeof record.modelsURL === 'string' ? record.modelsURL : '',
      models: typeof record.models === 'string' ? record.models : '',
      defaultModel: typeof record.defaultModel === 'string' ? record.defaultModel : '',
    }
  } catch {
    return defaultCustomProvider()
  }
}

export const useCustomProvider = create<{ config: CustomProviderConfig }>(() => ({
  config: readCustomProvider(),
}))

export const setCustomProviderConfig = (patch: Partial<CustomProviderConfig>) => {
  const config = { ...useCustomProvider.getState().config, ...patch }
  writeStorage(CUSTOM_KEY, JSON.stringify(config))
  useCustomProvider.setState({ config })
}

/** 手动模型清单：一行一个，`id|显示名` 可选 */
export const parseCustomModels = (config: CustomProviderConfig) =>
  config.models.split('\n').flatMap((line) => {
    const [rawId, rawLabel] = line.split('|')
    const id = rawId?.trim() ?? ''
    if (!id) {
      return []
    }
    return [{ id, label: rawLabel?.trim() || id }]
  })

const normalizeBaseURL = (value: string) => value.trim().replace(/\/+$/, '')

export const getProvider = (id: ProviderId): Provider => {
  if (id !== 'custom') {
    return PROVIDERS[id]
  }
  const config = useCustomProvider.getState().config
  const baseURL = normalizeBaseURL(config.baseURL)
  const modelsURL = normalizeBaseURL(config.modelsURL)
  const fallbackModel = parseCustomModels(config)[0]?.id ?? ''
  return {
    id: 'custom',
    name: config.name.trim() || '自定义',
    protocol: config.protocol,
    baseURL,
    // 有清单地址才请求；否则由设置页直接使用手动模型
    modelsURL: modelsURL || (baseURL ? `${baseURL}/models` : ''),
    defaultModel: config.defaultModel.trim() || fallbackModel,
    capabilities: GENERIC_CAPABILITIES,
  }
}

/**
 * 服务商是否支持 DeepSeek 专属能力（联网工具/附件/语音/标题）。
 * 改为读取 capabilities 数据，不再硬编码 id 判断——调用方无需修改。
 */
export const supportsDeepseekFeatures = (id: ProviderId): boolean =>
  getProvider(id).capabilities.deepseekTools
