import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo, useState } from 'react'
import {
  IconCloseOutline16,
  IconEditOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconWarningOutline16,
} from '../base/icons.js'
import { describeReply, type NoticeAction } from '../../services/chat/describe.js'
import { canContinueReply, getReplyThinking } from '../../services/chat/reply.js'
import {
  compressCurrentSession,
  continueReply,
  editReplyContent,
  newChat,
  regenerateReply,
  revertReplyContent,
} from '../../services/chat/store.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import type { AssistantMessage as AssistantMessageType } from '../../services/chat/types.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { useSettings } from '../../services/settings.js'
import { Markdown } from '../markdown/Markdown.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { ReadAloudButton } from './ReadAloudButton.js'
import { CopyButton } from './CopyButton.js'
import { ReplyArea } from './ReplyArea.js'
import { ReplyEditor } from './ReplyEditor.js'
import { useReplyView } from './useReplyView.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import styles from './AssistantMessage.module.css'

const TOP_UP_URL = 'https://platform.deepseek.com/top_up'
const FEEDBACK_URL = 'https://github.com/deepseek-ai/DeepSeek-V3/issues'

/** 工具参数优先用流式累积的 JSON 文本，格式化成可读缩进 */
const formatToolInput = (call: { input: unknown; inputText?: string }) => {
  if (call.inputText) {
    try {
      return JSON.stringify(JSON.parse(call.inputText), null, 2)
    } catch {
      return call.inputText
    }
  }
  try {
    return JSON.stringify(call.input, null, 2) ?? ''
  } catch {
    return String(call.input)
  }
}

/**
 * 错误提示里的修复动作。文案与归因来自 describe.ts 的机器码投影，
 * 这里只负责把语义动作接到具体的 handler；不认识的动作为空。
 */
function useNoticeActions(sessionId: string, messageId: string, notice: ReturnType<typeof describeReply>) {
  const t = useTranslate()
  if (!notice) {
    return []
  }
  const actions = notice.actions ?? (notice.action ? [notice.action] : [])
  const actionKeys: Record<NoticeAction, TranslationKey> = {
    apiKey: 'changeApiKey',
    topUp: 'topUp',
    organize: 'actionOrganize',
    switchModel: 'actionSwitchModel',
    newDraft: 'actionNewDraft',
    retry: 'actionRetry',
    feedback: 'actionFeedback',
    shrinkFile: 'actionShrinkFile',
  }

  return actions.map((action) => {
    const text = t(actionKeys[action])
    const cls = styles.noticeAction
    switch (action) {
      case 'apiKey':
        return <button key={action} className={cls} type="button" onClick={() => openSettings('data')}>{text}</button>
      case 'topUp':
        return (
          <a key={action} className={cls} href={TOP_UP_URL} target="_blank" rel="noreferrer">
            {text}
          </a>
        )
      case 'organize':
        return (
          <button key={action} className={cls} type="button" onClick={() => void compressCurrentSession(sessionId)}>
            {text}
          </button>
        )
      case 'switchModel':
        return <button key={action} className={cls} type="button" onClick={() => openSettings('model')}>{text}</button>
      case 'newDraft':
        return <button key={action} className={cls} type="button" onClick={newChat}>{text}</button>
      case 'retry':
        return (
          <button key={action} className={cls} type="button" onClick={() => regenerateReply(sessionId, messageId)}>
            {text}
          </button>
        )
      case 'feedback':
        return (
          <a key={action} className={cls} href={FEEDBACK_URL} target="_blank" rel="noreferrer">
            {text}
          </a>
        )
      case 'shrinkFile':
        return (
          <button key={action} className={cls} type="button" onClick={() => showToast({ key: 'shrinkFileHint' })}>
            {text}
          </button>
        )
      default:
        return null
    }
  })
}

