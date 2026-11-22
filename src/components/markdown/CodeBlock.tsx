import { useTranslate } from '../../i18n/index.js'
import { memo, useEffect, useMemo, useReducer, useState } from 'react'
import Prism from 'prismjs'
import {
  getHighlightLang,
  isHighlightLoaded,
  loadHighlight,
} from '../../services/markdown/highlight.js'
import { useSettings } from '../../services/settings.js'
import {
  IconCheckOutline16,
  IconCopyOutline16,
  IconRun16,
  IconStopFill16,
} from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { copyText } from '../../utils/clipboard.js'
import { isRunnableCode } from '../../services/chat/codePreview.js'
import { MermaidDiagram } from './MermaidDiagram.js'
import { togglePreviewPanel, usePreviewPanel } from './previewPanelState.js'
import styles from './CodeBlock.module.css'

/** 从 meta 解析高亮行：```ts {1,4-6} */
const parseHighlightLines = (meta: string): Set<number> => {
  const lines = new Set<number>()
  const match = /\{([\d,\-\s]+)\}/.exec(meta)
  if (!match) {
    return lines
  }
  for (const part of match[1].split(',')) {
    const [startRaw, endRaw] = part.trim().split('-')
    const start = Number(startRaw)
    const end = endRaw === undefined ? start : Number(endRaw)
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      continue
    }
    for (let line = Math.max(1, start); line <= Math.min(end, 10000); line += 1) {
      lines.add(line)
    }
  }
  return lines
}

/**
 * 按行包一层 span，用于 meta 指定行高亮。
 * 跨行的 token 会在换行处先闭合、下一行再打开，保证 HTML 结构合法。
 */
const withLineWrappers = (html: string, highlighted: Set<number>): string => {
  const parts: string[] = []
  let buffer = ''
  let line = 1
  let open: Array<{ name: string; tag: string }> = []
  const flush = () => {
    const cls = highlighted.has(line)
      ? ' class="md-code-line md-code-line-active"'
      : ' class="md-code-line"'
    parts.push(
      `<span${cls}>${buffer}${open.map(() => '</span>').join('')}</span>${open
        .map((item) => item.tag)
        .join('')}`
    )
    buffer = ''
    line += 1
  }
  for (const token of html.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (token.startsWith('<')) {
      if (token.startsWith('</')) {
        const name = token.slice(2).split(/[\s>]/)[0]
        const index = open.map((item) => item.name).lastIndexOf(name)
        if (index >= 0) {
          open = open.filter((_, tagIndex) => tagIndex !== index)
        }
        buffer += token
      } else if (token.endsWith('/>')) {
        buffer += token
      } else {
        open.push({ name: token.slice(1).split(/[\s>]/)[0], tag: token })
        buffer += token
      }
      continue
    }
    const segments = token.split('\n')
    segments.forEach((segment, index) => {
      buffer += segment
      if (index < segments.length - 1) {
        flush()
      }
    })
  }
  if (buffer !== '' || open.length > 0) {
    flush()
  }
  return parts.join('')
}

