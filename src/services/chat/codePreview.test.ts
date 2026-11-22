import { describe, expect, it } from 'vitest'
import {
  withCharset,
  injectReadyProbe,
  buildPreviewDocument,
  isRunnableCode,
  PREVIEW_READY_TIMEOUT,
} from './codePreview.js'

describe('withCharset', () => {
  it('已有 charset 时原样返回', () => {
    const html = '<html><head><meta charset="utf-8"></head></html>'
    expect(withCharset(html)).toBe(html)
  })

  it('大小写不敏感地识别 charset', () => {
    const html = '<html><head><META CHARSET="UTF-8"></head></html>'
    expect(withCharset(html)).toBe(html)
  })

  it('插到 head 标签之后', () => {
    expect(withCharset('<html><head><title>x</title></head></html>')).toBe(
      '<html><head><meta charset="UTF-8"><title>x</title></head></html>'
    )
  })

  it('没有 head 时插入一个 head', () => {
    expect(withCharset('<html><body>x</body></html>')).toBe(
      '<html><head><meta charset="UTF-8"></head><body>x</body></html>'
    )
  })

  it('doctype 之后插入', () => {
    expect(withCharset('<!DOCTYPE html><body>x</body>')).toBe(
      '<!DOCTYPE html><meta charset="UTF-8"><body>x</body>'
    )
  })

  it('xml 之后插入', () => {
    expect(withCharset('<?xml version="1.0"?><body>x</body>')).toBe(
      '<?xml version="1.0"?><meta charset="UTF-8"><body>x</body>'
    )
  })

  it('什么标记都没有时前置', () => {
    expect(withCharset('<body>x</body>')).toBe('<meta charset="UTF-8"><body>x</body>')
  })
})

describe('injectReadyProbe', () => {
  it('插到 </body> 之前', () => {
    const out = injectReadyProbe('<html><body>hi</body></html>')
    expect(out).toContain('postMessage({previewContentReady:true}')
    expect(out.indexOf('previewContentReady')).toBeLessThan(out.indexOf('</body>'))
  })

  it('没有 </body> 时追加到末尾', () => {
    const out = injectReadyProbe('<div>hi</div>')
    expect(out.endsWith('<script>window.parent.postMessage')).toBe(false) // 前面还有 style
    expect(out).toContain('previewContentReady')
    expect(out.indexOf('<div>')).toBeLessThan(out.indexOf('previewContentReady'))
  })
})

describe('buildPreviewDocument', () => {
  it('同时保证 charset 与就绪探针', () => {
    const doc = buildPreviewDocument('<html><body><h1>星云</h1></body></html>')
    expect(doc).toContain('<meta charset="UTF-8">')
    expect(doc).toContain('previewContentReady')
    expect(doc).toContain('<h1>星云</h1>')
  })
})

describe('isRunnableCode', () => {
  it('html/htm 可运行', () => {
    expect(isRunnableCode('html')).toBe(true)
    expect(isRunnableCode('HTML')).toBe(true)
    expect(isRunnableCode(' htm ')).toBe(true)
  })

  it('带 meta 的 html 仍可运行', () => {
    expect(isRunnableCode('html title=index.html')).toBe(true)
  })

  it('其它语言不可运行', () => {
    expect(isRunnableCode('javascript')).toBe(false)
    expect(isRunnableCode('css')).toBe(false)
    expect(isRunnableCode('')).toBe(false)
  })
})

describe('常量', () => {
  it('就绪超时与官网一致为 12 秒', () => {
    expect(PREVIEW_READY_TIMEOUT).toBe(12_000)
  })
})
