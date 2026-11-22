import { describe, it, expect, vi, beforeEach } from 'vitest'

// providers.ts 在模块求值时读取构建期注入的全局常量，必须先桩后动态导入
vi.stubGlobal('__API_ORIGIN__', 'https://api.deepseek.com')
vi.stubGlobal('__DEV_PROXY_PREFIX__', '')

const {
  DEEPSEEK_ORIGIN,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_TOOLS_BASE_URL,
  CLIENT_ID_HEADERS,
  PROVIDERS,
  PROVIDER_IDS,
  isProviderId,
  useCustomProvider,
  setCustomProviderConfig,
  parseCustomModels,
  getProvider,
  supportsDeepseekFeatures,
} = await import('./providers.js')

type CustomProviderConfig = Parameters<typeof parseCustomModels>[0]

const defaultConfig = (): CustomProviderConfig => ({
  name: '自定义',
  baseURL: '',
  protocol: 'openai',
  modelsURL: '',
  models: '',
  defaultModel: '',
})

const makeStorage = () => {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
  }
}

let storage: ReturnType<typeof makeStorage>

beforeEach(() => {
  storage = makeStorage()
  vi.stubGlobal('localStorage', storage)
  useCustomProvider.setState({ config: defaultConfig() })
})

describe('服务商 ID 与注册表', () => {
  it('isProviderId 识别全部六个服务商 ID', () => {
    for (const id of PROVIDER_IDS) {
      expect(isProviderId(id)).toBe(true)
    }
    expect(isProviderId('unknown')).toBe(false)
    expect(isProviderId('')).toBe(false)
    expect(isProviderId(undefined)).toBe(false)
    expect(isProviderId(null)).toBe(false)
    expect(isProviderId(123)).toBe(false)
  })

  it('PROVIDER_IDS 前 5 个固定，其余来自品牌清单，custom 收尾', () => {
    expect(PROVIDER_IDS.slice(0, 5)).toEqual([
      'deepseek',
      'openrouter',
      'opencode-go',
      'opencode-zen',
      'opendesign',
    ])
    expect(PROVIDER_IDS.at(-1)).toBe('custom')
    expect(PROVIDER_IDS.length).toBeGreaterThan(50)
  })

  it('品牌清单里的供应商可直接 getProvider 且有端点', () => {
    // 从品牌清单里取一个供应商（custom 是最后一个，取倒数第二个）
    const id = PROVIDER_IDS.at(-2) ?? ''
    const p = getProvider(id)
    expect(p.id).toBe(id)
    expect(p.baseURL).toBe(`/provider/${id}`)
    expect(p.modelsURL).toBe(`/provider/${id}/models`)
  })

  it('deepseek 使用 anthropic 协议与固定地址', () => {
    const p = PROVIDERS.deepseek
    expect(p.protocol).toBe('anthropic')
    expect(p.baseURL).toBe('https://api.deepseek.com/anthropic/v1')
    expect(p.modelsURL).toBe('https://api.deepseek.com/models')
    expect(p.defaultModel).toBe('deepseek-flash')
    expect(DEEPSEEK_ORIGIN).toBe('https://api.deepseek.com')
    expect(DEEPSEEK_ANTHROPIC_BASE_URL).toBe(p.baseURL)
    expect(DEEPSEEK_TOOLS_BASE_URL).toBe('https://api.deepseek.com/v1/tools')
  })

  it('OpenAI 兼容服务商使用 openai 协议与客户端标识头', () => {
    for (const id of ['opencode-go', 'opencode-zen', 'openrouter'] as const) {
      expect(PROVIDERS[id].protocol).toBe('openai')
      expect(PROVIDERS[id].defaultModel).toBe('')
      expect(PROVIDERS[id].headers).toEqual(CLIENT_ID_HEADERS)
    }
    expect(CLIENT_ID_HEADERS).toEqual({ 'x-title': 'chat-demo' })
  })

  it('opendesign 是可直连的 OpenAI 兼容服务商且无额外头', () => {
    expect(PROVIDERS.opendesign.protocol).toBe('openai')
    expect(PROVIDERS.opendesign.baseURL).toBe('https://amr-link.open-design.ai/v1')
    expect(PROVIDERS.opendesign.modelsURL).toBe('https://amr-link.open-design.ai/v1/models')
    expect(PROVIDERS.opendesign.headers).toBeUndefined()
  })

  it('custom 是空配置的动态占位项', () => {
    expect(PROVIDERS.custom).toMatchObject({
      id: 'custom',
      name: '自定义',
      protocol: 'openai',
      baseURL: '',
      modelsURL: '',
      defaultModel: '',
    })
  })

  it('supportsDeepseekFeatures 仅对 deepseek 开放', () => {
    expect(supportsDeepseekFeatures('deepseek')).toBe(true)
    for (const id of PROVIDER_IDS.filter((item) => item !== 'deepseek')) {
      expect(supportsDeepseekFeatures(id)).toBe(false)
    }
  })
})

