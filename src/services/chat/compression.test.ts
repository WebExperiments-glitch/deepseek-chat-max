import { describe, it, expect, vi } from 'vitest'
import { normalizeSession } from './branches.js'
import type { AssistantMessage, Message, Session, SessionCompression, UserMessage } from './types.js'

// compression.ts 的依赖链（api/client.ts、providers.ts）在模块求值时读取构建期注入的全局常量，
// 必须先桩后动态导入。
vi.stubGlobal('__API_ORIGIN__', 'https://api.deepseek.com')
vi.stubGlobal('__DEV_PROXY_PREFIX__', '')

const {
  applyCompression,
  autoCompressNeeded,
  compressionSummarySection,
  isCompressing,
  compressSession,
} = await import('./compression.js')

const user = (id: string, extra: Partial<UserMessage> = {}): UserMessage => ({
  id,
  role: 'user',
  content: `q-${id}`,
  files: [],
  createdAt: 0,
  ...extra,
})

const assistant = (id: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: 0,
  model: null,
  prefix: true,
  status: 'done',
  blocks: [],
  ...extra,
})

const makeSession = (messages: Message[]): Session =>
  normalizeSession({ id: 's', title: 't', createdAt: 0, updatedAt: 0, messages })

/** n 个「提问 + 可用回答」轮次 */
const rounds = (n: number): Session => {
  const messages: Message[] = []
  for (let i = 1; i <= n; i += 1) {
    messages.push(user(`u${i}`))
    messages.push(
      assistant(`a${i}`, { status: 'done', blocks: [{ type: 'text', text: 'A', citations: [] }] })
    )
  }
  return makeSession(messages)
}

const compression = (upToMessageId: string, extra: Partial<SessionCompression> = {}): SessionCompression => ({
  summary: 'SUM',
  upToMessageId,
  rounds: 1,
  at: 0,
  ...extra,
})

/** reserveGeometry(200000, 1000) 的阈值为 133464，140000 已超过 */
const pressure = { tokens: 140_000, window: 200_000, maxOutputTokens: 1000 }

describe('applyCompression', () => {
  it('没有压缩记录时原样返回历史数组', () => {
    const history = [user('u1'), assistant('a1')]
    expect(applyCompression(history)).toBe(history)
    expect(applyCompression(history, undefined)).toBe(history)
  })

  it('找到截止消息时返回其后的消息', () => {
    const history = [user('u1'), assistant('a1'), user('u2'), assistant('a2')]
    expect(applyCompression(history, compression('a1')).map((m) => m.id)).toEqual(['u2', 'a2'])
  })

  it('截止消息是第一条时返回其余全部', () => {
    const history = [user('u1'), assistant('a1'), user('u2'), assistant('a2')]
    expect(applyCompression(history, compression('u1')).map((m) => m.id)).toEqual(['a1', 'u2', 'a2'])
  })

  it('截止消息是最后一条时返回空数组', () => {
    const history = [user('u1'), assistant('a1')]
    expect(applyCompression(history, compression('a1'))).toEqual([])
  })

  it('截止消息不存在时原样返回完整历史', () => {
    const history = [user('u1'), assistant('a1')]
    expect(applyCompression(history, compression('missing'))).toBe(history)
  })
})

describe('autoCompressNeeded', () => {
  it('用量低于压力阈值时不压缩', () => {
    expect(autoCompressNeeded(rounds(5), { ...pressure, tokens: 100_000 })).toBe(false)
  })

  it('窗口装不下输出预留与压缩余量时不压缩', () => {
    expect(
      autoCompressNeeded(rounds(5), { tokens: 999_999, window: 60_000, maxOutputTokens: 1000 })
    ).toBe(false)
  })

  it('可压缩轮次不足 5 轮时不压缩', () => {
    expect(autoCompressNeeded(rounds(4), pressure)).toBe(false)
  })

  it('恰好 5 轮且没有压缩记录、压力达标时触发压缩', () => {
    expect(autoCompressNeeded(rounds(5), pressure)).toBe(true)
  })

  it('已有压缩记录但截止消息不在可见路径时触发压缩', () => {
    const s = { ...rounds(5), compression: compression('missing') }
    expect(autoCompressNeeded(s, pressure)).toBe(true)
  })

  it('上次压缩后没有新增轮次时不压缩', () => {
    const s = { ...rounds(5), compression: compression('a5') }
    expect(autoCompressNeeded(s, pressure)).toBe(false)
  })

  it('上次压缩后只新增 1 轮时不压缩', () => {
    const s = { ...rounds(5), compression: compression('u4') }
    expect(autoCompressNeeded(s, pressure)).toBe(false)
  })

  it('上次压缩后新增至少 2 轮时再次压缩', () => {
    const s = { ...rounds(5), compression: compression('u3') }
    expect(autoCompressNeeded(s, pressure)).toBe(true)
  })
})

describe('compressionSummarySection', () => {
  it('没有压缩记录时返回空串', () => {
    expect(compressionSummarySection(undefined, 'zh-CN')).toBe('')
    expect(compressionSummarySection(undefined, 'en-US')).toBe('')
  })

  it('中文摘要段落带中文标题', () => {
    expect(compressionSummarySection(compression('u1', { summary: '摘要' }), 'zh-CN')).toBe(
      '【较早对话摘要】\n摘要'
    )
  })

  it('英文摘要段落带英文标题', () => {
    expect(compressionSummarySection(compression('u1', { summary: 'SUM' }), 'en-US')).toBe(
      '[Earlier conversation summary]\nSUM'
    )
  })
})

describe('compressSession 的提前返回', () => {
  it('没有 apiKey 时返回 noKey', async () => {
    await expect(compressSession(rounds(1), '', 'zh-CN')).resolves.toEqual({
      ok: false,
      reason: 'noKey',
    })
  })

  it('轮次不足时返回 tooShort', async () => {
    await expect(compressSession(rounds(4), 'key', 'zh-CN')).resolves.toEqual({
      ok: false,
      reason: 'tooShort',
    })
  })

  it('被压缩区间没有助手回答时返回 tooShort', async () => {
    const messages: Message[] = [user('u1'), user('u2'), user('u3'), user('u4'), user('u5')]
    await expect(compressSession(makeSession(messages), 'key', 'zh-CN')).resolves.toEqual({
      ok: false,
      reason: 'tooShort',
    })
  })

  it('没有正在压缩的会话时 isCompressing 为 false', () => {
    expect(isCompressing('s')).toBe(false)
    expect(isCompressing('other')).toBe(false)
  })
})
