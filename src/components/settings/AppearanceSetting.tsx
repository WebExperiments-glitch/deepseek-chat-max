import { useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  resetAppearance,
  setAppearanceColor,
  setAssistantAvatar,
  setUserAvatar,
  useSettings,
  type AppearanceColors,
} from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './AppearanceSetting.module.css'

const MAX_AVATAR_BYTES = 200 * 1024

const isHex = (value: string) => /^#[0-9a-f]{6}$/i.test(value)

const AvatarRow = ({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className={styles.avatarRow}>
      <span className={styles.avatarPreview}>
        {value ? <img src={value} alt="" /> : <span>{label.slice(0, 1)}</span>}
      </span>
      <span className={styles.avatarLabel}>{label}</span>
      <Button variant="outlined" size="s" onClick={() => inputRef.current?.click()}>
        {t('uploadAvatar')}
      </Button>
      {value ? (
        <Button variant="outlined" size="s" onClick={() => onChange('')}>
          {t('clearAvatar')}
        </Button>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) {
            return
          }
          if (file.size > MAX_AVATAR_BYTES) {
            showToast({ key: 'avatarTooLarge', type: 'error' })
            return
          }
          const reader = new FileReader()
          reader.onload = () => {
            if (typeof reader.result === 'string') {
              onChange(reader.result)
            }
          }
          reader.readAsDataURL(file)
        }}
      />
    </div>
  )
}

const ColorField = ({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}) => (
  <label className={styles.colorField}>
    <span>{label}</span>
    <span className={styles.colorInputs}>
      <input
        type="color"
        value={isHex(value) ? value : '#ffffff'}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
  </label>
)

/** 外观：头像、明暗独立的气泡与背景配色 */
export const AppearanceSetting = () => {
  const t = useTranslate()
  const userAvatar = useSettings((state) => state.userAvatar)
  const assistantAvatar = useSettings((state) => state.assistantAvatar)
  const appearance = useSettings((state) => state.appearance)
  const [preview, setPreview] = useState<'light' | 'dark'>('light')

  const colors = appearance[preview]
  const setColor = (key: keyof AppearanceColors, value: string) =>
    setAppearanceColor(preview, key, value)

  /** 一键暖灰风格：明暗主题同时生效（不影响思维链展示） */
  const applyWarmStyle = () => {
    setAppearanceColor('light', 'userBubble', '#f0eee6')
    setAppearanceColor('light', 'assistantBubble', '')
    setAppearanceColor('light', 'chatBackground', '#faf9f5')
    setAppearanceColor('dark', 'userBubble', '#2b2a27')
    setAppearanceColor('dark', 'assistantBubble', '')
    setAppearanceColor('dark', 'chatBackground', '#1f1e1b')
  }

  return (
    <div className={styles.block}>
      <div className={styles.title}>{t('appearanceTitle')}</div>
      <p className={styles.description}>{t('appearanceDescription')}</p>

      <div className={styles.avatars}>
        <AvatarRow label={t('userAvatar')} value={userAvatar} onChange={setUserAvatar} />
        <AvatarRow
          label={t('assistantAvatar')}
          value={assistantAvatar}
          onChange={setAssistantAvatar}
        />
      </div>

      <div className={styles.themeTabs} role="tablist" aria-label={t('appearanceColors')}>
        <button
          type="button"
          role="tab"
          aria-selected={preview === 'light'}
          className={preview === 'light' ? styles.tabActive : styles.tab}
          onClick={() => setPreview('light')}
        >
          {t('lightTheme')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={preview === 'dark'}
          className={preview === 'dark' ? styles.tabActive : styles.tab}
          onClick={() => setPreview('dark')}
        >
          {t('darkTheme')}
        </button>
        <Button
          variant="outlined"
          size="s"
          className={styles.styleButton}
          onClick={applyWarmStyle}
        >
          {t('warmStyle')}
        </Button>
        <Button
          variant="outlined"
          size="s"
          className={styles.resetButton}
          onClick={() => resetAppearance(preview)}
        >
          {t('resetAppearance')}
        </Button>
      </div>

      <div className={styles.colors}>
        <ColorField
          label={t('userBubbleColor')}
          value={colors.userBubble}
          placeholder="#f3f5f9"
          onChange={(value) => setColor('userBubble', value)}
        />
        <ColorField
          label={t('assistantBubbleColor')}
          value={colors.assistantBubble}
          placeholder="transparent"
          onChange={(value) => setColor('assistantBubble', value)}
        />
        <ColorField
          label={t('chatBackground')}
          value={colors.chatBackground}
          placeholder="linear-gradient(...) / url(...)"
          onChange={(value) => setColor('chatBackground', value)}
        />
      </div>
    </div>
  )
}
