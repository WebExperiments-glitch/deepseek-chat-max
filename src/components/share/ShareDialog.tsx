import clsx from 'clsx'
import { useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import type { Message, Session } from '../../services/chat/types.js'
import { createShare, shareLink } from '../../services/shares.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './ShareDialog.module.css'

type ShareItem = { id: string; role: 'user' | 'assistant'; text: string }

/** 分享时可选的消息：只取当前分支，空消息不展示 */
const shareableMessages = (session: Session): ShareItem[] =>
  getVisibleMessages(session).flatMap<ShareItem>((message: Message) => {
    if (message.role === 'user') {
      const content = message.content.trim()
      const files = message.files.map((file) => file.name).join('、')
      return content || files
        ? [{ id: message.id, role: 'user' as const, text: content || files }]
        : []
    }
    const text = message.blocks
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim()
    return text ? [{ id: message.id, role: 'assistant' as const, text }] : []
  })

/** 选择消息并生成分享快照；链接创建后立即可复制 */
export const ShareDialog = ({ session, onClose }: { session: Session; onClose: () => void }) => {
  const t = useTranslate()
  const messages = useMemo(() => shareableMessages(session), [session])
  const [selected, setSelected] = useState<Set<string>>(() => new Set(messages.map((m) => m.id)))
  const [link, setLink] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const toggle = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const create = async () => {
    setCreating(true)
    try {
      const share = await createShare(session.id, [...selected])
      const url = shareLink(share.id)
      setLink(url)
      await navigator.clipboard.writeText(url).catch(() => undefined)
      showToast({ key: 'shareLinkCopied' })
    } catch {
      showToast({ key: 'shareCreateFailed', type: 'error' })
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal
      title={t('shareDialogTitle')}
      closable
      onClose={onClose}
      className={styles.dialog}
      footer={
        link ? (
          <Button variant="outlined" onClick={onClose}>
            {t('close')}
          </Button>
        ) : (
          <>
            <Button variant="outlined" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={creating || selected.size === 0}
              onClick={() => void create()}
            >
              {t('shareCreateLink')}
            </Button>
          </>
        )
      }
    >
      {link ? (
        <div className={styles.created}>
          <div className={styles.description}>{t('shareDialogDescription')}</div>
          <div className={styles.linkRow}>
            <input
              className={styles.link}
              value={link}
              readOnly
              onFocus={(event) => event.target.select()}
            />
            <Button
              variant="outlined"
              onClick={() => {
                void navigator.clipboard.writeText(link).catch(() => undefined)
                showToast({ key: 'shareLinkCopied' })
              }}
            >
              {t('copy')}
            </Button>
          </div>
        </div>
      ) : messages.length === 0 ? (
        <div className={styles.empty}>{t('shareNoShareable')}</div>
      ) : (
        <>
          <div className={styles.description}>{t('shareDialogDescription')}</div>
          <div className={styles.list}>
            {messages.map((message) => {
              const checked = selected.has(message.id)
              return (
                <button
                  type="button"
                  key={message.id}
                  className={clsx(styles.item, checked && styles.itemChecked)}
                  onClick={() => toggle(message.id)}
                >
                  <span className={clsx(styles.checkbox, checked && styles.checkboxChecked)}>
                    {checked ? '✓' : null}
                  </span>
                  <span className={styles.itemBody}>
                    <span className={styles.itemRole}>
                      {t(message.role === 'user' ? 'searchResultUser' : 'searchResultAssistant')}
                    </span>
                    <span className={styles.itemText}>{message.text}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </Modal>
  )
}
