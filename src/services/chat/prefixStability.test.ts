import { describe, expect, it } from 'vitest'
import { toRequestMessages } from './reply.js'
import type { AssistantMessage, Message, UserMessage } from './types.js'

/**
 * 前缀稳定性不变量：请求 N+1 必须由「请求 N 的全部内容 + 新一轮」构成。
 * 具体地，请求 N = [历史轮次...] + 本轮提问 qN；
 * 请求 N+1 = [历史轮次...] + (qN, aN) + 本轮提问 qN+1。
 * 所以请求 N 去掉末尾的 qN 后，必须是请求 N+1 的严格前缀。
 *
 * 这锁死了所有会进入请求的元素（reminder、冻结的 requestContext、思考/工具块、
 * 签名）的序列化稳定性：任何改写历史形状、把动态内容塞进历史中间的改动都会红灯。
 */

const R1 = '2026-11-17,星期一,上海市,Web,中文'
const R2 = '2026-11-18,星期二,上海市,Web,中文'

const user = (id: string, extra: Partial<UserMessage> = {}): UserMessage => ({
  id,
  role: 'user',
  content: `问题 ${id}`,
  files: [],
  createdAt: 0,
  ...extra,
})

const assistant = (id: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: 0,
  model: 'deepseek-flash',
  prefix: true,
  status: 'done',
  stopReason: 'end_turn',
  thinking: true,
  search: true,
  latestReminder: R1,
  blocks: [{ type: 'text', text: `回答 ${id}`, citations: [] }],
  ...extra,
})

const richReply = (id: string): AssistantMessage =>
  assistant(id, {
    blocks: [
      { type: 'thinking', thinking: '先想想', signature: 'sig-1' },
      { type: 'server_tool_use', id: `srv-${id}`, name: 'deepseek_web_search', kind: 'deep_search', input: { action: 'search', queries: ['q'] }, caller: { type: 'direct' } },
      { type: 'web_fetch_tool_result', tool_use_id: `srv-${id}`, kind: 'deep_search', content: { type: 'web_fetch_tool_result_error', error_code: 'unavailable' } },
      { type: 'text', text: '根据搜索，答案如下', citations: [] },
    ],
  })

/** body 是请求去掉末尾「本轮提问」后的历史部分 */
const expectHistoryPrefix = (reqN: unknown[], reqN1: unknown[]) => {
  const historyOfN = reqN.slice(0, -1)
  expect(historyOfN.length).toBeGreaterThan(0)
  expect(reqN1.slice(0, historyOfN.length)).toEqual(historyOfN)
}

describe('请求前缀稳定性不变量', () => {
  it('推进一轮后，上一轮及其之前的所有内容逐字节不变', () => {
    const u1 = user('u1')
    const a1 = assistant('a1')
    // 请求 N：历史 [u1,a1]，本轮提问 q1（带冻结上下文）
    const q1 = user('q1', { requestContext: '冻结上下文 A' })
    const reqN = toRequestMessages([u1, a1], q1, undefined, false, R1)

    // 请求 N+1：历史变成 [u1,a1,q1,a1']，本轮提问 q2
    const a1Reply = assistant('q1-answer', { latestReminder: R1 })
    const reqN1 = toRequestMessages(
      [u1, a1, q1, a1Reply],
      user('q2', { requestContext: '冻结上下文 B' }),
      undefined,
      false,
      R2
    )

    expectHistoryPrefix(reqN, reqN1)
  })

  it('带思考块与工具块的回答，推进一轮后前缀仍不变', () => {
    const u1 = user('u1')
    const a1 = richReply('a1')
    const q1 = user('q1', { requestContext: '冻结 A' })
    const reqN = toRequestMessages([u1, a1], q1, undefined, true, R1)

    const q1Reply = richReply('q1-answer')
    const reqN1 = toRequestMessages(
      [u1, a1, q1, q1Reply],
      user('q2', { requestContext: '冻结 B' }),
      undefined,
      true,
      R2
    )

    expectHistoryPrefix(reqN, reqN1)
  })

  it('同一段历史重复序列化结果完全一致（无随机、无时间依赖）', () => {
    const history: Message[] = [user('u1', { requestContext: '冻结 A' }), richReply('a1')]
    const q = user('q1', { requestContext: '冻结 B' })
    const first = toRequestMessages(history, q, undefined, true, R1)
    const second = toRequestMessages(history, q, undefined, true, R1)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
  })

  it('历史消息对象被就地改写会反映到请求（证明请求确实派生自消息内容）', () => {
    const u1 = user('u1', { content: '原文' })
    const a1 = assistant('a1')
    const before = toRequestMessages([u1, a1], user('q1'), undefined, false, R1)
    u1.content = '被改写'
    const after = toRequestMessages([u1, a1], user('q1'), undefined, false, R1)
    expect(after[1]).not.toEqual(before[1])
  })

  it('拒答轮次不进历史，但不会改动已有历史部分', () => {
    const u1 = user('u1')
    const a1 = assistant('a1')
    const q1 = user('q1')
    const reqN = toRequestMessages([u1, a1], q1, undefined, false, R1)

    // q1 的正常回答进历史；再追加一个被拒答的轮次（不进上下文）
    const q1Reply = assistant('q1-answer')
    const refusedUser = user('u2')
    const refused = assistant('u2-answer', { stopReason: 'refusal' })
    const reqN1 = toRequestMessages(
      [u1, a1, q1, q1Reply, refusedUser, refused],
      user('q3'),
      undefined,
      false,
      R1
    )

    expectHistoryPrefix(reqN, reqN1)
  })
})
