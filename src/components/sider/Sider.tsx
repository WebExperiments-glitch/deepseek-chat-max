import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { BrandLogo } from '../brand/BrandLogo.js'
import {
  IconCheckOutline16,
  IconCheckedOutline14,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconPanelLeftOutline16,
  IconPinOutline16,
  IconPlusOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import {
  createFolder,
  deleteFolder,
  moveSessionToFolder,
  newChat,
  removeSession,
  renameFolder,
  setSessionsPinned,
  useChatStore,
} from '../../services/chat/store.js'
import type { Folder, SessionSummary } from '../../services/chat/types.js'
import { openSearchDialog } from '../search/searchDialogState.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 文件夹弹窗：新建 / 重命名 / 删除 / 移动会话 */
type FolderDialog =
  | { mode: 'create' }
  | { mode: 'rename'; folder: Folder }
  | { mode: 'delete'; folder: Folder }
  | { mode: 'move'; session: SessionSummary }
  | null

/** 展开的侧边栏：搜索、选择模式、开启新对话、按时间分组的会话列表、底部设置 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const brandMode = useSettings((state) => state.brandMode)
  const brandText = useSettings((state) => state.brandText)
  const sessions = useChatStore((state) => state.sessions)
  const folders = useChatStore((state) => state.folders)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const [folderFilter, setFolderFilter] = useState<string>('all')
  const [folderDialog, setFolderDialog] = useState<FolderDialog>(null)
  const [folderName, setFolderName] = useState('')
  const [folderBusy, setFolderBusy] = useState(false)
  const [moveTarget, setMoveTarget] = useState<string>('')
  const scopedSessions = useMemo(
    () =>
      sessions.filter((session) =>
        folderFilter === 'all'
          ? true
          : folderFilter === 'none'
            ? !session.folderId
            : session.folderId === folderFilter
      ),
    [sessions, folderFilter]
  )
  const { pinned, groups } = useMemo(() => {
    const pinnedSessions = scopedSessions.filter((session) => session.pinned)
    const rest = scopedSessions.filter((session) => !session.pinned)
    return { pinned: pinnedSessions, groups: groupSessions(rest, now, t) }
  }, [scopedSessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [batchConfirm, setBatchConfirm] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)

  // 文件夹被删除后，筛选自动回到「全部」
  useEffect(() => {
    if (
      folderFilter !== 'all' &&
      folderFilter !== 'none' &&
      !folders.some((folder) => folder.id === folderFilter)
    ) {
      setFolderFilter('all')
    }
  }, [folders, folderFilter])

  const openCreateFolder = () => {
    setFolderName('')
    setFolderDialog({ mode: 'create' })
  }

  const openRenameFolder = (folder: Folder) => {
    setFolderName(folder.name)
    setFolderDialog({ mode: 'rename', folder })
  }

  const submitFolderName = async () => {
    if (!folderDialog || (folderDialog.mode !== 'create' && folderDialog.mode !== 'rename')) {
      return
    }
    if (!folderName.trim()) {
      showToast({ key: 'folderNameRequired', type: 'error' })
      return
    }
    setFolderBusy(true)
    try {
      if (folderDialog.mode === 'create') {
        const created = await createFolder(folderName)
        if (!created) {
          showToast({ key: 'folderMoveFailed', type: 'error' })
          return
        }
        setFolderFilter(created.id)
        showToast({ key: 'folderCreated' })
      } else {
        if (!(await renameFolder(folderDialog.folder.id, folderName))) {
          showToast({ key: 'folderMoveFailed', type: 'error' })
          return
        }
        showToast({ key: 'folderRenamed' })
      }
      setFolderDialog(null)
    } finally {
      setFolderBusy(false)
    }
  }

  const confirmDeleteFolder = async () => {
    if (!folderDialog || folderDialog.mode !== 'delete') {
      return
    }
    setFolderBusy(true)
    try {
      if (!(await deleteFolder(folderDialog.folder.id))) {
        showToast({ key: 'folderMoveFailed', type: 'error' })
        return
      }
      setFolderDialog(null)
      showToast({ key: 'folderDeleted' })
    } finally {
      setFolderBusy(false)
    }
  }

  const openMove = (session: SessionSummary) => {
    setMoveTarget(session.folderId ?? '')
    setFolderDialog({ mode: 'move', session })
  }

  const confirmMove = async () => {
    if (!folderDialog || folderDialog.mode !== 'move') {
      return
    }
    setFolderBusy(true)
    try {
      if (!(await moveSessionToFolder(folderDialog.session.id, moveTarget || null))) {
        showToast({ key: 'folderMoveFailed', type: 'error' })
        return
      }
      setFolderDialog(null)
    } finally {
      setFolderBusy(false)
    }
  }

  const folderDialogTitle = (() => {
    switch (folderDialog?.mode) {
      case 'create':
        return t('folderCreate')
      case 'rename':
        return t('folderRename')
      case 'delete':
        return t('folderDelete')
      case 'move':
        return t('folderMoveTitle')
      default:
        return ''
    }
  })()

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  // 搜索防抖与结果展示已迁移到全局搜索浮层

  const selectedSessions = sessions.filter((session) => selectedIds.has(session.id))
  const allPinned = selectedSessions.length > 0 && selectedSessions.every((session) => session.pinned)

  const exitSelection = () => {
    setSelecting(false)
    setSelectedIds(new Set())
  }

  const toggleSelected = (id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleAll = () => {
    const visible = [...pinned, ...groups.flatMap((group) => group.sessions)]
    setSelectedIds((previous) =>
      previous.size === visible.length ? new Set() : new Set(visible.map((session) => session.id))
    )
  }

  const batchPin = async () => {
    if (selectedIds.size === 0) {
      return
    }
    const result = await setSessionsPinned([...selectedIds], !allPinned)
    if (result.limitReached) {
      showToast({ key: 'pinSessionTooMany', type: 'error' })
    }
    if (result.failedIds.length === 0) {
      exitSelection()
    }
  }

  const batchDelete = async () => {
    if (selectedIds.size === 0) {
      return
    }
    setBatchDeleting(true)
    try {
      const ids = [...selectedIds]
      const outcomes = await Promise.all(ids.map((id) => removeSession(id)))
      if (outcomes.every(Boolean)) {
        setBatchConfirm(false)
        exitSelection()
      } else {
        showToast({ key: 'sessionDeleteFailed', type: 'error' })
      }
    } finally {
      setBatchDeleting(false)
    }
  }

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}>
          {brandMode === 'logo' ? (
            <BrandLogo className={styles.brandLogo} />
          ) : (
            brandText.trim() || t('appName')
          )}
        </div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.tools}>
        <button
          type="button"
          className={styles.searchBox}
          onClick={() => {
            openSearchDialog()
            closeMobileSider()
          }}
        >
          <IconSearchOutline16 />
          <span className={styles.searchPlaceholder}>{t('searchChatsPlaceholder')}</span>
        </button>
        <IconButton
          icon={selecting ? <IconCheckOutline16 /> : <IconCheckedOutline14 />}
          tooltip={selecting ? t('exitSelection') : t('selectSessions')}
          tooltipPlacement="bottom"
          onClick={() => (selecting ? exitSelection() : setSelecting(true))}
        />
      </div>
      {!selecting ? (
        <div className={styles.folderBar}>
          <div className={styles.folderChips}>
            <span
              className={clsx(
                styles.folderChipWrap,
                folderFilter === 'all' && styles.folderChipWrapActive
              )}
            >
              <button
                type="button"
                className={styles.folderChip}
                onClick={() => setFolderFilter('all')}
              >
                {t('folderAll')}
              </button>
            </span>
            <span
              className={clsx(
                styles.folderChipWrap,
                folderFilter === 'none' && styles.folderChipWrapActive
              )}
            >
              <button
                type="button"
                className={styles.folderChip}
                onClick={() => setFolderFilter('none')}
              >
                {t('folderUnfiled')}
              </button>
            </span>
            {folders.map((folder) => {
              const count = sessions.filter((session) => session.folderId === folder.id).length
              const selected = folderFilter === folder.id
              return (
                <span
                  key={folder.id}
                  className={clsx(
                    styles.folderChipWrap,
                    selected && styles.folderChipWrapActive
                  )}
                >
                  <button
                    type="button"
                    className={styles.folderChip}
                    title={folder.name}
                    onClick={() => setFolderFilter(folder.id)}
                  >
                    <span className={styles.folderChipLabel}>{folder.name}</span>
                    <span className={styles.folderChipCount}>{count}</span>
                  </button>
                  <span onClick={(event) => event.stopPropagation()}>
                    <Menu
                      options={[
                        {
                          key: 'rename',
                          label: t('folderRename'),
                          icon: <IconEditOutline16 />,
                          onSelect: () => openRenameFolder(folder),
                        },
                        {
                          key: 'delete',
                          label: t('folderDelete'),
                          icon: <IconTrashOutline16 />,
                          danger: true,
                          onSelect: () => setFolderDialog({ mode: 'delete', folder }),
                        },
                      ]}
                    >
                      {({ toggle }) => (
                        <button
                          type="button"
                          className={styles.folderChipMenu}
                          aria-label={t('more')}
                          onClick={toggle}
                        >
                          <IconEllipsisOutline16 />
                        </button>
                      )}
                    </Menu>
                  </span>
                </span>
              )
            })}
          </div>
          <IconButton
            icon={<IconPlusOutline16 />}
            tooltip={t('folderNew')}
            tooltipPlacement="bottom"
            onClick={openCreateFolder}
          />
        </div>
      ) : null}
      {selecting ? (
        <div className={styles.batchBar}>
          <span className={styles.batchCount}>
            {t('selectedSessionCount', { count: selectedIds.size })}
          </span>
          <button type="button" className={styles.batchAction} onClick={toggleAll}>
            {t('selectAllSessions')}
          </button>
          <IconButton
            icon={<IconPinOutline16 />}
            tooltip={allPinned ? t('unpinSession') : t('pinSession')}
            tooltipPlacement="bottom"
            disabled={selectedIds.size === 0}
            onClick={() => void batchPin()}
          />
          <IconButton
            icon={<IconTrashOutline16 />}
            tooltip={t('delete')}
            tooltipPlacement="bottom"
            disabled={selectedIds.size === 0}
            onClick={() => setBatchConfirm(true)}
          />
        </div>
      ) : null}
      <div className={styles.listWrap}>
        <div className={styles.list}>
          <>
              {pinned.length > 0 ? (
                <div className={styles.section}>
                  <div className={styles.sectionHeader}>{t('pinnedSessions')}</div>
                  {pinned.map((session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      active={session.id === activeId}
                      onDelete={() => setDeleting(session)}
                      onMove={() => openMove(session)}
                      selectable={selecting}
                      selected={selectedIds.has(session.id)}
                      onToggleSelect={() => toggleSelected(session.id)}
                    />
                  ))}
                </div>
              ) : null}
              {groups.map((group) => (
                <div key={group.key} className={styles.section}>
                  <div className={styles.sectionHeader}>{group.label}</div>
                  {group.sessions.map((session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      active={session.id === activeId}
                      onDelete={() => setDeleting(session)}
                      onMove={() => openMove(session)}
                      selectable={selecting}
                      selected={selectedIds.has(session.id)}
                      onToggleSelect={() => toggleSelected(session.id)}
                    />
                  ))}
                </div>
              ))}
          </>
        </div>
      </div>
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {folderDialog?.mode === 'create' || folderDialog?.mode === 'rename' ? (
        <Modal
          title={folderDialogTitle}
          onClose={() => {
            if (!folderBusy) {
              setFolderDialog(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={folderBusy} onClick={() => setFolderDialog(null)}>
                {t('cancel')}
              </Button>
              <Button disabled={folderBusy} onClick={() => void submitFolderName()}>
                {t('save')}
              </Button>
            </>
          }
        >
          <input
            className={styles.folderNameInput}
            value={folderName}
            autoFocus
            maxLength={40}
            placeholder={t('folderNamePlaceholder')}
            aria-label={folderDialogTitle}
            onChange={(event) => setFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                void submitFolderName()
              } else if (event.key === 'Escape') {
                setFolderDialog(null)
              }
            }}
          />
        </Modal>
      ) : null}
      {folderDialog?.mode === 'delete' ? (
        <Modal
          title={t('folderDeleteConfirm')}
          onClose={() => {
            if (!folderBusy) {
              setFolderDialog(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={folderBusy} onClick={() => setFolderDialog(null)}>
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={folderBusy} onClick={() => void confirmDeleteFolder()}>
                {t('delete')}
              </Button>
            </>
          }
        >
          <div className={styles.folderDialogText}>
            {folderDialog.folder.name}
            <div className={styles.folderDialogHint}>{t('folderDeleteHint')}</div>
          </div>
        </Modal>
      ) : null}
      {folderDialog?.mode === 'move' ? (
        <Modal
          title={t('folderMoveTitle')}
          onClose={() => {
            if (!folderBusy) {
              setFolderDialog(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={folderBusy} onClick={() => setFolderDialog(null)}>
                {t('cancel')}
              </Button>
              <Button disabled={folderBusy} onClick={() => void confirmMove()}>
                {t('save')}
              </Button>
            </>
          }
        >
          <div className={styles.folderOptions}>
            <label className={styles.folderOption}>
              <input
                type="radio"
                name="folder-target"
                checked={moveTarget === ''}
                onChange={() => setMoveTarget('')}
              />
              {t('folderUnfiled')}
            </label>
            {folders.map((folder) => (
              <label key={folder.id} className={styles.folderOption}>
                <input
                  type="radio"
                  name="folder-target"
                  checked={moveTarget === folder.id}
                  onChange={() => setMoveTarget(folder.id)}
                />
                {folder.name}
              </label>
            ))}
          </div>
        </Modal>
      ) : null}
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
      {batchConfirm ? (
        <Modal
          title={t('batchDeleteSessionsTitle')}
          onClose={() => {
            if (!batchDeleting) {
              setBatchConfirm(false)
            }
          }}
          footer={
            <>
              <Button
                variant="outlined"
                disabled={batchDeleting}
                onClick={() => setBatchConfirm(false)}
              >
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={batchDeleting} onClick={() => void batchDelete()}>
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('batchDeleteSessionsDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  if (!open) {
    return null
  }
  return (
    <>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={styles.drawer}>
        <Sider mobile />
      </div>
    </>
  )
}
