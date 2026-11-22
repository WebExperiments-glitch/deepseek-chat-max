import { describe, expect, it } from 'vitest'
import { EXPORT_FORMAT_VERSION } from './format.js'
import { BackupError } from './errors.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'

const TIME = '2026-01-01T00:00:00.000Z'

const keyOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
    return undefined
  } catch (error) {
    return error instanceof BackupError ? error.key : 'other'
  }
}

const indexEntry = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-1',
  title: null,
  pinned: true,
  message_count: 2,
  inserted_at: TIME,
  updated_at: TIME,
  ...overrides,
})

const message = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  parent_id: null,
  role: 'USER',
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 100,
  inserted_at: TIME,
  fragments: [{ type: 'REQUEST', content: '你好' }],
  ...overrides,
})

const sessionFile = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-1',
  title: null,
  pinned: true,
  current_message_id: 1,
  inserted_at: TIME,
  updated_at: TIME,
  messages: [message()],
  ...overrides,
})

describe('checkManifest', () => {
  it('接受当前版本', () => {
    expect(() => checkManifest({ export_format_version: EXPORT_FORMAT_VERSION })).not.toThrow()
  })

  it('拒绝更高版本并给出升级提示', () => {
    expect(keyOf(() => checkManifest({ export_format_version: EXPORT_FORMAT_VERSION + 1 }))).toBe(
      'backupNewerVersion'
    )
  })

  it('拒绝不匹配版本', () => {
    expect(keyOf(() => checkManifest({ export_format_version: EXPORT_FORMAT_VERSION - 1 }))).toBe(
      'backupInvalidVersion'
    )
  })

  it('缺少版本字段时按结构错误处理', () => {
    expect(keyOf(() => checkManifest({}))).toBe('backupInvalidVersion')
  })

  it('非对象输入报结构错误', () => {
    expect(keyOf(() => checkManifest(null))).toBe('backupIncomplete')
    expect(keyOf(() => checkManifest([]))).toBe('backupIncomplete')
  })
})

describe('readSessionIndex', () => {
  it('读取合法条目并把 pinned 强制为 false', () => {
    const result = readSessionIndex([indexEntry()])
    expect(result).toHaveLength(1)
    expect(result[0].pinned).toBe(false)
    expect(result[0].message_count).toBe(2)
  })

  it('保留亚秒级时间原文', () => {
    const precise = '2026-01-01T00:00:00.123456Z'
    const result = readSessionIndex([indexEntry({ inserted_at: precise })])
    expect(result[0].inserted_at).toBe(precise)
  })

  it('接受整秒时间', () => {
    const result = readSessionIndex([indexEntry({ inserted_at: '2026-01-01T00:00:00Z' })])
    expect(result[0].inserted_at).toBe('2026-01-01T00:00:00Z')
  })

  it('拒绝非法时间格式', () => {
    expect(keyOf(() => readSessionIndex([indexEntry({ inserted_at: '2026/01/01' })]))).toBe(
      'backupIncomplete'
    )
  })

  it('拒绝不存在的日期', () => {
    expect(
      keyOf(() => readSessionIndex([indexEntry({ inserted_at: '2026-02-30T00:00:00Z' })]))
    ).toBe('backupIncomplete')
  })

  it('拒绝含路径分隔符的会话 ID', () => {
    expect(keyOf(() => readSessionIndex([indexEntry({ id: '../evil' })]))).toBe(
      'backupIncomplete'
    )
    expect(keyOf(() => readSessionIndex([indexEntry({ id: 'a/b' })]))).toBe('backupIncomplete')
  })

  it('拒绝点号会话 ID', () => {
    expect(keyOf(() => readSessionIndex([indexEntry({ id: '.' })]))).toBe('backupIncomplete')
    expect(keyOf(() => readSessionIndex([indexEntry({ id: '..' })]))).toBe('backupIncomplete')
  })

  it('拒绝负数消息数', () => {
    expect(keyOf(() => readSessionIndex([indexEntry({ message_count: -1 })]))).toBe(
      'backupIncomplete'
    )
  })

  it('拒绝非数组输入', () => {
    expect(keyOf(() => readSessionIndex({}))).toBe('backupIncomplete')
  })
})

describe('readSessionFile', () => {
  it('读取合法会话文件', () => {
    const result = readSessionFile(sessionFile())
    expect(result.id).toBe('session-1')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].role).toBe('USER')
  })

  it('pinned 强制为 false', () => {
    expect(readSessionFile(sessionFile()).pinned).toBe(false)
  })

  it('丢弃无法识别的片段但保留其余片段', () => {
    const result = readSessionFile(
      sessionFile({
        messages: [
          message({
            fragments: [
              { type: 'REQUEST', content: '你好' },
              { type: 'UNKNOWN', content: '未知' },
              { type: 'RESPONSE', content: '再见' },
            ],
          }),
        ],
      })
    )
    expect(result.messages[0].fragments.map((item) => item.type)).toEqual(['REQUEST', 'RESPONSE'])
  })

  it('拒绝非法消息角色', () => {
    expect(
      keyOf(() => readSessionFile(sessionFile({ messages: [message({ role: 'SYSTEM' })] })))
    ).toBe('backupIncomplete')
  })

  it('拒绝非法消息状态', () => {
    expect(
      keyOf(() => readSessionFile(sessionFile({ messages: [message({ status: 'UNKNOWN' })] })))
    ).toBe('backupIncomplete')
  })

  it('current_message_id 必须是非负整数', () => {
    expect(keyOf(() => readSessionFile(sessionFile({ current_message_id: -1 })))).toBe(
      'backupIncomplete'
    )
  })

  it('读取可选的工具元数据字段', () => {
    const result = readSessionFile(
      sessionFile({
        messages: [
          message({
            fragments: [
              {
                type: 'TOOL_SEARCH',
                queries: ['上海'],
                results: [],
                status: 'FINISHED',
                stage_id: 2,
                group_id: 3,
              },
            ],
          }),
        ],
      })
    )
    expect(result.messages[0].fragments[0]).toMatchObject({ status: 'FINISHED', stage_id: 2 })
  })

  it('非法提示样式只丢弃该片段，不使整个导入失败', () => {
    const result = readSessionFile(
      sessionFile({
        messages: [
          message({ fragments: [{ type: 'TIP', content: '提示', style: 'DANGER' }] }),
        ],
      })
    )
    expect(result.messages[0].fragments).toHaveLength(0)
  })
})
