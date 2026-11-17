import { prepareImageFile } from '../../../utils/image.js'
import { ApiError, streamMessage, streamOpenAiChat } from '../../api/client.js'
import { DEEPSEEK_ORIGIN, getProvider, supportsDeepseekFeatures } from '../../api/providers.js'
import { streamResponses, toResponsesInput } from '../../api/responses.js'
import type { MessageParam, MessageStreamEvent } from '../../api/types.js'
import { replyPrefixText, toOpenAiMessages, type InlineAttachment } from '../../api/toOpenAi.js'
import { extractFileIds, getFileErrorCode, isRetryableApiError } from '../../api/errors.js'
import {
  cancelUpload,
  describeUploadError,
  uploadAttachment,
  useUploads,
} from '../../attachments.js'
import {
  getCurrentApiKey,
  getCurrentModel,
  getDeepseekApiKey,
  useSettings,
} from '../../settings.js'
import { describeSkippedNames, inlineAttachments, notifyInlineNotice } from '../inlineAttachments.js'
import {
  findContextWindow,
  noteContextUsage,
  resolveContextWindow,
  useContextUsage,
} from '../usageStats.js'
import { useModels } from '../../models.js'
import { createLatestReminder } from '../latestReminder.js'
import {
  applyCompression,
  autoCompressNeeded,
  compressSession,
  compressionSummarySection,
  type CompressOutcome,
} from '../compression.js'
import { composeSystemPrompt } from '../systemPrompt.js'
import { formatTimeContext } from '../timeContext.js'
import { extractRoundMemory, memoryBlockForQuery } from '../../memory/store.js'
import * as db from '../db.js'
import {
  applyEvent,
  getContextRounds,
  getReplyAnswerText,
  settleReply,
  toRequestMessages,
} from '../reply.js'
import {
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type UserMessage,
} from '../types.js'

