import clsx from 'clsx'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { focusSessionMessage } from '../../services/chat/store.js'
import { searchChats, type ChatSearchResult } from '../../services/search.js'
import { useSettings } from '../../services/settings.js'
import { IconCloseOutline16, IconSearchOutline16 } from '../base/icons.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import { closeSearchDialog, useSearchDialog } from './searchDialogState.js'
import styles from './SearchDialog.module.css'

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0)

/** 官方搜索结果右侧的时间：今天 / 昨天 / 具体日期 */
const dateLabel = (time: number, t: ReturnType<typeof useTranslate>): string => {
  const locale = useSettings.getState().locale
  const date = new Date(time)
  const diff = Math.floor((startOfDay(Date.now()) - startOfDay(time)) / 86_400_000)
  if (diff <= 0) {
    return t('sessionHistoryTimelineLabelToday')
  }
  if (diff === 1) {
    return t('sessionHistoryTimelineLabelYesterday')
  }
  return locale === 'zh-CN'
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getMonth() + 1}/${date.getDate()}`
}

/** 官方样式的全局搜索：居中浮层、标题 + 摘要 + 时间，支持键盘上下选择 */
export const SearchDialog = () => {
  const t = useTranslate()
  const open = useSearchDialog((state) => state.open)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ChatSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [failed, setFailed] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setQuery('')
    setResults([])
    setSearching(false)
    setFailed(false)
    setActive(0)
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }
    const keyword = query.trim()
    if (!keyword) {
      setResults([])
      setSearching(false)
      setFailed(false)
      setActive(0)
      return
    }
    let cancelled = false
    setSearching(true)
    setFailed(false)
    const timer = window.setTimeout(() => {
      searchChats(keyword)
        .then((list) => {
          if (!cancelled) {
            setResults(list)
            setSearching(false)
            setActive(0)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setFailed(true)
            setSearching(false)
          }
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query])

  if (!open) {
    return null
  }

  const choose = (result: ChatSearchResult) => {
    focusSessionMessage(result.sessionId, result.messageId)
    closeSearchDialog()
    closeMobileSider()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSearchDialog()
      return
    }
    if (results.length === 0) {
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (index + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (index - 1 + results.length) % results.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const result = results[active]
      if (result) {
        choose(result)
      }
    }
  }

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeSearchDialog()
        }
      }}
    >
      <div className={styles.panel} role="dialog" aria-modal="true" onKeyDown={onKeyDown}>
        <div className={styles.searchRow}>
          <IconSearchOutline16 />
          <input
            ref={inputRef}
            value={query}
            placeholder={t('searchChatsPlaceholder')}
            aria-label={t('searchChatsPlaceholder')}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className={styles.close}
            aria-label={t('close')}
            onClick={closeSearchDialog}
          >
            <IconCloseOutline16 />
          </button>
        </div>
        <div className={styles.results}>
          {query.trim() === '' ? (
            <div className={styles.hint}>{t('searchDialogHint')}</div>
          ) : searching ? (
            <div className={styles.hint}>{t('searchChatsLoading')}</div>
          ) : failed ? (
            <div className={styles.hint}>{t('searchChatsFailed')}</div>
          ) : results.length === 0 ? (
            <div className={styles.hint}>{t('searchChatsEmpty')}</div>
          ) : (
            results.map((result, index) => (
              <button
                type="button"
                key={`${result.sessionId}-${result.messageId}`}
                className={clsx(styles.result, index === active && styles.resultActive)}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(result)}
              >
                <span className={styles.resultIcon}>
                  <IconSearchOutline16 />
                </span>
                <span className={styles.resultBody}>
                  <span className={styles.resultTitle}>
                    {result.title || t('untitledChat')}
                  </span>
                  <span className={styles.resultSnippet}>
                    {result.before}
                    <mark>{result.match}</mark>
                    {result.after}
                  </span>
                </span>
                <span className={styles.resultDate}>{dateLabel(result.updatedAt, t)}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
