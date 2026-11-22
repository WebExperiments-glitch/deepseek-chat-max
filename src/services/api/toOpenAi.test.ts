import { describe, expect, it } from 'vitest'
import {
  formatInlineAttachment,
  replyPrefixText,
  toOpenAiMessages,
  type ImageDetail,
  type InlineAttachment,
} from './toOpenAi.js'
const image = (dataUrl: string, detail?: ImageDetail): InlineAttachment => ({
  kind: 'image',
  name: '图片.png',
  dataUrl,
  ...(detail ? { detail } : {}),
})

const textAttachment = (name: string, text: string, source?: 'ocr'): InlineAttachment => ({
  kind: 'text',
  name,
  text,
  ...(source ? { source } : {}),
})

describe('formatInlineAttachment', () => {
  it('按文件名包裹文本附件', () => {
    expect(formatInlineAttachment({ name: 'a.txt', text: '附件内容' })).toBe(
      '<file name="a.txt">\n附件内容\n</file>'
    )
  })

  it('空文本也照常包裹', () => {
    expect(formatInlineAttachment({ name: 'empty.txt', text: '' })).toBe(
      '<file name="empty.txt">\n\n</file>'
    )
  })

  it('超过 200000 字符时截断并标注', () => {
    const long = 'x'.repeat(200_001)
    expect(formatInlineAttachment({ name: 'big.txt', text: long })).toBe(
      `<file name="big.txt">\n${'x'.repeat(200_000)}\n…（已截断）\n</file>`
    )
  })

  it('正好 200000 字符不截断', () => {
    const exact = 'y'.repeat(200_000)
    expect(formatInlineAttachment({ name: 'exact.txt', text: exact })).toBe(
      `<file name="exact.txt">\n${exact}\n</file>`
    )
  })
})

describe('replyPrefixText', () => {
  it('只取文本块，用两个换行拼接', () => {
    expect(
      replyPrefixText([
        { type: 'text', text: '第一段' },
        { type: 'thinking', text: '忽略' },
        { type: 'text', text: '第二段' },
      ])
    ).toBe('第一段\n\n第二段')
  })

  it('非 text 类型或缺失 text 的块被忽略', () => {
    expect(replyPrefixText([{ type: 'text' }, { type: 'tool_use' }])).toBe('')
  })

  it('空数组返回空字符串', () => {
    expect(replyPrefixText([])).toBe('')
  })
})

