import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// presets -> settings -> providers 依赖构建期常量，先桩后导入
vi.stubGlobal('__API_ORIGIN__', 'https://api.deepseek.com')
vi.stubGlobal('__DEV_PROXY_PREFIX__', '')

const { useSettings } = await import('./settings.js')
const {
  usePresets,
  createPreset,
  updatePreset,
  deletePreset,
  setActivePreset,
  getActivePreset,
  resolvePromptVariables,
  getActivePresetPrompt,
  clearResolvedPresetPrompt,
  applyPreset,
  exportPresets,
  importPresets,
} = await import('./presets.js')
const { getDraft, useDrafts } = await import('./chat/drafts.js')
const { useChatStore } = await import('./chat/store/state.js')

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
  usePresets.setState({ presets: [], activeId: null })
  useSettings.setState({
    locale: 'zh-CN',
    provider: 'deepseek',
    models: {
      deepseek: 'deepseek-flash',
      openrouter: null,
      'opencode-go': null,
      'opencode-zen': null,
      opendesign: null,
      custom: null,
    },
    location: null,
  })
  useDrafts.setState({ drafts: new Map() })
  useChatStore.setState({ sessionCache: {} })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('预设增删改查', () => {
  it('createPreset 新建并去除首尾空白', () => {
    const preset = createPreset({
      name: '  助手  ',
      content: '  你是助手  ',
      openingMessage: '  你好  ',
    })
    expect(preset).toMatchObject({ name: '助手', content: '你是助手', openingMessage: '你好' })
    expect(preset.id).toEqual(expect.any(String))
    expect(usePresets.getState().presets).toEqual([preset])
  })

  it('createPreset 空开场白不写入字段', () => {
    const preset = createPreset({ name: 'n', content: 'c', openingMessage: '   ' })
    expect('openingMessage' in preset).toBe(false)
  })

  it('createPreset 写入本地存储', () => {
    createPreset({ name: 'n', content: 'c' })
    expect(storage.getItem('chat-demo:prompt-presets')).toContain('"name":"n"')
  })

  it('updatePreset 更新字段并裁剪空白', () => {
    const preset = createPreset({ name: 'n', content: 'c' })
    updatePreset(preset.id, { name: '  新名字 ', content: ' 新内容 ' })
    expect(usePresets.getState().presets[0]).toMatchObject({ name: '新名字', content: '新内容' })
  })

  it('updatePreset 可设置与清空开场白', () => {
    const preset = createPreset({ name: 'n', content: 'c' })
    updatePreset(preset.id, { openingMessage: ' hi ' })
    expect(usePresets.getState().presets[0].openingMessage).toBe('hi')
    updatePreset(preset.id, { openingMessage: '  ' })
    expect('openingMessage' in usePresets.getState().presets[0]).toBe(false)
  })

  it('updatePreset 对不存在的 id 不改变列表', () => {
    createPreset({ name: 'n', content: 'c' })
    const before = usePresets.getState().presets
    updatePreset('missing', { name: 'x' })
    expect(usePresets.getState().presets).toEqual(before)
  })

  it('deletePreset 删除并清空被删的激活项', () => {
    const a = createPreset({ name: 'a', content: 'a' })
    const b = createPreset({ name: 'b', content: 'b' })
    setActivePreset(a.id)
    expect(getActivePreset()?.id).toBe(a.id)
    deletePreset(a.id)
    expect(usePresets.getState().presets).toEqual([b])
    expect(usePresets.getState().activeId).toBeNull()
    expect(getActivePreset()).toBeNull()
  })

  it('setActivePreset 只接受存在的 id 或 null', () => {
    const preset = createPreset({ name: 'n', content: 'c' })
    setActivePreset('missing')
    expect(getActivePreset()).toBeNull()
    setActivePreset(preset.id)
    expect(getActivePreset()?.id).toBe(preset.id)
    setActivePreset(null)
    expect(getActivePreset()).toBeNull()
  })
})

