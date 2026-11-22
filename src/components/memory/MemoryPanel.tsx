import clsx from 'clsx'
import { useMemo, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  addManualMemory,
  clearAllMemory,
  consolidateMemories,
  exportMemories,
  importMemories,
  memoryViews,
  removeMemory,
  restoreMemory,
  toggleMemoryPin,
  updateMemoryText,
  useMemories,
} from '../../services/memory/store.js'
import {
  setMemoryReadEnabled,
  setMemoryWriteEnabled,
  useSettings,
} from '../../services/settings.js'
import type { MemoryKind, MemoryState } from '../../services/memory/types.js'
import { focusSessionMessage, useChatStore } from '../../services/chat/store.js'
import { closeSettings } from '../settings/settingsDialogState.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './MemoryPanel.module.css'

const KIND_LABEL: Record<MemoryKind, TranslationKey> = {
  goal: 'memoryKindGoal',
  fact: 'memoryKindFact',
  preference: 'memoryKindPreference',
  persona: 'memoryKindPersona',
  event: 'memoryKindEvent',
  summary: 'memoryKindSummary',
}

const STATE_LABEL: Record<MemoryState, TranslationKey> = {
  active: 'memoryStateActive',
  fading: 'memoryStateFading',
  forgotten: 'memoryStateForgotten',
}

const KINDS: MemoryKind[] = ['goal', 'fact', 'preference', 'persona', 'event', 'summary']

/**
 * 长期记忆面板：读写开关、统计、检索筛选、手动新增、整理去重、导入导出。
 * 记忆是全局的，切换会话后仍然生效；所有数据只在本机。
 */