describe('toOpenAiMessages', () => {
  it('始终以 system 消息开头', () => {
    expect(toOpenAiMessages('系统提示', [], [])).toEqual([{ role: 'system', content: '系统提示' }])
  })

  it('纯字符串 user 消息直接转成 user 消息', () => {
    expect(toOpenAiMessages('sys', [{ role: 'user', content: '你好' }], [])).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '你好' },
    ])
  })

  it('空白 user 消息被跳过', () => {
    expect(
      toOpenAiMessages(
        'sys',
        [
          { role: 'user', content: '   ' },
          { role: 'user', content: '有效' },
        ],
        []
      )
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '有效' },
    ])
  })

  it('latest_reminder 折进紧随其后的 system 消息', () => {
    expect(
      toOpenAiMessages(
        'sys',
        [
          { role: 'latest_reminder', content: '现在 2026-11-18' },
          { role: 'user', content: '问题' },
        ],
        []
      )
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'system', content: '现在 2026-11-18' },
      { role: 'user', content: '问题' },
    ])
  })

  it('空的 latest_reminder 不产生消息，也不占用附件下标', () => {
    expect(
      toOpenAiMessages(
        'sys',
        [
          { role: 'latest_reminder', content: '' },
          { role: 'user', content: '问题' },
        ],
        [[image('u1')]]
      )
    ).toEqual([
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '问题' },
          { type: 'image_url', image_url: { url: 'u1' } },
        ],
      },
    ])
  })

  it('assistant 只拼接文本块，思考等块被忽略', () => {
    expect(
      toOpenAiMessages(
        'sys',
        [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'A' },
              { type: 'thinking', thinking: '思考', signature: 's' },
              { type: 'text', text: 'B' },
            ],
          },
        ],
        []
      )
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'A\n\nB' },
    ])
  })

  it('assistant 没有文本块时被跳过', () => {
    expect(
      toOpenAiMessages(
        'sys',
        [{ role: 'assistant', content: [{ type: 'thinking', thinking: '思考', signature: 's' }] }],
        []
      )
    ).toEqual([{ role: 'system', content: 'sys' }])
  })

  it('user 内容数组只取 text 块并用空行拼接', () => {
    expect(
      toOpenAiMessages(
        'sys',
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: '第一段' },
              { type: 'text', text: '第二段' },
            ],
          },
        ],
        []
      )
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '第一段\n\n第二段' },
    ])
  })

  it('文本附件包裹后内联进 user 正文', () => {
    expect(
      toOpenAiMessages('sys', [{ role: 'user', content: '问' }], [
        [textAttachment('note.txt', '附件内容')],
      ])
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '问\n\n<file name="note.txt">\n附件内容\n</file>' },
    ])
  })

  it('图片附件生成 image_url part，并保留 detail', () => {
    expect(
      toOpenAiMessages('sys', [{ role: 'user', content: '看图' }], [
        [image('data:image/png;base64,aaa', 'low')],
      ])
    ).toEqual([
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aaa', detail: 'low' } },
        ],
      },
    ])
  })

  it('文本附件与多张图片共存时，text part 在前、图片依次在后', () => {
    expect(
      toOpenAiMessages('sys', [{ role: 'user', content: '对比' }], [
        [textAttachment('a.txt', '说明'), image('u1', 'high'), image('u2')],
      ])
    ).toEqual([
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '对比\n\n<file name="a.txt">\n说明\n</file>' },
          { type: 'image_url', image_url: { url: 'u1', detail: 'high' } },
          { type: 'image_url', image_url: { url: 'u2' } },
        ],
      },
    ])
  })

  it('没有正文且没有文本附件时只发图片 part，不带 detail', () => {
    expect(toOpenAiMessages('sys', [{ role: 'user', content: '' }], [[image('u1')]])).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'u1' } }] },
    ])
  })

  it('附件按 user 消息顺序对应，assistant 与 reminder 不占用下标', () => {
    expect(
      toOpenAiMessages(
        'sys',
        [
          { role: 'user', content: '第一问' },
          { role: 'latest_reminder', content: '提醒' },
          { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
          { role: 'user', content: '第二问' },
        ],
        [[image('u1')], [image('u2')]]
      )
    ).toEqual([
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '第一问' },
          { type: 'image_url', image_url: { url: 'u1' } },
        ],
      },
      { role: 'system', content: '提醒' },
      { role: 'assistant', content: '回答' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '第二问' },
          { type: 'image_url', image_url: { url: 'u2' } },
        ],
      },
    ])
  })

  it('prefixText 作为末尾 assistant 续写前缀', () => {
    expect(
      toOpenAiMessages('sys', [{ role: 'user', content: '问' }], [], { prefixText: '已写的一半' })
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '问' },
      { role: 'assistant', content: '已写的一半' },
    ])
  })

  it('空白 prefixText 不追加续写消息', () => {
    expect(
      toOpenAiMessages('sys', [{ role: 'user', content: '问' }], [], { prefixText: '   ' })
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '问' },
    ])
  })

  it('只有 file block 而没有内联附件的 user 消息被跳过', () => {
    expect(
      toOpenAiMessages(
        'sys',
        [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'f1' } }] }],
        []
      )
    ).toEqual([{ role: 'system', content: 'sys' }])
  })

  it('文本附件的 source 标记不影响内联结果', () => {
    expect(
      toOpenAiMessages('sys', [{ role: 'user', content: '问' }], [
        [textAttachment('ocr.txt', '识别结果', 'ocr')],
      ])
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '问\n\n<file name="ocr.txt">\n识别结果\n</file>' },
    ])
  })
})
