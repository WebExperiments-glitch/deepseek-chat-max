import { describe, it, expect } from 'vitest'
import {
  normalizeSession,
  getVisibleMessages,
  buildMessageVersions,
  appendBranch,
  selectVersion,
} from './branches.js'
import type { AssistantMessage, Message, Session, UserMessage } from './types.js'

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

/** root 省略表示线性会话；显式传 null / 字符串表示已有分支结构 */
const makeSession = (messages: Message[], root?: string | null): Session => ({
  id: 's',
  title: 't',
  createdAt: 0,
  updatedAt: 0,
  messages,
  ...(root === undefined ? {} : { rootMessageId: root }),
})

describe('normalizeSession', () => {
  it('线性会话规范化为单分支：补 root、parent 与 selectedChild', () => {
    const s = makeSession([user('u1'), assistant('a1'), user('u2')])
    const n = normalizeSession(s)

    expect(n).not.toBe(s)
    expect(n.rootMessageId).toBe('u1')
    expect(n.messages.map((m) => m.parentId)).toEqual([null, 'u1', 'a1'])
    expect(n.messages.map((m) => m.selectedChildId)).toEqual(['a1', 'u2', undefined])
    expect(n.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
  })

  it('空会话规范化后 rootMessageId 为 null', () => {
    const n = normalizeSession(makeSession([]))
    expect(n.rootMessageId).toBeNull()
    expect(n.messages).toEqual([])
  })

  it('已经是分支结构的会话原样返回（含 rootMessageId: null）', () => {
    const branched = makeSession([user('u1')], 'u1')
    expect(normalizeSession(branched)).toBe(branched)

    const empty = makeSession([], null)
    expect(normalizeSession(empty)).toBe(empty)
  })

  it('规范化不修改原会话对象和消息', () => {
    const s = makeSession([user('u1'), assistant('a1')])
    normalizeSession(s)
    expect(s.rootMessageId).toBeUndefined()
    expect(s.messages[0].parentId).toBeUndefined()
    expect(s.messages[0].selectedChildId).toBeUndefined()
  })
})

describe('getVisibleMessages', () => {
  it('线性会话直接返回原消息数组', () => {
    const messages = [user('u1'), assistant('a1')]
    expect(getVisibleMessages(makeSession(messages))).toBe(messages)
  })

  it('规范化后的线性会话按顺序返回完整路径', () => {
    const s = normalizeSession(
      makeSession([user('u1'), assistant('a1'), user('u2'), assistant('a2')])
    )
    expect(getVisibleMessages(s).map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('多分支按 selectedChildId 选择路径，切换后恢复对应分支的后续消息', () => {
    const s = makeSession(
      [
        user('u0', { selectedChildId: 'a1' }),
        assistant('a1', { parentId: 'u0' }),
        assistant('a2', { parentId: 'u0', selectedChildId: 'u3' }),
        user('u3', { parentId: 'a2', selectedChildId: 'a3' }),
        assistant('a3', { parentId: 'u3' }),
      ],
      'u0'
    )
    expect(getVisibleMessages(s).map((m) => m.id)).toEqual(['u0', 'a1'])

    const s2: Session = {
      ...s,
      messages: s.messages.map((m) =>
        m.id === 'u0' ? { ...m, selectedChildId: 'a2' } : m
      ),
    }
    expect(getVisibleMessages(s2).map((m) => m.id)).toEqual(['u0', 'a2', 'u3', 'a3'])
  })

  it('selectedChildId 指向缺失消息时安全终止', () => {
    const s = makeSession(
      [user('u0', { selectedChildId: 'missing' }), assistant('a1', { parentId: 'u0' })],
      'u0'
    )
    expect(getVisibleMessages(s).map((m) => m.id)).toEqual(['u0'])
  })
})

describe('buildMessageVersions', () => {
  it('规范化线性会话每条消息自成一个版本组', () => {
    const s = normalizeSession(makeSession([user('u1'), assistant('a1')]))
    const versions = buildMessageVersions(s, new Map())

    expect(versions.size).toBe(2)
    expect(versions.get('u1')).toEqual({ ids: ['u1'], index: 0 })
    expect(versions.get('a1')).toEqual({ ids: ['a1'], index: 0 })
  })

  it('未规范化会话以自身 id 作为分组键', () => {
    const s = makeSession([user('u1'), assistant('a1')])
    const versions = buildMessageVersions(s, new Map())
    expect(versions.get('u1')).toEqual({ ids: ['u1'], index: 0 })
    expect(versions.get('a1')).toEqual({ ids: ['a1'], index: 0 })
  })

  it('兄弟消息共享同一版本列表并带正确索引', () => {
    const s = makeSession(
      [
        user('u0', { selectedChildId: 'a1' }),
        assistant('a1', { parentId: 'u0' }),
        assistant('a2', { parentId: 'u0' }),
      ],
      'u0'
    )
    const versions = buildMessageVersions(s, new Map())

    expect(versions.get('a1')).toEqual({ ids: ['a1', 'a2'], index: 0 })
    expect(versions.get('a2')).toEqual({ ids: ['a1', 'a2'], index: 1 })
    expect(versions.get('u0')).toEqual({ ids: ['u0'], index: 0 })
  })

  it('版本列表未变化时复用上一次的 Map 对象', () => {
    const s = normalizeSession(makeSession([user('u1'), assistant('a1')]))
    const first = buildMessageVersions(s, new Map())
    expect(buildMessageVersions(s, first)).toBe(first)
  })

  it('新增兄弟版本后生成新的 Map 并更新 ids', () => {
    const s = makeSession(
      [
        user('u0', { selectedChildId: 'a1' }),
        assistant('a1', { parentId: 'u0' }),
        assistant('a2', { parentId: 'u0' }),
      ],
      'u0'
    )
    const previous = buildMessageVersions(s, new Map())
    expect(buildMessageVersions(s, previous)).toBe(previous)

    const withThird: Session = {
      ...s,
      messages: [...s.messages, assistant('a3', { parentId: 'u0' })],
    }
    const next = buildMessageVersions(withThird, previous)
    expect(next).not.toBe(previous)
    expect(next.get('a1')).toEqual({ ids: ['a1', 'a2', 'a3'], index: 0 })
    expect(next.get('a3')).toEqual({ ids: ['a1', 'a2', 'a3'], index: 2 })
  })
})

describe('appendBranch', () => {
  it('parentId 为 null 时新增分支成为新的根', () => {
    const s = normalizeSession(makeSession([user('u1'), assistant('a1')]))
    const next = appendBranch(s, null, [user('u2'), assistant('a2')])

    expect(next.rootMessageId).toBe('u2')
    expect(next.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(getVisibleMessages(next).map((m) => m.id)).toEqual(['u2', 'a2'])
  })

  it('在中间节点追加分支：改选子节点但保留原分支', () => {
    const s = normalizeSession(
      makeSession([user('u1'), assistant('a1'), user('u2'), assistant('a2')])
    )
    const next = appendBranch(s, 'a1', [user('u3'), assistant('a3')])

    expect(next.rootMessageId).toBe('u1')
    expect(next.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    expect(next.messages.find((m) => m.id === 'a1')?.selectedChildId).toBe('u3')
    expect(next.messages.find((m) => m.id === 'u3')?.parentId).toBe('a1')
    expect(getVisibleMessages(next).map((m) => m.id)).toEqual(['u1', 'a1', 'u3', 'a3'])
  })

  it('传入空消息数组时只返回规范化后的会话', () => {
    const s = makeSession([user('u1')])
    const next = appendBranch(s, 'u1', [])

    expect(next).not.toBe(s)
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0].parentId).toBeNull()
    expect(getVisibleMessages(next).map((m) => m.id)).toEqual(['u1'])
  })
})

describe('selectVersion', () => {
  it('切换当前路径上节点的兄弟版本并恢复其后续分支', () => {
    const s = makeSession(
      [
        user('u0', { selectedChildId: 'a1' }),
        assistant('a1', { parentId: 'u0' }),
        assistant('a2', { parentId: 'u0', selectedChildId: 'u3' }),
        user('u3', { parentId: 'a2', selectedChildId: 'a3' }),
        assistant('a3', { parentId: 'u3' }),
      ],
      'u0'
    )
    const next = selectVersion(s, 'a2')

    expect(next).not.toBe(s)
    expect(next.rootMessageId).toBe('u0')
    expect(next.messages.find((m) => m.id === 'u0')?.selectedChildId).toBe('a2')
    expect(getVisibleMessages(next).map((m) => m.id)).toEqual(['u0', 'a2', 'u3', 'a3'])
  })

  it('切换根节点的兄弟版本时重设 rootMessageId', () => {
    const s = makeSession(
      [
        user('u0', { parentId: null, selectedChildId: 'a1' }),
        assistant('a1', { parentId: 'u0' }),
        user('u2', { parentId: null, selectedChildId: 'a2' }),
        assistant('a2', { parentId: 'u2' }),
      ],
      'u0'
    )
    const next = selectVersion(s, 'u2')

    expect(next.rootMessageId).toBe('u2')
    expect(getVisibleMessages(next).map((m) => m.id)).toEqual(['u2', 'a2'])
  })

  it('目标消息不存在时原样返回', () => {
    const s = makeSession([user('u0', { parentId: null })], 'u0')
    expect(selectVersion(s, 'nope')).toBe(s)
  })

  it('目标消息不在当前路径且没有可见兄弟时原样返回', () => {
    const s = makeSession(
      [
        user('u0', { selectedChildId: 'a1' }),
        assistant('a1', { parentId: 'u0' }),
        assistant('x', { parentId: 'ghost' }),
      ],
      'u0'
    )
    expect(selectVersion(s, 'x')).toBe(s)
  })
})
