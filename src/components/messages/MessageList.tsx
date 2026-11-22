import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { getDraft, setDraftText } from '../../services/chat/drafts.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import {
  clearFocusMessage,
  selectMessageVersion,
  useChatStore,
} from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { showToast } from '../base/toastState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { MessageTimeline } from './MessageTimeline.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import type { Message } from '../../services/chat/types.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }

export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const isMobile = useIsMobile()
  const t = useTranslate()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const messages = getVisibleMessages(session)
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const [quote, setQuote] = useState<{ text: string; top: number; left: number } | null>(null)

  // 选中消息文本后浮出「引用」按钮；只接受消息列内的选区
  const captureSelection = () => {
    window.setTimeout(() => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) {
        setQuote(null)
        return
      }
      const text = selection.toString().trim()
      if (!text) {
        setQuote(null)
        return
      }
      const range = selection.getRangeAt(0)
      const node = range.commonAncestorContainer
      const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
      if (
        !element ||
        !scrollRef.current ||
        !element.closest(`.${styles.column}`) ||
        !scrollRef.current.contains(element)
      ) {
        setQuote(null)
        return
      }
      const rect = range.getBoundingClientRect()
      setQuote({
        text: text.slice(0, 4000),
        top: Math.min(rect.bottom + 8, window.innerHeight - 48),
        left: Math.min(Math.max(rect.left + rect.width / 2, 48), window.innerWidth - 48),
      })
    }, 0)
  }

  const addQuote = () => {
    if (!quote) {
      return
    }
    const sessionId = useChatStore.getState().activeId
    const draft = getDraft(sessionId)
    const quoted = quote.text
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join('\n')
    const prefix = draft.text && !draft.text.endsWith('\n') ? `${draft.text}\n\n` : draft.text
    setDraftText(sessionId, `${prefix}${quoted}\n\n`)
    window.getSelection()?.removeAllRanges()
    setQuote(null)
    showToast({ key: 'quoteAdded' })
  }

  useEffect(() => {
    setQuote(null)
  }, [session.id])
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [])

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  // 全文搜索结果跳转：消息渲染出来后滚动到目标并短暂高亮
  const focusMessageId = useChatStore((state) => state.focusMessageId)
  useLayoutEffect(() => {
    if (!focusMessageId) {
      return
    }
    const scroll = scrollRef.current
    const target = scroll?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(focusMessageId)}"]`
    )
    if (!scroll || !target) {
      return
    }
    stickyRef.current = false
    const offset =
      target.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top +
      scroll.scrollTop -
      scroll.clientHeight / 2 +
      target.clientHeight / 2
    scroll.scrollTop = Math.max(0, offset)
    scrollTopRef.current = scroll.scrollTop
    target.classList.add(styles.focusFlash)
    window.setTimeout(() => target.classList.remove(styles.focusFlash), 1600)
    clearFocusMessage()
  }, [focusMessageId, session.id, messages.length])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom])

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <div
        ref={isMobile ? undefined : scrollRef}
        className={styles.container}
        onMouseUp={captureSelection}
        onScroll={() => setQuote(null)}
      >
        <div
          ref={isMobile ? scrollRef : undefined}
          className={styles.scroll}
        >
          <div ref={contentRef} className={styles.column}>
            {messages.map((message, index) =>
              message.role === 'user' ? (
                <UserMessage
                  key={message.id}
                  sessionId={session.id}
                  message={message}
                  retryUploadId={uploadRetryId}
                  isFirst={index === 0}
                  isLast={index === lastIndex || index === lastIndex - 1}
                  busy={streaming}
                  versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                  onSelectVersion={selectVersion}
                />
              ) : (
                <AssistantMessage
                  key={message.id}
                  sessionId={session.id}
                  message={message}
                  isLast={index === lastIndex}
                  streaming={streaming && index === lastIndex}
                  busy={streaming}
                  versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                  onSelectVersion={selectVersion}
                />
              )
            )}
          </div>
        </div>
        {footer}
      </div>
      <MessageTimeline messages={messages} scrollRef={scrollRef} />
      {quote
        ? createPortal(
            <button
              type="button"
              className={styles.quoteButton}
              style={{ top: quote.top, left: quote.left }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={addQuote}
            >
              {t('quote')}
            </button>,
            document.body
          )
        : null}
    </ScrollToBottomContext.Provider>
  )
}
