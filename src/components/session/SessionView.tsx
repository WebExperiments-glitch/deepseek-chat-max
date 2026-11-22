import clsx from 'clsx'
import { useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { exportSession } from '../../services/chat/exportSession.js'
import { IconDownloadOutline16, IconEllipsisOutline16, IconLinkOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { showToast } from '../base/toastState.js'
import { ShareDialog } from '../share/ShareDialog.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { MobileHeader } from './MobileHeader.js'
import { ModelSwitcher } from './ModelSwitcher.js'
import { PresetSwitcher } from './PresetSwitcher.js'
import styles from './SessionView.module.css'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const [shareOpen, setShareOpen] = useState(false)
  const title = session.title || t('untitledChat')
  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} />
      ) : (
        <div className={styles.header}>
          <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
            {title}
          </div>
          <div className={styles.headerActions}>
            <PresetSwitcher sessionId={session.id} />
            <ModelSwitcher />
            <IconButton
              icon={<IconLinkOutline16 />}
              tooltip={t('share')}
              tooltipPlacement="bottom"
              onClick={() => setShareOpen(true)}
            />
            <Menu
              options={[
                {
                  key: 'markdown',
                  label: t('exportMarkdown'),
                  icon: <IconDownloadOutline16 />,
                  onSelect: () => {
                    exportSession(session, 'markdown')
                    showToast({ key: 'exportDone' })
                  },
                },
                {
                  key: 'json',
                  label: t('exportJson'),
                  icon: <IconDownloadOutline16 />,
                  onSelect: () => {
                    exportSession(session, 'json')
                    showToast({ key: 'exportDone' })
                  },
                },
                {
                  key: 'html',
                  label: t('exportHtml'),
                  icon: <IconDownloadOutline16 />,
                  onSelect: () => {
                    exportSession(session, 'html')
                    showToast({ key: 'exportDone' })
                  },
                },
              ]}
            >
              {({ toggle }) => (
                <IconButton
                  icon={<IconEllipsisOutline16 />}
                  tooltip={t('exportChat')}
                  tooltipPlacement="bottom"
                  onClick={toggle}
                />
              )}
            </Menu>
          </div>
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          <div className={styles.inputContainer}>
            <ChatInput sessionId={session.id} />
            <div className={styles.caveat}>{t('contentCaveat')}</div>
          </div>
        }
      />
      {shareOpen ? (
        <ShareDialog session={session} onClose={() => setShareOpen(false)} />
      ) : null}
    </div>
  )
}
