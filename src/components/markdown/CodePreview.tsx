import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  createPreviewRunner,
  PREVIEW_READY_TIMEOUT,
  type PreviewRunner,
} from '../../services/chat/codePreview.js'
import styles from './CodePreview.module.css'

/**
 * HTML 代码块实时预览（iframe 沙箱运行）。
 * 运行器逻辑逐行重写自官网 module 85913，见 services/chat/codePreview.ts。
 *
 * onReadyChange 让外层面板显示「加载中/就绪/超时」状态。
 */
export const CodePreview = ({
  code,
  onReadyChange,
}: {
  code: string
  onReadyChange?: (state: 'loading' | 'ready' | 'failed') => void
}) => {
  const t = useTranslate()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const runnerRef = useRef<PreviewRunner | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

  const update = (next: 'loading' | 'ready' | 'failed') => {
    setState(next)
    onReadyChange?.(next)
  }

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) {
      return
    }
    const runner = createPreviewRunner()
    runnerRef.current = runner
    let cancelled = false
    const timeout = window.setTimeout(() => {
      if (!cancelled) {
        update('failed')
      }
    }, PREVIEW_READY_TIMEOUT + 500)
    runner.render(iframe, code).then(() => {
      window.clearTimeout(timeout)
      if (!cancelled) {
        update('ready')
      }
    })
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
      runner.dispose(iframe)
      runnerRef.current = null
    }
    // update 用 ref 稳定化，避免 effect 重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  return (
    <div className={styles.wrapper}>
      {state === 'failed' ? <div className={styles.failed}>{t('previewFailed')}</div> : null}
      <iframe ref={iframeRef} className={styles.frame} title={t('previewTitle')} />
    </div>
  )
}
