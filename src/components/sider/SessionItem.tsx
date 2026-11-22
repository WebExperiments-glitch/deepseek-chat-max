import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCheckOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconFolderOutline16,
  IconPinOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { renameSession, selectSession, setSessionPinned } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
  onMove,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
  /** 移动到文件夹；没有文件夹时也会提供，用于查看归档说明 */
  onMove?: () => void
  /** 多选模式：点击整行切换选中，不进入会话 */
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      className={clsx(
        styles.item,
        active && !selectable && styles.active,
        selected && styles.selected
      )}
      onClick={() => {
        if (selectable) {
          onToggleSelect?.()
          return
        }
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      {selectable ? (
        <span className={clsx(styles.checkbox, selected && styles.checkboxChecked)}>
          {selected ? <IconCheckOutline16 /> : null}
        </span>
      ) : null}
      <div className={styles.title}>{displayTitle}</div>
      {selectable ? null : (
        <div className={styles.action} onClick={(event) => event.stopPropagation()}>
          <Menu
            options={[
              {
                key: 'pin',
                label: t(session.pinned ? 'unpinSession' : 'pinSession'),
                icon: <IconPinOutline16 />,
                onSelect: () => {
                  void setSessionPinned(session.id, !session.pinned).then((result) => {
                    if (result === 'limit') {
                      showToast({ key: 'pinSessionTooMany', type: 'error' })
                    }
                  })
                },
              },
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => setEditing(true),
              },
              ...(onMove
                ? [
                    {
                      key: 'move',
                      label: t('folderMove'),
                      icon: <IconFolderOutline16 />,
                      onSelect: onMove,
                    },
                  ]
                : []),
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: onDelete,
              },
            ]}
          >
            {({ toggle }) => (
              <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
            )}
          </Menu>
        </div>
      )}
    </div>
  )
})
