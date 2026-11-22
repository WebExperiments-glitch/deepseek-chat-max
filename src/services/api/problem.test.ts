import { describe, expect, it } from 'vitest'
import { ApiError } from './client.js'
import {
  CODE_GROUP,
  codeFromStatus,
  isAutoRetryable,
  isContextOverflowMessage,
  toProblem,
  type ApiProblem,
  type ApiProblemCode,
} from './problem.js'

/** 闸门自检：所有稳定码必须归类，且码集合与映射表完全一致（漏配/多配都会失败） */
const ALL_CODES: ApiProblemCode[] = [
  'context_overflow',
  'payload_too_large',
  'auth_failed',
  'insufficient_balance',
  'timeout',
  'rate_limited',
  'server_busy',
  'gateway_timeout',
  'server_error',
  'invalid_request',
  'network',
  'cors',
  'protocol',
  'unknown',
]

describe('机器码闸门：穷尽性', () => {
  it('每个稳定码都有归因，且映射表没有多余项', () => {
    expect(new Set(ALL_CODES)).toEqual(new Set(Object.keys(CODE_GROUP)))
    for (const code of ALL_CODES) {
      expect(CODE_GROUP[code]).toBeTruthy()
    }
  })

  it('四类归因都至少被一个码覆盖', () => {
    const groups = new Set(Object.values(CODE_GROUP))
    expect(groups).toEqual(new Set(['content', 'account', 'crowded', 'ours', 'connection']))
  })
})

describe('codeFromStatus：HTTP 码 → 稳定机器码', () => {
  const cases: Array<[number, string, ApiProblemCode]> = [
    [401, 'invalid api key', 'auth_failed'],
    [402, 'insufficient balance', 'insufficient_balance'],
    [413, 'file too large', 'payload_too_large'],
    [408, 'upload too slow', 'timeout'],
    [429, 'rate limit reached', 'rate_limited'],
    [503, 'server overloaded', 'server_busy'],
    [504, 'gateway timeout', 'gateway_timeout'],
    [500, 'internal error', 'server_error'],
    [502, 'bad gateway', 'server_error'],
    [400, 'invalid request format', 'invalid_request'],
    [422, 'bad parameter', 'invalid_request'],
    [418, "I'm a teapot", 'unknown'],
  ]
  it.each(cases)('%i → %s → %s', (status, msg, expected) => {
    expect(codeFromStatus(status, msg)).toBe(expected)
  })

  it('400/422 带超长关键词 → context_overflow（优先级高于 invalid_request）', () => {
    expect(codeFromStatus(400, 'user input too long, 43704 tokens exceeds max 32768 tokens')).toBe(
      'context_overflow'
    )
    expect(codeFromStatus(422, 'maximum context length exceeded')).toBe('context_overflow')
  })

  it('其它码即使带超长关键词也不误判为超长', () => {
    expect(codeFromStatus(429, 'input too long')).toBe('rate_limited')
  })
})

describe('超长识别：用户给的真实报错必须命中', () => {
  it('命中各类超长文案', () => {
    expect(isContextOverflowMessage('user input too long, 43704 tokens exceeds max 32768 tokens (request_id: e048ca97)')).toBe(true)
    expect(isContextOverflowMessage('This model\'s maximum context length is 32768 tokens')).toBe(true)
    expect(isContextOverflowMessage('context_window_exceeded')).toBe(true)
    expect(isContextOverflowMessage('too many tokens in the request')).toBe(true)
  })
  it('普通报错不误命中', () => {
    expect(isContextOverflowMessage('invalid api key')).toBe(false)
    expect(isContextOverflowMessage('insufficient balance')).toBe(false)
  })
})

describe('toProblem：任意失败归一', () => {
  it('ApiError 按 kind / status 归一', () => {
    expect(toProblem(new ApiError('cors', 'x')).code).toBe('cors')
    expect(toProblem(new ApiError('network', 'x')).code).toBe('network')
    expect(toProblem(new ApiError('protocol', 'x')).code).toBe('protocol')
    expect(toProblem(new ApiError('http', 'x', 402)).code).toBe('insufficient_balance')
  })

  it('持久化在历史里的结构化错误（非实例）也能归一', () => {
    expect(toProblem({ kind: 'http', message: 'rate limit', status: 429 }).code).toBe('rate_limited')
    expect(toProblem({ kind: 'network', message: 'offline' }).group).toBe('connection')
    expect(toProblem({ kind: 'http', message: 'bad', status: 400 }).code).toBe('invalid_request')
  })

  it('非 Error 兜底为 unknown/ours，且不抛异常', () => {
    expect(toProblem('boom')).toEqual({ code: 'unknown', group: 'ours', raw: 'boom' })
    expect(toProblem(null).code).toBe('unknown')
  })

  it('raw 永远保留原文（仅诊断用），不参与展示决策', () => {
    const raw = 'user input too long, 43704 tokens exceeds max 32768 tokens (request_id: e048ca97-...)'
    const problem = toProblem(new ApiError('http', raw, 400))
    expect(problem.raw).toBe(raw)
    expect(problem.code).toBe('context_overflow')
  })
})

describe('闸门：是否后台自动重试', () => {
  const problemOf = (code: ApiProblemCode): ApiProblem => ({
    code,
    group: CODE_GROUP[code],
    raw: '',
  })

  it('挤/连接类自动重试', () => {
    for (const code of [
      'timeout',
      'rate_limited',
      'server_busy',
      'gateway_timeout',
      'network',
      'cors',
    ] as ApiProblemCode[]) {
      expect(isAutoRetryable(problemOf(code))).toBe(true)
    }
  })

  it('账户/内容/参数/服务故障类绝不自动重试', () => {
    for (const code of [
      'auth_failed',
      'insufficient_balance',
      'context_overflow',
      'payload_too_large',
      'invalid_request',
      'server_error',
      'protocol',
      'unknown',
    ] as ApiProblemCode[]) {
      expect(isAutoRetryable(problemOf(code))).toBe(false)
    }
  })
})
