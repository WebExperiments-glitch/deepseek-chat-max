import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  addManualMemory,
  memoryViews,
  removeMemory,
  restoreMemory,
  toggleMemoryPin,
  useMemories,
} from '../../services/memory/store.js'
import { setMemoryEnabled, useSettings } from '../../services/settings.js'
import type { MemoryKind } from '../../services/memory/types.js'
import { Button } from '../base/Button.js'
import styles from './MemoryPanel.module.css'

const KIND_LABEL: Record<MemoryKind, TranslationKey> = {
  fact: 'memoryKindFact',
  preference: 'memoryKindPreference',
  persona: 'memoryKindPersona',
  event: 'memoryKindEvent',
  summary: 'memoryKindSummary',
}

const STATE_LABEL: Record<'active' | 'fading' | 'forgotten', TranslationKey> = {
  active: 'memoryStateActive',
  fading: 'memoryStateFading',
  forgotten: 'memoryStateForgotten',
}

/**
 * 长期记忆面板：开关、手动新增、按遗忘曲线排序的记忆列表。
 * 记忆是全局的，切换会话后仍然生效；所有数据只在本机。
 */
export const MemoryPanel = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.memoryEnabled)
  const entries = useMemories((state) => state.entries)
  const extracting = useMemories((state) => Object.values(state.extracting).some(Boolean))
  const [draft, setDraft] = useState('')
  // 面板打开时按当前时间算一次强度；每次操作后由 store 更新触发重算
  const views = memoryViews(entries, Date.now())

  const add = async () => {
    if (await addManualMemory(draft)) {
      setDraft('')
    }
  }

  return (
    <div className={styles.panel}>
      <label className={styles.toggleRow}>
        <span className={styles.toggleText}>
          <span className={styles.toggleLabel}>{t('memoryEnabled')}</span>
          <span className={styles.toggleDescription}>{t('memoryEnabledDescription')}</span>
        </span>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={enabled}
          aria-label={t('memoryEnabled')}
          onChange={(event) => setMemoryEnabled(event.target.checked)}
        />
      </label>

      <div className={styles.addRow}>
        <input
          className={styles.input}
          value={draft}
          placeholder={t('memoryAddPlaceholder')}
          disabled={!enabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void add()
            }
          }}
        />
        <Button
          variant="outlined"
          size="s"
          disabled={!enabled || draft.trim() === ''}
          onClick={() => void add()}
        >
          {t('memoryAdd')}
        </Button>
      </div>

      <p className={styles.hint}>
        {t('memoryCount', { count: views.length })}
        {extracting ? ` · ${t('memoryExtracting')}` : null}
      </p>

      {views.length === 0 ? (
        <p className={styles.empty}>{t('memoryEmpty')}</p>
      ) : (
        <ul className={styles.list}>
          {views.map(({ entry, retention, state }) => (
            <li key={entry.id} className={styles.item} data-state={state}>
              <div className={styles.itemHead}>
                <span className={styles.kind}>{t(KIND_LABEL[entry.kind])}</span>
                <span className={styles.strength}>
                  {t('memoryRetention', { percent: Math.round(retention * 100) })}
                  <span className={styles.state}>· {t(STATE_LABEL[state])}</span>
                </span>
              </div>
              <p className={styles.text}>{entry.text}</p>
              <div className={styles.actions}>
                <button type="button" className={styles.action} onClick={() => void toggleMemoryPin(entry.id)}>
                  {entry.pinned ? t('memoryUnpin') : t('memoryPin')}
                </button>
                {state === 'forgotten' ? (
                  <button type="button" className={styles.action} onClick={() => void restoreMemory(entry.id)}>
                    {t('memoryRestore')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => void removeMemory(entry.id)}
                >
                  {t('memoryDelete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