describe('自定义服务商配置', () => {
  it('parseCustomModels 解析 id|显示名并跳过空行', () => {
    expect(
      parseCustomModels({
        ...defaultConfig(),
        models: 'gpt-4o|GPT-4o\n deepseek-chat \n\nbad|名字',
      })
    ).toEqual([
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'deepseek-chat', label: 'deepseek-chat' },
      { id: 'bad', label: '名字' },
    ])
  })

  it('parseCustomModels 显示名为空时回落到 id', () => {
    expect(parseCustomModels({ ...defaultConfig(), models: 'm1|\n m2 |  \n' })).toEqual([
      { id: 'm1', label: 'm1' },
      { id: 'm2', label: 'm2' },
    ])
  })

  it('parseCustomModels 空清单返回空数组', () => {
    expect(parseCustomModels(defaultConfig())).toEqual([])
  })

  it('setCustomProviderConfig 合并补丁并持久化到存储', () => {
    setCustomProviderConfig({
      baseURL: 'https://llm.example.com/v1/',
      protocol: 'anthropic',
      name: '  我的服务  ',
    })
    const config = useCustomProvider.getState().config
    expect(config).toMatchObject({
      baseURL: 'https://llm.example.com/v1/',
      protocol: 'anthropic',
      name: '  我的服务  ',
    })
    // 未提及的字段保持默认
    expect(config.models).toBe('')
    expect(storage.getItem('chat-demo:custom-provider')).toContain('我的服务')
  })

  it('getProvider 对内置服务商返回注册表对象', () => {
    expect(getProvider('deepseek')).toBe(PROVIDERS.deepseek)
    expect(getProvider('openrouter')).toBe(PROVIDERS.openrouter)
  })

  it('getProvider 组装自定义服务商并规范化地址', () => {
    setCustomProviderConfig({
      name: '  本地模型  ',
      baseURL: '  https://local.example/v1///  ',
      modelsURL: '',
      models: 'm1|模型一\nm2',
      defaultModel: '',
    })
    const p = getProvider('custom')
    expect(p.id).toBe('custom')
    expect(p.name).toBe('本地模型')
    expect(p.protocol).toBe('openai')
    expect(p.baseURL).toBe('https://local.example/v1')
    expect(p.modelsURL).toBe('https://local.example/v1/models')
    expect(p.defaultModel).toBe('m1')
  })

  it('getProvider 尊重显式默认模型与清单地址', () => {
    setCustomProviderConfig({
      name: '',
      baseURL: '',
      modelsURL: '  https://models.example/list/  ',
      defaultModel: '  chosen  ',
      models: 'm1',
    })
    const p = getProvider('custom')
    expect(p.name).toBe('自定义')
    expect(p.baseURL).toBe('')
    expect(p.modelsURL).toBe('https://models.example/list')
    expect(p.defaultModel).toBe('chosen')
  })

  it('开发模式按服务商前缀重写地址（生产直连不变）', async () => {
    vi.resetModules()
    vi.stubGlobal('__DEV_PROXY_PREFIX__', '/provider')
    try {
      const dev = await import('./providers.js')
      expect(dev.PROVIDERS['opencode-go'].baseURL).toBe(
        '/provider/opencode-go/inference/go/openai/v1'
      )
      expect(dev.PROVIDERS['opencode-go'].modelsURL).toBe('/provider/opencode-go/zen/go/v1/models')
      // DeepSeek 不经过开发代理
      expect(dev.PROVIDERS.deepseek.baseURL).toBe('https://api.deepseek.com/anthropic/v1')
    } finally {
      vi.stubGlobal('__DEV_PROXY_PREFIX__', '')
    }
  })
})
