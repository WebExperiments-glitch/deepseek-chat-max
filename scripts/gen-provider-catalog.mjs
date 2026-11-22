#!/usr/bin/env node
/**
 * 从 models.dev api.json 生成精简的供应商品牌清单（src/services/api/providerCatalog.generated.ts）。
 *
 * 只保留有可用 API 端点的 provider，按「知名度白名单 + 模型数」挑选 50-80 家。
 * 每条只留：id / name / api(baseURL) / env(Key 名) / 模型数 —— 模型明细走 modelMeta.ts。
 * 这是「品牌清单」而非硬编码模型；数据是构建期从 models.dev(MIT) 生成的。
 *
 * 用法：node scripts/gen-provider-catalog.mjs
 */
import { writeFileSync } from 'node:fs'

const SOURCE = process.env.MODELS_DEV_URL ?? 'https://models.dev/api.json'

// 主流/常用供应商优先纳入（有端点者优先；无端点的知名厂商在运行时补默认端点）
const FEATURED = [
  'openai', 'anthropic', 'deepseek', 'google', 'google-vertex', 'groq', 'openrouter',
  'mistral', 'cohere', 'xai', 'togetherai', 'fireworks', 'cerebras', 'replicate',
  'agnes',
  'moonshotai', 'zai', 'minimax', 'minimax-cn', 'baidu', 'alibaba', 'qwen', 'doubao',
  'volcengine', 'siliconflow', 'bailian', 'bigmodel', 'venice', 'perplexity',
  'github-copilot', 'github-models', 'vercel-ai-gateway', 'opencode', 'nvidia',
  'azure', 'azure-cognitive-services', 'aws-bedrock', 'cloudflare', 'scaleway',
  'deepinfra', 'anyscale', 'openai-compatible', 'lmstudio', 'ollama', 'vllm',
]

const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30000) })
if (!res.ok) {
  throw new Error(`${SOURCE} returned ${res.status}`)
}
const raw = await res.json()

const pickApi = (p) => {
  if (typeof p.api === 'string' && p.api.startsWith('http')) return p.api
  return ''
}

const entries = Object.entries(raw).map(([id, p]) => ({
  id,
  name: p.name ?? id,
  api: pickApi(p),
  env: Array.isArray(p.env) ? p.env : [],
  models: Object.keys(p.models ?? {}).length,
  npm: p.npm ?? '',
}))

// 有端点的：精选优先，再按模型数补足到 80
const withApi = entries.filter((e) => e.api)
const featured = withApi.filter((e) => FEATURED.includes(e.id))
const rest = withApi
  .filter((e) => !FEATURED.includes(e.id))
  .sort((a, b) => b.models - a.models)
const chosen = [...featured, ...rest].slice(0, 80)

// 知名但无端点的厂商：补默认 baseURL（路径众所周知，OpenCode 原生包也这么写）
const DEFAULT_ENDPOINTS = {
  openai: { api: 'https://api.openai.com/v1', protocol: 'openai' },
  anthropic: { api: 'https://api.anthropic.com/v1', protocol: 'anthropic' },
  google: { api: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'openai' },
  azure: { api: '', protocol: 'openai' },
}
for (const id of ['openai', 'anthropic', 'google']) {
  if (!chosen.some((e) => e.id === id)) {
    const p = entries.find((e) => e.id === id)
    if (p) chosen.unshift({ ...p, ...DEFAULT_ENDPOINTS[id] })
  }
}

const protocolOf = (e) =>
  /anthropic/i.test(e.api) || e.npm?.includes('anthropic') ? 'anthropic' : 'openai'

const finalProviders = chosen
  .filter((e) => e.api)
  .map((e) => ({
    id: e.id,
    name: e.name,
    api: e.api,
    env: e.env.slice(0, 1),
    models: e.models,
    protocol: protocolOf(e),
  }))

// 最终清单：同时输出给前端的 TS 与给本地服务的 JSON（通用代理查目标端点用）
const catalog = finalProviders.map((e) => ({
  id: e.id,
  name: e.name,
  baseURL: e.api,
  modelsURL: `${e.api.replace(/\/+$/, '')}/models`,
  env: e.env,
  modelCount: e.models,
  protocol: e.protocol,
}))

// OpenCode 免费网关（zen）：无需用户 Key，服务端注入伪装客户端头（抄 opencode 源码）。
// 这些模型有免费额度限制（429 FreeUsageLimitError），仅作免 Key 体验用。
catalog.unshift({
  id: 'opencode-free',
  name: 'OpenCode Free',
  baseURL: 'https://opencode.ai/zen/v1',
  modelsURL: 'https://opencode.ai/zen/v1/models',
  env: [],
  modelCount: 105,
  protocol: 'openai',
  noKey: true,
  injectHeaders: {
    Authorization: 'Bearer public',
    'User-Agent': 'opencode/stable/1.2.3/opencode',
    'x-opencode-session': '$session',
    'x-opencode-session-id': '$session',
    'x-session-affinity': '$session',
    'X-Session-Id': '$session',
    'x-opencode-project': 'global',
    'x-opencode-client': 'opencode',
  },
})

const header = `// 自动生成，勿手改。来源：models.dev api.json（MIT）。
// 生成命令：node scripts/gen-provider-catalog.mjs
// 这是「供应商品牌清单」：只存端点与 Key 名，模型元数据由 modelMeta.ts 运行时提供。

export type CatalogProvider = {
  id: string
  name: string
  /** 对话接口 baseURL（不含 /chat/completions） */
  baseURL: string
  /** 模型清单地址 */
  modelsURL: string
  /** 需要的 API Key 环境变量名（用于提示用户） */
  env: string[]
  /** 该供应商在 models.dev 的模型数量（排序/展示用） */
  modelCount: number
  protocol: 'openai' | 'anthropic'
  /** 无需用户填 Key（如 OpenCode 免费网关，服务端注入伪装头） */
  noKey?: boolean
  /** 服务端代理注入的请求头（$session 为会话占位符） */
  injectHeaders?: Record<string, string>
}

export const PROVIDER_CATALOG: CatalogProvider[] = ${JSON.stringify(catalog, null, 2)}
`

writeFileSync(new URL('../src/services/api/providerCatalog.generated.ts', import.meta.url), header)
writeFileSync(
  new URL('../server/provider-catalog.json', import.meta.url),
  JSON.stringify(catalog, null, 2)
)
console.log(`生成 ${catalog.length} 个供应商 -> src/services/api/providerCatalog.generated.ts + server/provider-catalog.json`)
