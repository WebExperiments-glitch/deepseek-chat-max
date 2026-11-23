import { isTranslationKey, translate, type TranslationKey } from '../../i18n/index.js'
import { toProblem, type ApiProblemCode, type ApiProblemGroup } from '../api/problem.js'
import type { AssistantMessage } from './types.js'

/** 用户可点的修复动作。文案由 UI 层按 key 渲染，核心只给语义。 */
export type NoticeAction =
  | 'apiKey' // 去检查/更换密钥
  | 'topUp' // 去充值
  | 'organize' // 一键整理历史（压缩较早轮次）
  | 'switchModel' // 换一个能装更多的模型
  | 'newDraft' // 新开对话，保留草稿
  | 'retry' // 重新发送
  | 'feedback' // 反馈
  | 'shrinkFile' // 减小文件 / 转 OCR

export type Notice = {
  text: string
  /** 模板答复使用正文样式；其余统一为错误提示。 */
  presentation?: 'response'
  /** 主动作（兼容旧 UI 的单按钮渲染） */
  action?: NoticeAction
  /** 完整动作列表（内容类给三个按钮） */
  actions?: NoticeAction[]
  /** 归因分组，便于 UI 选样式与自动重试行为 */
  group?: ApiProblemGroup
  /** 该错误是否由后台自动重试兜底（挤/连接类），UI 可据此弱化手动按钮 */
  autoRetry?: boolean
}

type NoticeSpec = { key: TranslationKey; actions: NoticeAction[] }

/**
 * 机器码 → 人话 的穷尽投影表（行业规范：code 稳定，文案只在这里本地化）。
 * Record<ApiProblemCode, …> 强制每个码都有安抚文案与动作，新增码漏配会编译失败。
 * 原始英文 message 绝不进入这里。
 */
const PROBLEM_NOTICE: Readonly<Record<ApiProblemCode, NoticeSpec>> = {
  context_overflow: {
    key: 'problemContextOverflow',
    actions: ['organize', 'switchModel', 'newDraft'],
  },
  unsupported_model: { key: 'problemUnsupportedModel', actions: ['switchModel'] },
  payload_too_large: { key: 'problemPayloadTooLarge', actions: ['shrinkFile'] },
  auth_failed: { key: 'problemAuthFailed', actions: ['apiKey'] },
  insufficient_balance: { key: 'problemInsufficientBalance', actions: ['topUp'] },
  timeout: { key: 'problemTimeout', actions: [] },
  rate_limited: { key: 'problemRateLimited', actions: [] },
  server_busy: { key: 'problemServerBusy', actions: [] },
  gateway_timeout: { key: 'problemGatewayTimeout', actions: ['retry'] },
  server_error: { key: 'problemServerError', actions: ['retry', 'feedback'] },
  invalid_request: { key: 'problemInvalidRequest', actions: ['retry', 'feedback'] },
  network: { key: 'problemNetwork', actions: ['retry'] },
  cors: { key: 'problemCors', actions: ['apiKey'] },
  protocol: { key: 'problemProtocol', actions: ['retry'] },
  unknown: { key: 'problemUnknown', actions: ['retry'] },
}

/** 挤/连接类由后台指数退避自动重试，文案里不必催用户动手 */
const AUTO_RETRY_GROUPS: ReadonlySet<ApiProblemGroup> = new Set(['crowded', 'connection'])

const getTemplateText = (reply: AssistantMessage) =>
  reply.blocks
    .map((block) => (block.type === 'text' && block.isTemplate ? block.text : ''))
    .join('')

/** 回复出错或未正常结束时展示的提示 */
export const describeReply = (reply: AssistantMessage): Notice | null => {
  if (reply.status === 'error' && reply.error) {
    const { kind, localMessage } = reply.error

    // 发送前补传附件失败：请求没发出，沿用上传时生成的中文文案（含可重试标志的语义）
    if (kind === 'upload') {
      const message =
        localMessage && isTranslationKey(localMessage.key)
          ? translate(localMessage.key, localMessage.params)
          : reply.error.message
      return { text: message || translate('uploadFileStatusFailed') }
    }

    // 其余一律走机器码投影：原始英文报错只用于诊断，绝不展示给用户
    const problem = toProblem(reply.error)
    const spec = PROBLEM_NOTICE[problem.code]
    return {
      text: translate(spec.key),
      action: spec.actions[0],
      actions: spec.actions,
      group: problem.group,
      autoRetry: AUTO_RETRY_GROUPS.has(problem.group),
    }
  }
  const template = getTemplateText(reply)
  // 归档不带结构化错误，错误文案保存在模板中，仍按错误提示展示。
  if (reply.status === 'error' && template) {
    return { text: template }
  }
  if (reply.stopReason === 'refusal') {
    // 拒答正文不再替换回答：归档带模板时展示模板，否则由消息组件渲染拒答提示
    return template ? { text: template, presentation: 'response' } : null
  }
  if (template) {
    return { text: template, presentation: 'response' }
  }
  return null
}