/** 代码块标题栏：左侧语言名，右侧展开/收起与复制 */
const CodeInfoRow = ({
  code,
  infostring,
  filename,
  showDiagram,
  onToggleDiagram,
  collapsible = false,
  expanded = false,
  onToggleExpand,
  runnable = false,
  running = false,
  onToggleRun,
}: {
  code: string
  infostring: string
  filename?: string
  showDiagram: boolean
  onToggleDiagram?: () => void
  collapsible?: boolean
  expanded?: boolean
  onToggleExpand?: () => void
  runnable?: boolean
  running?: boolean
  onToggleRun?: () => void
}) => {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  return (
    <div className={styles.container}>
      {onToggleDiagram ? (
        <div className="md-code-block-switch" aria-label={t('mermaidSwitchLabel')}>
          <button
            type="button"
            className={styles.button}
            aria-pressed={showDiagram}
            onClick={() => !showDiagram && onToggleDiagram()}
          >
            {t('mermaidDiagram')}
          </button>
          <button
            type="button"
            className={styles.button}
            aria-pressed={!showDiagram}
            onClick={() => showDiagram && onToggleDiagram()}
          >
            {t('mermaidCode')}
          </button>
        </div>
      ) : (
        <span className={styles.name}>
          {filename ? `${filename} · ${infostring}` : infostring}
        </span>
      )}
      <div className={styles.actions}>
        {runnable && onToggleRun ? (
          <button type="button" className={styles.button} onClick={onToggleRun}>
            {running ? <IconStopFill16 /> : <IconRun16 />}
            <span>{t(running ? 'previewStop' : 'previewRun')}</span>
          </button>
        ) : null}
        {collapsible ? (
          <button type="button" className={styles.button} onClick={onToggleExpand}>
            {t(expanded ? 'collapseCode' : 'expandCode')}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.button}
          onClick={async () => {
            if (!(await copyText(code))) {
              showToast({ key: 'copyFailed' })
              return
            }
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
          <span>{t(copied ? 'copied' : 'copy')}</span>
        </button>
      </div>
    </div>
  )
}

/** 代码块：语言包按需加载，不支持或尚未加载的语言按纯文本显示 */
export const CodeBlock = memo(function CodeBlock({
  code,
  infostring,
  meta = '',
  loading = false,
}: {
  code: string
  infostring: string
  meta?: string
  loading?: boolean
}) {
  const isMermaid = infostring.toLowerCase() === 'mermaid'
  const [showDiagram, setShowDiagram] = useState(true)
  const runnable = !loading && isRunnableCode(infostring)
  // 运行按钮打开全局右侧面板；同一代码块再次点击收起
  const previewKey = usePreviewPanel((state) => state.key)
  const panelKey = `code:${code.length}:${code.slice(0, 80)}`
  const running = previewKey === panelKey
  const codeCollapse = useSettings((state) => state.codeCollapse)
  const codeWrap = useSettings((state) => state.codeWrap)
  const [expanded, setExpanded] = useState(false)
  const lineCount = code.split('\n').length
  // 只折叠已经生成完的长代码块；流式期间保持完整展示
  const collapsible = codeCollapse && !loading && !isMermaid && lineCount > 18
  const clipped = collapsible && !expanded
  const filename =
    /(?:title|file|filename)=["']([^"']+)["']/.exec(meta)?.[1] ?? ''
  // 自动换行时行号与视觉行对不上，直接隐藏
  const showLineNumbers = !codeWrap && lineCount > 2
  // 语言包注册在全局 Prism 上，每次渲染直接判断；加载完成后触发一次重渲染
  const rerender = useReducer((n: number) => n + 1, 0)[1]
  const lang = getHighlightLang(infostring)
  const loaded = lang !== null && isHighlightLoaded(lang)
  useEffect(() => {
    if (lang === null || loaded) {
      return
    }
    let unmounted = false
    loadHighlight(lang).then(() => {
      if (!unmounted) {
        rerender()
      }
    })
    return () => {
      unmounted = true
    }
  }, [lang, loaded, rerender])
  const renderedHtml = useMemo(() => {
    const name = lang !== null && loaded ? lang : 'plaintext'
    const html = Prism.highlight(code, Prism.languages[name], name)
    const highlight = parseHighlightLines(meta)
    return highlight.size > 0 ? withLineWrappers(html, highlight) : html
  }, [code, lang, loaded, meta])
  return (
    <div className="md-code-block">
      <div className="md-code-block-banner">
        <CodeInfoRow
          code={code}
          infostring={infostring}
          filename={filename}
          showDiagram={showDiagram}
          onToggleDiagram={isMermaid ? () => setShowDiagram((show) => !show) : undefined}
          collapsible={collapsible}
          expanded={expanded}
          onToggleExpand={() => setExpanded((value) => !value)}
          runnable={runnable}
          running={running}
          onToggleRun={runnable ? () => togglePreviewPanel(panelKey, code, infostring) : undefined}
        />
      </div>
      {isMermaid && showDiagram ? (
        <MermaidDiagram code={code} loading={loading} />
      ) : (
        <div className={styles.preWrapper}>
          <div className={clipped ? `${styles.codeRow} ${styles.clipped}` : styles.codeRow}>
            {showLineNumbers ? (
              <div className={styles.lineNumbers} aria-hidden>
                {Array.from({ length: lineCount }, (_, index) => (
                  <span key={index}>{index + 1}</span>
                ))}
              </div>
            ) : null}
            <pre dangerouslySetInnerHTML={{ __html: renderedHtml }}></pre>
          </div>
          {clipped ? <div className={styles.fade} aria-hidden /> : null}
        </div>
      )}
    </div>
  )
})
