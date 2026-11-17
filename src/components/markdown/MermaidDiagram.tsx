import { useTranslate } from '../../i18n/index.js'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTheme } from '../../app/theme.js'
import { renderMermaid } from '../../services/markdown/mermaid.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import {
  IconDownloadOutline16,
  IconZoomInOutline16,
  IconZoomOutOutline16,
} from '../base/icons.js'

const ZOOM_STEP = 0.25
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3

/** 触发浏览器下载 */
const saveBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noreferrer'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** 流式绘制最新内容、保留上次有效图；回答结束后才显示渲染错误。 */
export const MermaidDiagram = memo(function MermaidDiagram({
  code,
  loading,
}: {
  code: string
  loading: boolean
}) {
  const t = useTranslate()
  const dark = useTheme() === 'dark'
  const [result, setResult] = useState({ svg: '', failedCode: null as string | null })
  const [scale, setScale] = useState(1)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const latestCodeRef = useRef(code)
  latestCodeRef.current = code
  // 流式阶段从 ref 取最新文本，避免每个片段都取消绘制；结束后立即绘制完整内容。
  const finalCode = loading ? null : code

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let previousCode: string | undefined
    let displayedCode: string | undefined

    const draw = async (input: string) => {
      if (input === displayedCode || cancelled) {
        return
      }
      const svg = await renderMermaid(input, dark, () => cancelled)
      if (svg && !cancelled) {
        displayedCode = input
        setResult({ svg, failedCode: null })
      }
    }

    const renderLatest = async () => {
      const input = latestCodeRef.current
      if (input !== previousCode) {
        previousCode = input
        try {
          await draw(input)
        } catch {
          if (!cancelled) {
            if (loading) {
              // 流式片段的末行可能包含未完成的节点，仅绘制前面的完整行。
              const text = input.trimEnd()
              const lineEnd = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'))
              const prefix = text.slice(0, Math.max(0, lineEnd))
              // 已显示的内容覆盖当前前缀时保持图形。
              if (prefix && !displayedCode?.startsWith(prefix)) {
                try {
                  await draw(prefix)
                } catch {
                  // 前缀也可能尚未构成完整语法，保留已有图。
                }
              }
            } else {
              setResult({ svg: '', failedCode: input })
            }
          }
        }
      }
      // 当前帧结束后绘制最新片段，连续输入合并为一次绘制。
      if (!cancelled && loading) {
        timer = setTimeout(renderLatest, 100)
      }
    }

    void renderLatest()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [dark, loading, finalCode])

  // 换图后回到 100%
  useEffect(() => {
    setScale(1)
  }, [result.svg])

  const getSvg = useCallback(() => canvasRef.current?.querySelector('svg') ?? null, [])

  /** 导出用的 SVG 文本：写死当前显示尺寸，避免查看器按 100% 缩放 */
  const serializeSvg = useCallback(() => {
    const svg = getSvg()
    if (!svg) {
      return null
    }
    const clone = svg.cloneNode(true) as SVGElement
    const rect = svg.getBoundingClientRect()
    clone.setAttribute('width', String(Math.max(1, Math.round(rect.width))))
    clone.setAttribute('height', String(Math.max(1, Math.round(rect.height))))
    if (!clone.getAttribute('xmlns')) {
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    }
    return new XMLSerializer().serializeToString(clone)
  }, [getSvg])

  const downloadSvg = useCallback(() => {
    const markup = serializeSvg()
    if (markup) {
      saveBlob(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), 'diagram.svg')
    }
  }, [serializeSvg])

  const downloadPng = useCallback(async () => {
    const svg = getSvg()
    const markup = serializeSvg()
    if (!svg || !markup) {
      return
    }
    const rect = svg.getBoundingClientRect()
    const ratio = 2
    const width = Math.max(1, Math.round(rect.width * ratio))
    const height = Math.max(1, Math.round(rect.height * ratio))
    const image = new Image()
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('svg load failed'))
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
    })
    try {
      await loaded
    } catch {
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      return
    }
    // 深色主题下导出仍用当前页面底色，避免透明底变成黑块
    const background = getComputedStyle(canvasRef.current ?? document.body).backgroundColor
    if (background && background !== 'rgba(0, 0, 0, 0)') {
      context.fillStyle = background
      context.fillRect(0, 0, width, height)
    }
    context.drawImage(image, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (blob) {
      saveBlob(blob, 'diagram.png')
    }
  }, [getSvg, serializeSvg])

  const downloadCode = useCallback(() => {
    saveBlob(new Blob([code], { type: 'text/plain;charset=utf-8' }), 'diagram.mmd')
  }, [code])

  if (!code.trim() || !result.svg) {
    return (
      <div className="md-mermaid-status" role="status">
        {!loading && !code.trim()
          ? t('mermaidEmpty')
          : !loading && result.failedCode === code
            ? t('mermaidRenderFail')
            : t('mermaidLoading')}
      </div>
    )
  }

  return (
    <div className="md-mermaid-host">
      <div className="md-mermaid-diagram">
        <div
          ref={canvasRef}
          className="md-mermaid-canvas"
          style={{ zoom: scale } as React.CSSProperties}
          dangerouslySetInnerHTML={{ __html: result.svg }}
        />
      </div>
      <div className="md-mermaid-toolbar">
        <IconButton
          icon={<IconZoomOutOutline16 />}
          tooltip={t('mermaidZoomOut')}
          tooltipPlacement="bottom"
          disabled={scale <= ZOOM_MIN + 1e-6}
          onClick={() => setScale((value) => Math.max(ZOOM_MIN, +(value - ZOOM_STEP).toFixed(2)))}
        />
        <span className="md-mermaid-scale" aria-live="polite">
          {Math.round(scale * 100)}%
        </span>
        <IconButton
          icon={<IconZoomInOutline16 />}
          tooltip={t('mermaidZoomIn')}
          tooltipPlacement="bottom"
          disabled={scale >= ZOOM_MAX - 1e-6}
          onClick={() => setScale((value) => Math.min(ZOOM_MAX, +(value + ZOOM_STEP).toFixed(2)))}
        />
        <Menu
          options={[
            {
              key: 'png',
              label: t('mermaidDownloadPng'),
              icon: <IconDownloadOutline16 />,
              onSelect: () => void downloadPng(),
            },
            {
              key: 'svg',
              label: t('mermaidDownloadSvg'),
              icon: <IconDownloadOutline16 />,
              onSelect: downloadSvg,
            },
            {
              key: 'code',
              label: t('mermaidDownloadCode'),
              icon: <IconDownloadOutline16 />,
              onSelect: downloadCode,
            },
          ]}
        >
          {({ toggle }) => (
            <IconButton
              icon={<IconDownloadOutline16 />}
              tooltip={t('mermaidDownload')}
              tooltipPlacement="bottom"
              onClick={toggle}
            />
          )}
        </Menu>
      </div>
    </div>
  )
})
