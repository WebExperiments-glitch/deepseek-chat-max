import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { BrandLogo } from '../brand/BrandLogo.js'
import { Markdown } from '../markdown/Markdown.js'
import { Button } from '../base/Button.js'
import { createId } from '../../utils/id.js'
import * as db from '../../services/chat/db.js'
import type { Message } from '../../services/chat/types.js'
import { getShare, type Share } from '../../services/shares.js'
import styles from './SharedSessionPage.module.css'

const SELECT_SESSION_KEY = 'chat-demo:select-session'

/** 分享页：只读快照；“继续聊”把快照复制成新的本地会话后回到主界面 */
export const SharedSessionPage = ({ id }: { id: string }) => {
  const t = useTranslate()
  const [share, setShare] = useState<Share | null | undefined>(undefined)
  const [forking, setForking] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    getShare(id)
      .then((value) => {
        if (!cancelled) {
          setShare(value)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setShare(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [id])

  const fork = async () => {
    if (!share || forking) {
      return
    }
    setForking(true)
    try {
      const now = Date.now()
      const messages: Message[] = share.messages.map((message) =>
        message.role === 'user'
          ? {
              id: createId(),
              role: 'user',
              content: message.content ?? '',
              files: [],
              createdAt: message.createdAt || now,
            }
          : {
              id: createId(),
              role: 'assistant',
              createdAt: message.createdAt || now,
              model: null,
              prefix: true,
              status: 'done',
              blocks: [{ type: 'text', text: message.text ?? '' }],
            }
      )
      const sessionId = createId()
      await db.saveSession({
        id: sessionId,
        title: share.title,
        createdAt: now,
        updatedAt: now,
        messages,
      })
      sessionStorage.setItem(SELECT_SESSION_KEY, sessionId)
      window.location.href = '/'
    } catch {
      setFailed(true)
      setForking(false)
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <BrandLogo className={styles.logo} />
        </div>
        <Button variant="outlined" size="s" disabled={!share || forking} onClick={() => void fork()}>
          {t('shareContinue')}
        </Button>
      </header>
      {share === undefined ? (
        <div className={styles.hint}>{t('shareLoading')}</div>
      ) : share === null ? (
        <div className={styles.hint}>{t('shareNotFound')}</div>
      ) : (
        <main className={styles.main}>
          <h1 className={styles.title}>{share.title || t('untitledChat')}</h1>
          <div className={styles.notice}>{t('sharePageReadOnly')}</div>
          <div className={styles.messages}>
            {share.messages.map((message) => (
              <div
                key={message.id}
                className={message.role === 'user' ? styles.userMessage : styles.assistantMessage}
              >
                {message.role === 'user' ? (
                  <>
                    <div className={styles.userText}>{message.content}</div>
                    {message.files && message.files.length > 0 ? (
                      <div className={styles.files}>
                        {message.files.map((file) =>
                          file.isImage ? (
                            <img
                              key={file.id}
                              className={styles.image}
                              src={`/api/files/${encodeURIComponent(file.id)}`}
                              alt={file.name}
                            />
                          ) : (
                            <span key={file.id} className={styles.file}>
                              {file.name}
                            </span>
                          )
                        )}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <Markdown
                    content={message.text ?? ''}
                    loading={false}
                    cacheKey={message.id}
                    disableLink={false}
                  />
                )}
              </div>
            ))}
          </div>
          <div className={styles.bottomNotice}>{t('sharePageReadOnly')}</div>
        </main>
      )}
      {failed ? <div className={styles.failed}>{t('historyImportFailed')}</div> : null}
    </div>
  )
}
