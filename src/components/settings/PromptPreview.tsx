import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { OFFICIAL_SYSTEM_PROMPT } from '../../services/chat/systemPrompt.js'
import {
  getActivePreset,
  getActivePresetPrompt,
  usePresets,
} from '../../services/presets.js'
import { useSettings } from '../../services/settings.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import styles from './PromptPreview.module.css'

/**
 * 提示词实验室：把「这次请求真正会发送的系统提示词」展开给用户看。
 * 只读取本地状态，不发请求、不消耗 token。
 */
export const PromptPreview = () => {
  const t = useTranslate()
  // 订阅变化，切换预设或改自定义提示词后预览同步刷新
  usePresets((state) => state.activeId)
  usePresets((state) => state.presets)
  const customSystemPrompt = useSettings((state) => state.customSystemPrompt)
  const [open, setOpen] = useState(false)

  const preset = getActivePreset()
  const presetPrompt = getActivePresetPrompt()
  const prompt = presetPrompt ?? (customSystemPrompt.trim() || OFFICIAL_SYSTEM_PROMPT)
  const source = presetPrompt
    ? t('promptPreviewSourcePreset', { name: preset?.name ?? '' })
    : customSystemPrompt.trim()
      ? t('promptPreviewSourceCustom')
      : t('promptPreviewSourceOfficial')

  return (
    <div className={styles.block}>
      <button
        type="button"
        className={styles.summary}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={open ? styles.chevronOpen : styles.chevron}>
          <IconChevronRightOutline14 />
        </span>
        <span className={styles.summaryText}>{t('promptPreviewTitle')}</span>
        <span className={styles.source}>{source}</span>
        <span className={styles.count}>{t('promptPreviewCount', { count: prompt.length })}</span>
      </button>
      {open ? (
        <div className={styles.body}>
          <p className={styles.description}>{t('promptPreviewDescription')}</p>
          <pre className={styles.preview}>{prompt}</pre>
          <div className={styles.actions}>
            <Button
              variant="outlined"
              size="s"
              onClick={async () => {
                showToast({ key: (await copyText(prompt)) ? 'copied' : 'copyFailed' })
              }}
            >
              {t('copy')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
