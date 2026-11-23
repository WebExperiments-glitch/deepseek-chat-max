import { describe, expect, it } from 'vitest'
import { setLocale } from '../../i18n/index.js'
import { CODE_GROUP, type ApiProblemCode } from '../api/problem.js'
import { describeReply, type Notice } from './describe.js'
import type { AssistantMessage } from './types.js'

setLocale('zh')

/** 断言有提示并收窄类型（避免 lint 禁用非空断言） */
function expectNotice(value: Notice | null): Notice {
  expect(value).not.toBeNull()
  if (value === null) {
    throw new Error('expected a notice')
  }
  return value
}

const errorReply = (error: {
  kind: 'http' | 'network' | 'cors' | 'protocol' | 'stream' | 'interrupted'
  message: string
  status?: number
}): AssistantMessage =>
  ({
    id: 'm1',
    role: 'assistant',
    blocks: [],
    createdAt: 0,
    status: 'error',
    error,
  }) as unknown as AssistantMessage

const OVERFLOW_RAW =
  'user input too long, 43704 tokens exceeds max 32768 tokens (request_id: e048ca97-6835-4781-9311-d5f039cb7056)'

describe('人话投影：原始英文绝不裸奔', () => {
  it('超长错误展示中文安抚，不出现原始英文/request_id', () => {
    const notice = expectNotice(describeReply(errorReply({ kind: 'http', message: OVERFLOW_RAW, status: 400 })))
    expect(notice.text).toContain('这段对话有点长了')
    expect(notice.text).not.toMatch(/user input too long|tokens exceeds|request_id|[a-f0-9-]{36}/)
  })

  it('所有码都投影出非空中文文案，且不含服务端原文', () => {
    const statusByCode: Partial<Record<ApiProblemCode, number>> = {
      auth_failed: 401,
      insufficient_balance: 402,
      payload_too_large: 413,
      timeout: 408,
      rate_limited: 429,
      server_busy: 503,
      gateway_timeout: 504,
      server_error: 500,
      context_overflow: 400,
      unsupported_model: 400,
      invalid_request: 400,
    }
    for (const code of Object.keys(CODE_GROUP) as ApiProblemCode[]) {
      const kind = code === 'network' ? 'network' : code === 'cors' ? 'cors' : code === 'protocol' ? 'protocol' : 'http'
      const status = statusByCode[code] ?? 418
      // 这两个码靠原文关键词识别，测试里给真实文案（否则会落到 invalid_request）
      const raw =
        code === 'context_overflow'
          ? OVERFLOW_RAW
          : code === 'unsupported_model'
            ? 'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed gpt-4o.'
            : `RAW_MARKER_${code} (request_id: secret)`
      const notice = expectNotice(describeReply(errorReply({ kind, message: raw, status })))
      expect(notice.text.trim().length, `code=${code} 文案不能为空`).toBeGreaterThan(0)
      expect(notice.text, `code=${code} 不能泄露原文`).not.toContain('RAW_MARKER')
      expect(notice.text, `code=${code} 不能泄露 request_id`).not.toContain('request_id')
      expect(notice.group, `code=${code} 必须带归因`).toBe(CODE_GROUP[code])
    }
  })
})

describe('人话投影：动作与归因', () => {
  it('内容装不下给三个动作：整理 / 换模型 / 新开', () => {
    const notice = expectNotice(describeReply(errorReply({ kind: 'http', message: OVERFLOW_RAW, status: 400 })))
    expect(notice.actions).toEqual(['organize', 'switchModel', 'newDraft'])
    expect(notice.group).toBe('content')
    expect(notice.action).toBe('organize')
  })

  it('不支持的模型：给换模型动作，不泄露服务端英文原文', () => {
    const raw = 'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed gpt-4o.'
    const notice = expectNotice(describeReply(errorReply({ kind: 'http', message: raw, status: 400 })))
    expect(notice.actions).toEqual(['switchModel'])
    expect(notice.group).toBe('content')
    expect(notice.text).toContain('换个模型')
    expect(notice.text).not.toContain('supported API model names')
    expect(notice.text).not.toContain('gpt-4o')
  })

  it('401 给检查密钥，402 给充值', () => {
    expect(expectNotice(describeReply(errorReply({ kind: 'http', message: 'bad key', status: 401 }))).actions).toEqual(['apiKey'])
    expect(expectNotice(describeReply(errorReply({ kind: 'http', message: 'no balance', status: 402 }))).actions).toEqual(['topUp'])
  })

  it('挤类标记 autoRetry，不催用户重打', () => {
    for (const status of [408, 429, 503, 504]) {
      const notice = expectNotice(describeReply(errorReply({ kind: 'http', message: 'busy', status })))
      expect(notice.autoRetry).toBe(true)
      // 自动重试兜底，文案里不该出现"重试"按钮催用户动手（504 是超时，允许一个重试动作）
      if (status !== 504) {
        expect(notice.actions).toEqual([])
      }
    }
  })

  it('账户/内容类不标记 autoRetry', () => {
    for (const status of [401, 402, 400]) {
      const notice = expectNotice(describeReply(errorReply({ kind: 'http', message: status === 400 ? OVERFLOW_RAW : 'x', status })))
      expect(notice.autoRetry).toBe(false)
    }
  })

  it('上传错误沿用历史本地化文案，不走机器码投影', () => {
    const reply = {
      id: 'm2',
      role: 'assistant',
      blocks: [],
      createdAt: 0,
      status: 'error',
      error: {
        kind: 'upload',
        message: 'raw upload error',
        localMessage: { key: 'uploadFileStatusFailed' },
      },
    } as unknown as AssistantMessage
    const notice = expectNotice(describeReply(reply))
    expect(notice.text).not.toContain('raw upload error')
    expect(notice.text.length).toBeGreaterThan(0)
  })
})
