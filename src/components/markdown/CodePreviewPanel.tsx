import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { closePreviewPanel, usePreviewPanel } from './previewPanelState.js'
import { CodePreview } from './CodePreview.js'
import styles from './CodePreviewPanel.module.css'

/** 右侧「代码预览」面板：与搜索面板并列，iframe 沙箱运行 HTML 代码块 */
export const CodePreviewPanel = () => {
  const t = useTranslate()
  const key = usePreviewPanel((state) => state.key)
  const code = usePreviewPanel((state) => state.code)
  const language = usePreviewPanel((state) => state.language)
  const [ready, setReady] = useState<'loading' | 'ready' | 'failed'>('loading')
  if (!key) {
    return null
  }
  return (
    <aside className={styles.panel}>
      <div className={styles.header}>
        <div role="heading" className={styles.title}>
          <span>{t('previewTitle')}</span>
          <span className={styles.meta}>
            {language} ·{' '}
            {t(ready === 'ready' ? 'previewReady' : ready === 'failed' ? 'previewFailed' : 'previewLoading')}
          </span>
        </div>
        <IconButton
          icon={<IconCloseOutline16 />}
          aria-label={t('close')}
          onClick={closePreviewPanel}
        />
      </div>
      <CodePreview code={code} onReadyChange={setReady} />
    </aside>
  )
}
