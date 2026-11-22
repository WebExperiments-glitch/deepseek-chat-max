import clsx from 'clsx'
import { useEffect, useMemo, useState, type MouseEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Message, UserMessage } from '../../services/chat/types.js'
import styles from './MessageTimeline.module.css'

/** 对话时间线：每个用户提问一个圆点，点击跳到对应轮次 */
export const MessageTimeline = ({
  messages,
  scrollRef,
}: {
  messages: Message[]
  scrollRef: RefObject<HTMLElement | null>
}) => {
  const isMobile = useIsMobile()
  const t = useTranslate()
  const [activeId, setActiveId] = useState<string | null>(null)
  const userMessages = useMemo(
    () => messages.filter((message): message is UserMessage => message.role === 'user'),
    [messages]
  )
  const userKey = userMessages.map((message) => message.id).join('|')

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || userMessages.length < 2) {
      return
    }
    const update = () => {
      const midpoint = scroll.getBoundingClientRect().top + scroll.clientHeight / 2
      let current: string | null = null
      for (const message of userMessages) {
        const element = scroll.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(message.id)}"]`
        )
        if (element && element.getBoundingClientRect().top <= midpoint) {
          current = message.id
        }
      }
      setActiveId(current)
    }
    update()
    scroll.addEventListener('scroll', update, { passive: true })
    return () => scroll.removeEventListener('scroll', update)
    // userKey 已覆盖消息增删；避免每次渲染都重新绑定滚动监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRef, userKey])

  if (isMobile || userMessages.length < 2) {
    return null
  }

  const jump = (id: string, event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const element = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
    if (!element) {
      return
    }
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    element.animate(
      [{ backgroundColor: 'rgba(77, 107, 254, 0.14)' }, { backgroundColor: 'transparent' }],
      { duration: 1200, easing: 'ease-out' }
    )
  }

  return createPortal(
    <nav className={styles.timeline} aria-label={t('timelineLabel')}>
      {userMessages.map((message, index) => (
        <button
          key={message.id}
          type="button"
          className={clsx(styles.dot, activeId === message.id && styles.dotActive)}
          aria-label={t('timelineJump', { index: index + 1 })}
          onClick={(event) => jump(message.id, event)}
        >
          <span className={styles.dotLabel}>{message.content.slice(0, 40) || t('untitledChat')}</span>
        </button>
      ))}
    </nav>,
    document.body
  )
}