import {
  get,
  set,
  getSession,
  getStreamController,
  updateSession,
  updateReply,
  persist,
  deletingSessions,
  streamFlushes,
  titleRequests,
  history,
  serverTools,
  SAFETY_CHECK,
  FILE_RETRY_LIMIT,
  FILE_RETRY_BASE_DELAY,
  DEFAULT_OUTPUT_RESERVE,
} from './state.js'

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) =>
              serverIds.has(file.id) ? { ...file, serverId: serverIds.get(file.id) ?? null } : file
            ),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment): Promise<string | null> => {
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  // 导入或旧版本存下的图片可能是不被支持的格式（HEIC 伪装成 jpg、CMYK、渐进式 JPEG）。
  // 一律先过 prepareImageFile：它会对 JPEG 重新编码、对 PNG/GIF/WebP 原样保留。
  if (file.isImage) {
    const converted = await prepareImageFile(
      new File([blob], file.name || 'image', { type: blob.type || file.mimeType || '' })
    )
    if (converted) {
      return uploadAttachment(apiKey, file.id, converted, converted.name, true)
    }
    // 无法解码时仍用原件补传，由服务端决定是否接受，避免直接丢失附件。
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal) => {
  const epoch = history.epoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  // 附件上传固定走 DeepSeek 的 Files API，与当前对话服务商无关
  const apiKey = getDeepseekApiKey()
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(apiKey, file)
      if (serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === history.epoch) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  // 不用 toReversed：旧版 iOS Safari 没有这个方法，补传历史附件时会抛错。
  for (const [user] of [...getContextRounds(request.history)].reverse()) {
    for (const file of user.files) {
      if (!file.serverId && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const serverId = await Promise.race([ensureServerId(apiKey, file), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]))
      }
    } catch {
      signal.throwIfAborted()
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  return {
    history: request.history.map(resolve),
    question: resolve(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 非 DeepSeek 服务商的附件：直接读本地原件内联。
 * 历史轮次里的二进制文档会被跳过，本轮提问中的文档按未进入请求处理。
 */
const resolveInlineAttachments = async (
  prepared: Request,
  signal: AbortSignal
): Promise<{ groups: InlineAttachment[][]; skipped: string[] }> => {
  const groups: InlineAttachment[][] = []
  const skipped: string[] = []
  // 图片细节级别来自设置；OCR 固定用 DeepSeek Key（文档解析能力只在那里）
  const { imageDetail } = useSettings.getState()
  const ocrKey = getDeepseekApiKey()
  const inline = async (files: FileAttachment[]): Promise<InlineAttachment[]> => {
    if (files.length === 0) {
      return []
    }
    signal.throwIfAborted()
    const result = await inlineAttachments(files, { detail: imageDetail, ocrKey, signal })
    skipped.push(...result.skipped.map((item) => item.name))
    return result.inline
  }
  for (const [user] of getContextRounds(prepared.history)) {
    groups.push(await inline(user.files))
  }
  groups.push(await inline(prepared.question.files))
  return { groups, skipped }
}

/**
 * 把请求级上下文（摘要 / 记忆 / 当前时间）放到最后一条 user 消息之前。
 * 只影响本轮尾部 token，历史前缀保持不变，提示词缓存才能继续命中。
 */
const prependToLastUser = (messages: MessageParam[], context: string) => {
  if (context === '') {
    return
  }
  const last = messages.at(-1)
  if (!last || last.role !== 'user') {
    return
  }
  if (typeof last.content === 'string') {
    last.content = `${context}\n\n${last.content}`
  } else {
    last.content = [{ type: 'text', text: context }, ...last.content]
  }
}

/** 无法内联的附件（PDF、Word 等）交给界面层提示，服务层不直接弹 toast */
const showSkippedAttachments = (names: string[]) => notifyInlineNotice(describeSkippedNames(names))

/**
 * 压缩较早轮次并把摘要写回会话；手动压缩与自动压缩共用。
 * 摘要请求固定走 DeepSeek Key，与附件、语音、检索保持一致。
 */
export const compressCurrentSession = async (sessionId: string): Promise<CompressOutcome> => {
  if (get().importingHistory || deletingSessions.has(sessionId) || getStreamController(sessionId)) {
    return { ok: false, reason: 'busy' }
  }
  const session = getSession(sessionId)
  if (!session) {
    return { ok: false, reason: 'error' }
  }
  const outcome = await compressSession(
    session,
    getDeepseekApiKey(),
    useSettings.getState().locale
  )
  if (!outcome.ok) {
    return outcome
  }
  // 压缩期间会话可能被删除或开始新的生成，此时丢弃结果，避免覆盖更新后的历史
  if (!getSession(sessionId) || getStreamController(sessionId)) {
    return { ok: false, reason: 'busy' }
  }
  updateSession(sessionId, (state) => ({ ...state, compression: outcome.compression }))
  persist(sessionId)
  return outcome
}

/**
 * 回复结束后判断是否需要自动压缩：只认服务端上报的用量与已知窗口，
 * 窗口未知时不猜、不压缩，把决定权留给用户。
 */
const autoCompressAfterReply = async (sessionId: string) => {
  const settings = useSettings.getState()
  if (!settings.autoCompress || !getDeepseekApiKey()) {
    return
  }
  if (getStreamController(sessionId) || get().importingHistory) {
    return
  }
  const session = getSession(sessionId)
  const usage = useContextUsage.getState().byId[sessionId]
  if (!session || !usage) {
    return
  }
  // 按实际发请求的模型解释上下文窗口；切换模型后不拿新模型的口径套旧用量
  const model = usage.model ?? (settings.models[settings.provider] || getCurrentModel())
  const listed = findContextWindow(useModels.getState().lists, model)
  const window = resolveContextWindow(model, listed ?? undefined)
  if (window === null) {
    return
  }
  const needed = autoCompressNeeded(session, {
    tokens: usage.tokens,
    window,
    maxOutputTokens: settings.maxTokens ?? DEFAULT_OUTPUT_RESERVE,
  })
  if (needed) {
    await compressCurrentSession(sessionId)
  }
}

/**
 * OpenAI 兼容服务没有服务端标题生成，用本地截取的首句作为会话标题。
 * 与 DeepSeek 一致：已有标题时不覆盖。
 */
const applyLocalTitle = (sessionId: string, controller: AbortController, question: string) => {
  if (!titleRequests.has(controller)) {
    return
  }
  titleRequests.delete(controller)
  const title = question.replace(/\s+/g, ' ').trim().slice(0, 30)
  if (!title) {
    return
  }
  updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
}

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
export const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  try {
    for (let attempt = 0; ; attempt += 1) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      try {
        const prepared = await prepareFiles(sessionId, request, controller.signal)
        preparing = false
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder(useSettings.getState())
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        // 压缩记录存在时：请求里跳过被摘要覆盖的轮次
        const compression = getSession(sessionId)?.compression
        const now = useSettings.getState()
        const locale = now.locale
        /**
         * 系统提示词必须保持稳定。
         * 摘要 / 记忆 / 当前时间都是逐轮变化的内容，一旦塞进 system，
         * 每轮前缀都不一样，服务端的提示词缓存就永远命不中（实测命中率会掉到 0%）。
         * 因此这些动态内容统一放到本轮提问的末尾：只改变尾部 token，
         * 历史前缀完全一致，缓存才能持续命中。
         */
        const system = composeSystemPrompt(now.customSystemPrompt)
        const contextTail = [
          compressionSummarySection(compression, locale),
          now.memoryEnabled ? memoryBlockForQuery(prepared.question.content) : '',
          now.timeContext ? formatTimeContext(locale) : '',
        ]
          .filter((part) => part !== '')
          .join('\n\n')
        const messages = toRequestMessages(
          applyCompression(prepared.history, compression),
          prepared.question,
          prepared.prefix,
          initial.thinking ?? false,
          latestReminder
        )
        prependToLastUser(messages, contextTail)
        const provider = getProvider(useSettings.getState().provider)
        const model = initial.model ?? getCurrentModel()
        // DeepSeek 可以在 Messages 与 Responses 两套协议之间切换；其余服务商固定各自协议
        const useResponses =
          provider.protocol === 'anthropic' &&
          useSettings.getState().provider === 'deepseek' &&
          useSettings.getState().deepseekProtocol === 'responses'
        // 采样参数在请求时读取，改设置后立即对下一轮生效
        const { temperature, topP, maxTokens, effort, userId } = useSettings.getState()
        // user_id 可选：用于 KVCache 隔离与内容安全隔离，空串时不传
        const identity = userId.trim() ? { user_id: userId.trim() } : null
        const sampling = {
          temperature,
          top_p: topP,
          ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
        }
        // 推理强度按文档走 output_config.effort；只在开启思考时下发，开关仍由 thinking.type 决定
        const effortConfig =
          effort && (initial.thinking ?? false) ? { output_config: { effort } } : {}
        // 非 DeepSeek 服务商走 OpenAI 兼容协议，只发送对话文本
        let events: AsyncGenerator<MessageStreamEvent>
        if (useResponses) {
          events = streamResponses(
            DEEPSEEK_ORIGIN,
            getDeepseekApiKey() || getCurrentApiKey(),
            {
              model,
              stream: true,
              input: toResponsesInput(messages),
              instructions: system,
              ...(maxTokens === null ? {} : { max_output_tokens: maxTokens }),
              temperature,
              top_p: topP,
              ...(effort && (initial.thinking ?? false) ? { reasoning: { effort } } : {}),
              ...(now.safetyCheck ? { safety_check: SAFETY_CHECK } : {}),
              ...(titleRequests.has(controller) ? { title: { enabled: true } } : {}),
              ...(userId.trim() ? { user: userId.trim() } : {}),
            },
            controller.signal
          )
        } else if (provider.protocol === 'openai') {
          // 联网搜索与附件只对 DeepSeek 开放，其他服务商只发送对话
          const inline = supportsDeepseekFeatures(provider.id)
            ? await resolveInlineAttachments(prepared, controller.signal)
            : {
                groups: [] as InlineAttachment[][],
                skipped: prepared.question.files.map((file) => file.name),
              }
          if (inline.skipped.length > 0) {
            // 无法内联的文档不进请求，明确告诉用户，避免误以为模型读到了内容
            showSkippedAttachments(inline.skipped)
          }
          const openaiMessages = toOpenAiMessages(system, messages, inline.groups, {
            prefixText: prepared.prefix ? replyPrefixText(prepared.prefix.blocks) : '',
          })
          events = streamOpenAiChat(
            provider,
            getCurrentApiKey(),
            {
              model,
              messages: openaiMessages,
              stream: true,
              ...sampling,
              ...(identity ? { user_id: identity.user_id } : {}),
            },
            controller.signal,
            // 同一个会话固定用同一个 session id，便于上游做路由与提示缓存
            sessionId
          )
        } else {
          events = streamMessage(
            getCurrentApiKey() || getDeepseekApiKey(),
            {
              model,
              system,
              messages,
              thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
              ...sampling,
              ...effortConfig,
              ...(identity ? { metadata: identity } : {}),
              ...(now.safetyCheck ? { safety_check: SAFETY_CHECK } : {}),
              tools: serverTools(initial.search ?? false),
              ...(titleRequests.has(controller) ? { title: { enabled: true } } : {}),
            },
            controller.signal
          )
        }
        if (provider.protocol === 'openai') {
          // OpenAI 兼容服务不返回标题，用本轮提问本地生成
          applyLocalTitle(sessionId, controller, prepared.question.content)
        }
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        reply = settleReply(reply, 'done', Date.now())
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          attempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    // 记下这一轮真正发出去的 prompt 体量，供输入框的上下文圆环显示
    noteContextUsage(sessionId, reply.usage, reply.model)
    // 正常结束的回答才值得抽取记忆；失败与被拒绝的轮次不进记忆层
    if (reply.status === 'done') {
      void extractRoundMemory(sessionId, request.question.content, getReplyAnswerText(reply), [
        request.question.id,
        reply.id,
      ])
    }
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
    // 流结束并解除占用后再判断，避免自己把自己判定为「正在生成」
    void autoCompressAfterReply(sessionId)
  }
}