export const AssistantMessage = memo(function AssistantMessage({
  sessionId,
  message,
  isLast,
  streaming,
  busy,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: AssistantMessageType
  isLast: boolean
  streaming: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const view = useReplyView(message, streaming)
  const panelEntry = useSearchPanel((state) => state.entry)
  const notice = streaming ? null : describeReply(message)
  const noticeActions = useNoticeActions(sessionId, message.id, notice)
  // 安全拒绝：保留已下发的思考与正文，另外加一条拒答提示（含服务端给的原因）
  const refused = message.stopReason === 'refusal'
  const answer = view.answer
  // 服务端会指出哪些图片被拦截（stop_details.explanation）；可在设置里关掉
  const showRefusalDetail = useSettings((state) => state.showRefusalDetail)
  const provider = useSettings((state) => state.provider)
  const assistantAvatar = useSettings((state) => state.assistantAvatar)
  const refusalReason = refused && showRefusalDetail ? (message.stopDetails?.explanation ?? '') : ''
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const toolCalls = message.blocks.filter((block) => block.type === 'tool_use')
  const copyText = responseText || notice?.text
  const waiting = streaming && view.steps.length === 0 && !view.answer && !message.thinking
  const summaryEntry = `${message.id}-summary`
  // 失败、拒绝与模板提示没有可改写的模型正文；生成中不允许改写。
  const editable =
    !streaming && !refused && message.status !== 'error' && notice?.presentation !== 'response'
  if (editing) {
    return (
      <div className={styles.message} data-message-id={message.id}>
        <ReplyEditor
          hasThinking={message.blocks.some(
            (block) => block.type === 'thinking' && block.thinking.trim() !== ''
          )}
          canRevert={Boolean(message.edited)}
          busy={busy}
          initialThinking={getReplyThinking(message)}
          initialText={view.answer?.text ?? ''}
          onCancel={() => setEditing(false)}
          onSave={(draft) => {
            if (editReplyContent(sessionId, message.id, draft)) {
              setEditing(false)
              showToast({ key: 'replyEditSaved' })
            }
          }}
          onRevert={() => {
            if (revertReplyContent(sessionId, message.id)) {
              setEditing(false)
              showToast({ key: 'replyEditReverted' })
            }
          }}
        />
      </div>
    )
  }
  return (
    <div className={styles.message} data-message-id={message.id}>
      {assistantAvatar ? <img className={styles.avatar} src={assistantAvatar} alt="" /> : null}
      {refused && !streaming ? (
        <div className={clsx(styles.notice, styles.refusalNotice)}>
          <IconWarningOutline16 />
          <span>
            {t('replyRefused')}
            {refusalReason ? ` ${t('refusalReason', { reason: refusalReason })}` : null}
          </span>
        </div>
      ) : null}
      <ReplyArea
        message={message}
        view={view}
        streaming={streaming}
        hasResponse={!!responseText}
      />
      {answer ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={answer.markdown}
          loading={streaming}
          cacheKey={message.id}
          disableLink={false}
          sources={view.sources}
        />
      ) : null}
      {toolCalls.length > 0 ? (
        <div className={styles.toolCalls}>
          {toolCalls.map((call) => (
            <div key={call.id} className={styles.toolCall}>
              <div className={styles.toolCallTitle}>
                {t('toolsRequested')} · {call.name}
              </div>
              <pre className={styles.toolCallArgs}>{formatToolInput(call)}</pre>
            </div>
          ))}
        </div>
      ) : null}
      {waiting ? (
        <div className={styles.waiting}>
          {[0, 1, 2].map((index) => (
            <span key={index} className={styles.waitingDot} />
          ))}
        </div>
      ) : null}
      {notice?.presentation === 'response' ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={notice.text}
          loading={false}
          cacheKey={`${message.id}-template`}
          disableLink={false}
        />
      ) : notice ? (
        <div className={styles.notice}>
          <IconWarningOutline16 />
          <span>
            {notice.text}
            {noticeActions.map((action, index) => (
              <span key={action?.key ?? index}> {action}</span>
            ))}
          </span>
        </div>
      ) : null}
      {!streaming && !refused && view.searchResults.length > 0 ? (
        <div
          className={clsx(styles.summary, panelEntry === summaryEntry && styles.summaryActive)}
          onClick={() => toggleSearchPanel(summaryEntry, view.searchResults)}
        >
          <SiteThumbnails sources={view.searchResults} />
          <span>
            {t(
              view.searchResults.length === 1 ? 'messageSearchSummary' : 'messageSearchSummaries',
              { count: view.searchResults.length }
            )}
          </span>
        </div>
      ) : null}
      {streaming ? null : (
        <div className={styles.bottom}>
          <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
            {copyText ? <CopyButton text={copyText} /> : null}
            {responseText && !refused ? (
              <ReadAloudButton messageId={message.id} text={responseText} />
            ) : null}
            {editable ? (
              <IconButton
                icon={<IconEditOutline16 />}
                tooltip={t('editReply')}
                tooltipPlacement="bottom"
                disabled={busy}
                onClick={() => setEditing(true)}
              />
            ) : null}
            <Menu
              options={[
                {
                  key: 'regenerate',
                  label: t('regenerate'),
                  icon: <IconRefreshOutline16 />,
                  onSelect: () => {
                    stopReadAloud()
                    regenerateReply(sessionId, message.id)
                  },
                },
                ...(provider === 'deepseek'
                  ? [
                      {
                        key: 'regenerate-search',
                        label: t('regenerateWithSearch'),
                        icon: <IconSearchOutline16 />,
                        onSelect: () => {
                          stopReadAloud()
                          regenerateReply(sessionId, message.id, { search: true })
                        },
                      },
                      {
                        key: 'regenerate-no-search',
                        label: t('regenerateWithoutSearch'),
                        icon: <IconCloseOutline16 />,
                        onSelect: () => {
                          stopReadAloud()
                          regenerateReply(sessionId, message.id, { search: false })
                        },
                      },
                    ]
                  : []),
              ]}
            >
              {({ toggle }) => (
                <IconButton
                  icon={<IconRefreshOutline16 />}
                  tooltip={t('regenerate')}
                  tooltipPlacement="bottom"
                  disabled={busy || refused}
                  onClick={toggle}
                />
              )}
            </Menu>
          </div>
          {isLast && canContinueReply(message) ? (
            <Button
              variant="outlined"
              size="s"
              className={styles.continueButton}
              disabled={busy}
              onClick={() => {
                stopReadAloud()
                continueReply(sessionId, message.id)
              }}
            >
              {t('continueGenerating')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
})
