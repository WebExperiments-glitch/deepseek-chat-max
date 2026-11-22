/**
 * 代码块实时预览运行器。
 *
 * 逐行重写自 chat.deepseek.com 官网 bundle 的 webpack module 85913
 * （REA 解码 + Craft Anything 重写的产物见
 *  _research/web-full/deepseek/preview-module-85913-readable.js）。
 *
 * 核心机制（与官网一致）：
 * - 单例 iframe，sandbox 只开 allow-scripts + allow-pointer-lock，允许 fullscreen；
 * - 注入 UTF-8 meta 与 postMessage 就绪探针，保证文档结构合法；
 * - Android / 无 createObjectURL 用 srcdoc，否则用 blob: URL；
 * - message + load 判断就绪，12 秒超时兜底，revokeObjectURL 释放。
 *
 * 安全边界：iframe 沙箱**不开放 allow-same-origin**，也**不开 allow-top-navigation**，
 * 因此运行的代码不能访问父页面 DOM、localStorage、Cookie，也不能跳转顶层页面。
 * 这是官网同款边界，纯前端隔离，不执行任何 Node/系统能力。
 */
import { platform } from '../../ports/platform.js'

const CHARSET_META = '<meta charset="UTF-8">'
const RE_CHARSET = /<meta\b[^>]*\bcharset\s*=/i
const RE_HEAD = /<head(?:\s[^>]*)?>/i
const RE_HTML = /<html(?:\s[^>]*)?>/i
const RE_DOCTYPE = /^\s*<!doctype[^>]*>/i
const RE_XML = /^\s*<\?xml[^>]*\?>/i

const READY_PROBE =
  '<style>body{margin:0}</style><script>window.parent.postMessage({previewContentReady:true},"*")</script>'

/** 就绪判定超时（毫秒），与官网 12s 一致 */
export const PREVIEW_READY_TIMEOUT = 12_000

/** 定点插入字符串 */
const insertAt = (text: string, index: number, part: string): string =>
  text.slice(0, index) + part + text.slice(index)

/**
 * 保证文档有 UTF-8 charset，按 doctype → xml → html → head 的优先级定点插入，
 * 避免破坏文档结构（与官网 withCharset 一致）。
 */
export const withCharset = (html: string): string => {
  if (RE_CHARSET.test(html)) {
    return html
  }
  const head = html.match(RE_HEAD)
  if (head?.index != null) {
    return insertAt(html, head.index + head[0].length, CHARSET_META)
  }
  const doc = html.match(RE_HTML)
  if (doc?.index != null) {
    return insertAt(html, doc.index + doc[0].length, `<head>${CHARSET_META}</head>`)
  }
  const doctype = html.match(RE_DOCTYPE)
  if (doctype?.index != null) {
    return insertAt(html, doctype.index + doctype[0].length, CHARSET_META)
  }
  const xml = html.match(RE_XML)
  if (xml?.index != null) {
    return insertAt(html, xml.index + xml[0].length, CHARSET_META)
  }
  return CHARSET_META + html
}

/** 把就绪探针注入到 </body> 前；没有 </body> 就追加到末尾 */
export const injectReadyProbe = (html: string): string => {
  const bodyEnd = html.lastIndexOf('</body>')
  return bodyEnd !== -1
    ? html.slice(0, bodyEnd) + READY_PROBE + html.slice(bodyEnd)
    : html + READY_PROBE
}

/** 组装最终要加载进 iframe 的 HTML */
export const buildPreviewDocument = (code: string): string => injectReadyProbe(withCharset(code))

/**
 * 运行器：持有 iframe、blob URL、就绪 promise 与清理函数。
 * 用法：createPreviewRunner() → runner.render(iframe, code) → runner.dispose()
 */
export const createPreviewRunner = () => {
  let blobUrl: string | null = null
  let cleanup: (() => void) | null = null
  let resolveReady: (() => void) | null = null
  let readyTimer: ReturnType<typeof setTimeout> | null = null

  const settleReady = () => {
    if (resolveReady) {
      const resolve = resolveReady
      resolveReady = null
      if (readyTimer !== null) {
        clearTimeout(readyTimer)
        readyTimer = null
      }
      resolve()
    }
  }

  const releaseBlob = () => {
    if (blobUrl) {
      platform().revokeObjectURL(blobUrl)
      blobUrl = null
    }
  }

  /** 重置：兑现 promise、清理监听、释放 blob，iframe 回到隐藏 about:blank */
  const reset = (iframe: HTMLIFrameElement) => {
    settleReady()
    cleanup?.()
    cleanup = null
    releaseBlob()
    iframe.style.cssText = 'display: none; pointer-events: none'
    iframe.removeAttribute('srcdoc')
    iframe.src = 'about:blank'
  }

  /**
   * 把代码渲染进 iframe，返回「内容就绪」promise。
   * sandbox 每次都重新设置，保证即使外部改动过 iframe 也不会获得额外权限。
   */
  const render = (iframe: HTMLIFrameElement, code: string): Promise<void> => {
    settleReady()
    cleanup?.()
    cleanup = null
    releaseBlob()

    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-pointer-lock'
    )
    iframe.setAttribute('allow', 'fullscreen')

    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
      readyTimer = setTimeout(settleReady, PREVIEW_READY_TIMEOUT)
    })

    const html = buildPreviewDocument(code)
    const onMessage = (event: MessageEvent) => {
      if (
        event.source === iframe.contentWindow &&
        (event.data as { previewContentReady?: boolean } | null)?.previewContentReady
      ) {
        settleReady()
        doCleanup()
      }
    }
    const onLoad = () => {
      settleReady()
      doCleanup()
    }
    let offMessage: () => void = () => {}
    const doCleanup = () => {
      offMessage()
      iframe.removeEventListener('load', onLoad)
      if (cleanup === doCleanup) {
        cleanup = null
      }
    }

    offMessage = platform().onWindowMessage(onMessage)
    iframe.addEventListener('load', onLoad)
    cleanup = doCleanup

    const useSrcDoc =
      /\bAndroid\b/i.test(platform().userAgent()) || !platform().canCreateObjectURL()
    if (useSrcDoc) {
      iframe.removeAttribute('src')
      iframe.srcdoc = html
    } else {
      iframe.removeAttribute('srcdoc')
      blobUrl = platform().createObjectURL(new Blob([html], { type: 'text/html' }))
      iframe.src = blobUrl
    }
    return ready
  }

  /** 卸载：清理全部资源 */
  const dispose = (iframe: HTMLIFrameElement | null) => {
    settleReady()
    cleanup?.()
    cleanup = null
    releaseBlob()
    if (iframe) {
      iframe.removeAttribute('srcdoc')
      iframe.src = 'about:blank'
    }
  }

  return { render, reset, dispose }
}

export type PreviewRunner = ReturnType<typeof createPreviewRunner>

/** 是否是可运行预览的代码语言（官网只对 html 提供运行） */
export const isRunnableCode = (infostring: string): boolean => {
  const lang = infostring.trim().toLowerCase().split(/\s+/)[0]
  return lang === 'html' || lang === 'htm'
}