export const MemoryPanel = () => {
  const t = useTranslate()
  const readEnabled = useSettings((state) => state.memoryReadEnabled)
  const writeEnabled = useSettings((state) => state.memoryWriteEnabled)
  const entries = useMemories((state) => state.entries)
  const extracting = useMemories((state) => Object.values(state.extracting).some(Boolean))
  const sessions = useChatStore((state) => state.sessions)
  const [draft, setDraft] = useState('')
  const [draftKind, setDraftKind] = useState<Exclude<MemoryKind, 'summary'>>('fact')
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | MemoryKind>('all')
  const [stateFilter, setStateFilter] = useState<'all' | MemoryState>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [clearPending, setClearPending] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const views = useMemo(() => memoryViews(entries, Date.now()), [entries])
  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return views.filter(({ entry, state }) => {
      if (kindFilter !== 'all' && entry.kind !== kindFilter) {
        return false
      }
      if (stateFilter !== 'all' && state !== stateFilter) {
        return false
      }
      if (!keyword) {
        return true
      }
      return (
        entry.text.toLowerCase().includes(keyword) ||
        entry.keywords.some((word) => word.toLowerCase().includes(keyword))
      )
    })
  }, [views, kindFilter, stateFilter, query])
  const stats = useMemo(() => {
    let active = 0
    let fading = 0
    let forgotten = 0
    for (const view of views) {
      if (view.state === 'active') {
        active += 1
      } else if (view.state === 'fading') {
        fading += 1
      } else {
        forgotten += 1
      }
    }
    return { total: views.length, active, fading, forgotten }
  }, [views])

  const add = async () => {
    if (await addManualMemory(draft, draftKind)) {
      setDraft('')
    }
  }

  const saveEdit = async () => {
    if (!editingId) {
      return
    }
    await updateMemoryText(editingId, editingText)
    setEditingId(null)
  }

  const merge = async () => {
    const removed = await consolidateMemories()
    showToast(
      removed > 0
        ? { key: 'memoryMerged', params: { count: removed } }
        : { key: 'memoryMergeNone' }
    )
  }

  const download = () => {
    const blob = new Blob([exportMemories()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'long-term-memory.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const upload = async (file: File) => {
    try {
      const count = await importMemories(await file.text())
      showToast({ key: 'memoryImported', params: { count } })
    } catch {
      showToast({ key: 'memoryImportFailed', type: 'error' })
    }
  }

  const jumpToSource = (sessionId: string, messageId: string) => {
    if (!sessionId) {
      return
    }
    focusSessionMessage(sessionId, messageId)
    closeSettings()
  }

  return (
    <div className={styles.panel}>
      <label className={styles.toggleRow}>
        <span className={styles.toggleText}>
          <span className={styles.toggleLabel}>{t('memoryReadEnabled')}</span>
          <span className={styles.toggleDescription}>{t('memoryReadEnabledDescription')}</span>
        </span>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={readEnabled}
          aria-label={t('memoryReadEnabled')}
          onChange={(event) => setMemoryReadEnabled(event.target.checked)}
        />
      </label>
      <label className={styles.toggleRow}>
        <span className={styles.toggleText}>
          <span className={styles.toggleLabel}>{t('memoryWriteEnabled')}</span>
          <span className={styles.toggleDescription}>{t('memoryWriteEnabledDescription')}</span>
        </span>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={writeEnabled}
          aria-label={t('memoryWriteEnabled')}
          onChange={(event) => setMemoryWriteEnabled(event.target.checked)}
        />
      </label>

      <div className={styles.stats}>
        <span>{t('memoryStatTotal', { count: stats.total })}</span>
        <span>{t('memoryStatActive', { count: stats.active })}</span>
        <span>{t('memoryStatFading', { count: stats.fading })}</span>
        <span>{t('memoryStatForgotten', { count: stats.forgotten })}</span>
        {extracting ? <span>{t('memoryExtracting')}</span> : null}
      </div>

      <div className={styles.addRow}>
        <select
          className={styles.kindSelect}
          value={draftKind}
          aria-label={t('memoryKind')}
          onChange={(event) =>
            setDraftKind(event.target.value as Exclude<MemoryKind, 'summary'>)
          }
        >
          {(['goal', 'preference', 'persona', 'fact', 'event'] as const).map((kind) => (
            <option key={kind} value={kind}>
              {t(KIND_LABEL[kind])}
            </option>
          ))}
        </select>
        <input
          className={styles.input}
          value={draft}
          placeholder={t('memoryAddPlaceholder')}
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
          disabled={draft.trim() === ''}
          onClick={() => void add()}
        >
          {t('memoryAdd')}
        </Button>
      </div>

      <div className={styles.toolbar}>
        <input
          className={styles.search}
          value={query}
          placeholder={t('memorySearchPlaceholder')}
          aria-label={t('memorySearchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className={styles.stateSelect}
          value={stateFilter}
          aria-label={t('memoryStateFilter')}
          onChange={(event) => setStateFilter(event.target.value as 'all' | MemoryState)}
        >
          <option value="all">{t('memoryFilterAllStates')}</option>
          <option value="active">{t('memoryStateActive')}</option>
          <option value="fading">{t('memoryStateFading')}</option>
          <option value="forgotten">{t('memoryStateForgotten')}</option>
        </select>
      </div>

      <div className={styles.kindChips}>
        <button
          type="button"
          className={clsx(styles.chip, kindFilter === 'all' && styles.chipActive)}
          onClick={() => setKindFilter('all')}
        >
          {t('memoryFilterAllKinds')}
        </button>
        {KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className={clsx(styles.chip, kindFilter === kind && styles.chipActive)}
            onClick={() => setKindFilter(kind)}
          >
            {t(KIND_LABEL[kind])}
          </button>
        ))}
      </div>

      <div className={styles.actionsRow}>
        <button type="button" className={styles.action} onClick={() => void merge()}>
          {t('memoryMergeDuplicates')}
        </button>
        <button type="button" className={styles.action} onClick={download}>
          {t('memoryExport')}
        </button>
        <button type="button" className={styles.action} onClick={() => fileRef.current?.click()}>
          {t('memoryImport')}
        </button>
        <button
          type="button"
          className={styles.dangerAction}
          onClick={() => setClearPending(true)}
        >
          {t('memoryClearAll')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) {
              void upload(file)
            }
          }}
        />
      </div>

      <p className={styles.hint}>{t('memoryCount', { count: visible.length })}</p>

      {visible.length === 0 ? (
        <p className={styles.empty}>{entries.length === 0 ? t('memoryEmpty') : t('memoryNoMatch')}</p>
      ) : (
        <ul className={styles.list}>
          {visible.map(({ entry, retention, state }) => {
            const session = entry.sourceSessionId
              ? sessions.find((item) => item.id === entry.sourceSessionId)
              : undefined
            return (
              <li key={entry.id} className={styles.item} data-state={state}>
                <div className={styles.itemHead}>
                  <span className={styles.kind}>
                    {t(KIND_LABEL[entry.kind])}
                    {entry.manual ? <span className={styles.badge}>{t('memoryManual')}</span> : null}
                    {entry.pinned ? <span className={styles.badge}>{t('memoryPinnedBadge')}</span> : null}
                  </span>
                  <span className={styles.strength}>
                    {t('memoryRetention', { percent: Math.round(retention * 100) })}
                    <span className={styles.state}>· {t(STATE_LABEL[state])}</span>
                  </span>
                </div>
                {editingId === entry.id ? (
                  <div className={styles.editRow}>
                    <textarea
                      className={styles.editText}
                      value={editingText}
                      rows={2}
                      autoFocus
                      onChange={(event) => setEditingText(event.target.value)}
                    />
                    <Button variant="outlined" size="s" onClick={() => void saveEdit()}>
                      {t('save')}
                    </Button>
                    <Button variant="outlined" size="s" onClick={() => setEditingId(null)}>
                      {t('cancel')}
                    </Button>
                  </div>
                ) : (
                  <p className={styles.text}>{entry.text}</p>
                )}
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.action}
                    onClick={() => void toggleMemoryPin(entry.id)}
                  >
                    {entry.pinned ? t('memoryUnpin') : t('memoryPin')}
                  </button>
                  <button
                    type="button"
                    className={styles.action}
                    onClick={() => {
                      setEditingId(entry.id)
                      setEditingText(entry.text)
                    }}
                  >
                    {t('memoryEdit')}
                  </button>
                  {state === 'forgotten' ? (
                    <button
                      type="button"
                      className={styles.action}
                      onClick={() => void restoreMemory(entry.id)}
                    >
                      {t('memoryRestore')}
                    </button>
                  ) : null}
                  {session && entry.sourceMessageIds[0] ? (
                    <button
                      type="button"
                      className={styles.action}
                      onClick={() => jumpToSource(entry.sourceSessionId, entry.sourceMessageIds[0])}
                    >
                      {t('memoryJumpToSource')}
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
            )
          })}
        </ul>
      )}

      {clearPending ? (
        <Modal
          title={t('memoryClearAllConfirm')}
          onClose={() => setClearPending(false)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setClearPending(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void clearAllMemory()
                  setClearPending(false)
                }}
              >
                {t('memoryDelete')}
              </Button>
            </>
          }
        >
          {t('memoryClearAllHint')}
        </Modal>
      ) : null}
    </div>
  )
}