describe('预设导入导出', () => {
  it('exportPresets 导出版本化 JSON', () => {
    createPreset({ name: 'n', content: 'c', openingMessage: 'hi' })
    const parsed = JSON.parse(exportPresets())
    expect(parsed.version).toBe(1)
    expect(parsed.presets).toEqual([{ name: 'n', content: 'c', openingMessage: 'hi' }])
  })

  it('importPresets 接受对象与数组并生成新 id', () => {
    const count = importPresets(
      JSON.stringify({
        version: 1,
        presets: [
          { name: ' x ', content: ' y ', openingMessage: ' z ' },
          { name: 'a', content: 'b' },
        ],
      })
    )
    expect(count).toBe(2)
    const list = usePresets.getState().presets
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ name: 'x', content: 'y', openingMessage: 'z' })
    expect(importPresets(JSON.stringify([{ name: 'c', content: 'd' }]))).toBe(1)
    expect(usePresets.getState().presets).toHaveLength(3)
  })

  it('importPresets 过滤非法项，全部非法时抛错', () => {
    expect(() => importPresets('not json')).toThrow()
    expect(() =>
      importPresets(
        JSON.stringify({ presets: [{ name: '', content: 'c' }, { name: 'n', content: '' }, 123] })
      )
    ).toThrow('no valid presets')
    expect(usePresets.getState().presets).toHaveLength(0)
  })
})

describe('提示词变量解析', () => {
  it('替换日期/时间/英文星期变量', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2024, 0, 15, 9, 5, 0))
    useSettings.setState({ locale: 'en-US' })
    expect(resolvePromptVariables('{{cur_date}}|{{cur_time}}|{{cur_weekday}}')).toBe(
      '2024-01-15|09:05|Monday'
    )
  })

  it('替换中文星期并保留未知变量', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2024, 0, 15, 9, 5, 0))
    expect(
      resolvePromptVariables('{{cur_weekday}} {{unknown}} {{model_name}} {{locale}}')
    ).toBe('星期一 {{unknown}} deepseek-flash zh-CN')
  })

  it('中国省市按编码回退', () => {
    useSettings.setState({ location: { region: 'CN', province: '440000', city: '440300' } })
    expect(resolvePromptVariables('{{location}}')).toBe('广东省 深圳市')
    useSettings.setState({ location: { region: 'CN', province: '110000' } })
    expect(resolvePromptVariables('{{location}}')).toBe('北京市')
    useSettings.setState({ location: { region: 'CN' } })
    expect(resolvePromptVariables('{{location}}')).toBe('')
  })

  it('非中国地区使用地区名称与 override', () => {
    useSettings.setState({ location: { region: 'HK' }, locale: 'zh-CN' })
    expect(resolvePromptVariables('{{location}}')).toBe('中国香港')
    useSettings.setState({ locale: 'en-US' })
    expect(resolvePromptVariables('{{location}}')).toBe('Hong Kong, China')
  })
})

describe('激活预设提示词', () => {
  it('无激活或空正文返回 null', () => {
    expect(getActivePresetPrompt('s1')).toBeNull()
    const preset = createPreset({ name: 'n', content: '   ' })
    setActivePreset(preset.id)
    expect(getActivePresetPrompt('s1')).toBeNull()
  })

  it('按会话冻结解析结果，切换会话上下文后重新解析', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2024, 0, 15, 9, 5, 0))
    const preset = createPreset({ name: 'n', content: '{{cur_time}}' })
    setActivePreset(preset.id)
    const first = getActivePresetPrompt('s1')
    expect(first).toBe('09:05')
    vi.setSystemTime(new Date(2024, 0, 15, 10, 30, 0))
    expect(getActivePresetPrompt('s1')).toBe(first)
    expect(getActivePresetPrompt()).toBe('10:30')
    clearResolvedPresetPrompt('s1')
    expect(getActivePresetPrompt('s1')).toBe('10:30')
  })
})

describe('应用预设', () => {
  it('在空会话填入开场白并激活', () => {
    const preset = createPreset({ name: 'n', content: 'c', openingMessage: '  你好！  ' })
    applyPreset(preset.id, 's1')
    expect(getActivePreset()?.id).toBe(preset.id)
    expect(getDraft('s1').text).toBe('你好！')
  })

  it('不覆盖已有草稿', () => {
    const preset = createPreset({ name: 'n', content: 'c', openingMessage: '你好' })
    useDrafts.setState({ drafts: new Map([['s1', { text: '已写', attachments: [] }]]) })
    applyPreset(preset.id, 's1')
    expect(getDraft('s1').text).toBe('已写')
  })

  it('不向已有消息的会话填入开场白', () => {
    const preset = createPreset({ name: 'n', content: 'c', openingMessage: '你好' })
    useChatStore.setState({
      sessionCache: { s1: { id: 's1', messages: [{}] } } as never,
    })
    applyPreset(preset.id, 's1')
    expect(getDraft('s1').text).toBe('')
  })

  it('对新对话（null）填入开场白', () => {
    const preset = createPreset({ name: 'n', content: 'c', openingMessage: '你好' })
    applyPreset(preset.id, null)
    expect(getDraft(null).text).toBe('你好')
  })
})
