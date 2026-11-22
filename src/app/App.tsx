import { useEffect, useState } from 'react'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { checkForUpdate } from './updateChecker.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import { useTheme } from './theme.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { CodePreviewPanel } from '../components/markdown/CodePreviewPanel.js'
import { SearchDialog } from '../components/search/SearchDialog.js'
import { openSearchDialog } from '../components/search/searchDialogState.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { closePreviewPanel } from '../components/markdown/previewPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { StatsDialog } from '../components/stats/StatsDialog.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { onInlineNotice } from '../services/chat/inlineAttachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { initMemory } from '../services/memory/store.js'
import { loadModelMeta } from '../services/modelMeta.js'
import { loadModelCatalog } from '../services/modelCatalog.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  const readingWidth = useSettings((state) => state.readingWidth)
  const codeWrap = useSettings((state) => state.codeWrap)
  const appearance = useSettings((state) => state.appearance)
  const theme = useTheme()
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)
  const [updateAvailable, setUpdateAvailable] = useState(false)

  usePreventPageScroll(isMobile)

  useEffect(() => checkForUpdate(() => setUpdateAvailable(true)), [])

  // 全局搜索：Ctrl/⌘+K，与侧栏搜索入口一致
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openSearchDialog()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /** 带时间戳重载，强制绕过缓存的旧 HTML/JS */
  const reloadLatest = () => {
    const url = new URL(window.location.href)
    url.searchParams.set('__v', String(Date.now()))
    window.location.href = url.href
  }

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 阅读宽度与代码换行通过根节点属性控制，CSS 只写一份
  useEffect(() => {
    const root = document.documentElement
    root.dataset.readingWidth = readingWidth
    root.dataset.codeWrap = String(codeWrap)
  }, [readingWidth, codeWrap])

  // 外观配色：明暗主题各用一套，空值回落到默认样式
  useEffect(() => {
    const root = document.documentElement
    const colors = appearance[theme]
    const apply = (name: string, value: string) => {
      if (value.trim()) {
        root.style.setProperty(name, value)
      } else {
        root.style.removeProperty(name)
      }
    }
    apply('--chat-user-bubble', colors.userBubble)
    apply('--chat-assistant-bubble', colors.assistantBubble)
    apply('--chat-assistant-bubble-padding', colors.assistantBubble ? '12px' : '')
    apply('--chat-background', colors.chatBackground)
  }, [appearance, theme])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  // 非 DeepSeek 服务商下无法内联的文档附件不随请求发送，用 toast 说明
  useEffect(
    () =>
      onInlineNotice((notice) =>
        showToast({
          key: 'attachmentNotSentForProvider',
          params: { names: notice.names.join(', ') },
        })
      ),
    []
  )
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 代码预览面板只属于当前会话
  useEffect(closePreviewPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  // 分享页“继续聊”创建的新会话：列表加载完成后自动打开
  useEffect(() => {
    if (!ready) {
      return
    }
    const id = sessionStorage.getItem('chat-demo:select-session')
    if (!id) {
      return
    }
    sessionStorage.removeItem('chat-demo:select-session')
    if (useChatStore.getState().sessions.some((item) => item.id === id)) {
      selectSession(id)
    }
  }, [ready])

  useEffect(() => {
    void initChat()
    // 长期记忆随应用启动读入，请求前才能同步取到记忆块
    void initMemory()
    // models.dev 元数据用于补全上下文窗口与输入模态，失败不影响对话
    void loadModelMeta()
    // OpenCode 实时模型目录（每天更新）供模型选型器筛选；失败降级缓存
    void loadModelCatalog()
    // 首次打开先在设置里输入 API Key
    ensureApiKey()
  }, [])

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {isMobile ? (
          <MobileSider />
        ) : (
          // 收起时保留节点，用官方同样的 max-width 过渡做滑出/滑入
          <div
            className={
              siderCollapsed ? `${styles.siderSlot} ${styles.siderSlotCollapsed}` : styles.siderSlot
            }
            aria-hidden={siderCollapsed}
          >
            <Sider />
          </div>
        )}
        <main className={styles.main}>
          {updateAvailable ? (
            <button type="button" className={styles.updateBanner} onClick={reloadLatest}>
              {t('updateAvailable')}
            </button>
          ) : null}
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
        <CodePreviewPanel />
      </div>
      <SettingsDialog />
      <StatsDialog />
      <SearchDialog />
      <Toast />
    </>
  )
}
