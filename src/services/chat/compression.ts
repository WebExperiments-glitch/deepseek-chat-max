import { streamMessage } from '../api/client.js'
import type { CreateMessageRequest } from '../api/types.js'
import { getActivePresetPrompt } from '../presets.js'
import { useSettings, type Locale } from '../settings.js'
import { getVisibleMessages } from './branches.js'
import { parseClientTools, toAnthropicTools } from './clientTools.js'
import { reserveGeometry } from './contextPressure.js'
import { toRequestMessages } from './reply.js'
import { serverTools } from './requestConfig.js'
import { composeSystemPrompt } from './systemPrompt.js'
import type {
  AssistantMessage,
  Message,
  Session,
  SessionCompression,
  UserMessage,
} from './types.js'

/**
 * 长对话压缩：把较早的轮次交给模型总结成摘要，摘要进入后续请求的尾部，
 * 本地完整历史仍然保留（只在请求里跳过被摘要覆盖的部分），不删任何消息。
 *
 * 摘要请求复用对话的热前缀（对齐 DSH）：system、工具声明与被压缩区间的消息
 * 逐字重放，只有尾部的摘要指令和输出是新的，这样压缩本身也能命中缓存。
 *
 * 摘要请求固定走 DeepSeek（与附件、语音、检索一致），因为它是后台工具，
 * 不应该因为换了对话服务商就失效；没有 DeepSeek Key 时压缩功能关闭。
 */

/** 至少要有 3 轮可被压缩的较早对话；加上始终保留的最近 2 轮，总共至少 5 轮才触发压缩 */
const MIN_ROUNDS = 3
/** 压缩时始终保留最近 2 轮原文 */
const KEEP_ROUNDS = 2
/** 上次压缩后新增多少轮才再自动压缩一次 */
const AUTO_MIN_NEW_ROUNDS = 2
/** 摘要输出上限 */
const SUMMARY_MAX_TOKENS = 1200
/** 非 DeepSeek 对话或缺少模型快照时的摘要模型 */
const FALLBACK_SUMMARY_MODEL = 'deepseek-flash'

const running = new Set<string>()

export const isCompressing = (sessionId: string) => running.has(sessionId)

export type CompressOutcome =
  | { ok: true; compression: SessionCompression }
  | { ok: false; reason: 'tooShort' | 'busy' | 'noKey' | 'error' }

const roundCount = (session: Session): number =>
  getVisibleMessages(session).filter((message) => message.role === 'user').length

/** 自动压缩判断的输入：最近一次请求的真实用量与窗口 */
export type AutoCompressInput = {
  tokens: number
  window: number
  maxOutputTokens: number
}

/**
 * 自动压缩判断：先按 DSH 的预留几何算压力阈值，再要求有可压缩轮次，
 * 且距上次压缩有新增内容，避免每一轮都重复总结同一段历史。
 */
export const autoCompressNeeded = (session: Session, pressure: AutoCompressInput): boolean => {
  const reserve = reserveGeometry(pressure.window, pressure.maxOutputTokens)
  if (!reserve || pressure.tokens < reserve.threshold) {
    return false
  }
  if (roundCount(session) < MIN_ROUNDS + KEEP_ROUNDS) {
    return false
  }
  const compression = session.compression
  if (!compression) {
    return true
  }
  const visible = getVisibleMessages(session)
  const cutoff = visible.findIndex((message) => message.id === compression.upToMessageId)
  if (cutoff < 0) {
    return true
  }
  const newRounds = visible.slice(cutoff + 1).filter((message) => message.role === 'user').length
  return newRounds >= AUTO_MIN_NEW_ROUNDS
}

const summaryInstruction = (locale: Locale, previousSummary?: string): string => {
  const base =
    locale === 'zh-CN'
      ? '以上是这个会话中较早的对话。请把它压缩成结构化摘要，固定包含：1) 目标与约束；2) 已确认的事实、决定与结论；3) 代码/文件/产物的当前状态；4) 未完成事项与下一步；5) 重要错误与规避方式。用第三人称分条列出，保留关键标识符与数字；不要编造，不要评论。只输出摘要正文，不要调用任何工具。'
      : 'The messages above are the earlier part of this conversation. Compress them into a structured summary covering: 1) goals and constraints; 2) confirmed facts, decisions and conclusions; 3) current state of code/files/artifacts; 4) open items and next steps; 5) important errors and workarounds. Use third person bullets, keep identifiers and numbers; do not invent, do not comment. Output only the summary body and do not call any tool.'
  if (!previousSummary) {
    return base
  }
  return [
    base,
    '',
    locale === 'zh-CN' ? '上一次的摘要（可合并，不要丢失信息）：' : 'Previous summary (merge it, do not lose information):',
    previousSummary,
  ].join('\n')
}

/** 摘要模型跟随最近的回答：只有同一路由才有前缀缓存可复用 */
const summaryModel = (lastReply: AssistantMessage | undefined): string =>
  lastReply?.model && lastReply.model.startsWith('deepseek')
    ? lastReply.model
    : FALLBACK_SUMMARY_MODEL

/** 压缩所需的外部配置（由调用方注入，核心不读全局状态） */
export type CompressionDeps = {
  /** 本会话已解析的系统提示词（预设或自定义），由调用方决定来源 */
  systemPrompt: string
  /** 自定义 tools 的 JSON 文本 */
  toolsJson: string
}

/**
 * 构造摘要请求：system、工具与消息都按对话请求的方式重放。
 * withTools=false 用于模型误调工具、拿不到正文时的兜底重试。
 */
const buildSummaryRequest = (
  target: Message[],
  locale: Locale,
  previousSummary: string | undefined,
  withTools: boolean,
  deps: CompressionDeps
): CreateMessageRequest => {
  const lastReply = [...target].reverse().find(
    (message): message is AssistantMessage => message.role === 'assistant'
  )
  const instruction: UserMessage = {
    id: `compaction-${Date.now()}`,
    role: 'user',
    content: summaryInstruction(locale, previousSummary),
    files: [],
    createdAt: Date.now(),
  }
  const clientTools = parseClientTools(deps.toolsJson)
  return {
    model: summaryModel(lastReply),
    system: composeSystemPrompt(deps.systemPrompt),
    messages: toRequestMessages(target, instruction, undefined, false),
    thinking: { type: 'disabled' },
    temperature: 0.3,
    max_tokens: SUMMARY_MAX_TOKENS,
    tools: withTools
      ? [...serverTools(lastReply?.search ?? false), ...toAnthropicTools(clientTools)]
      : [],
    safety_check: { level: 'high' },
  }
}

const collectText = async (
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): Promise<string> => {
  let text = ''
  for await (const event of streamMessage(apiKey, body, signal)) {
    if (event.type === 'content_block_start' && event.content_block.type === 'text') {
      text += event.content_block.text
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    }
  }
  return text.trim()
}

/**
 * 压缩一个会话的较早轮次。返回新的压缩记录，调用方负责写回会话并提示。
 * 已压缩过的会话再次压缩时，会把上一次的摘要放进尾部指令，避免丢信息。
 */
export const compressSession = async (
  session: Session,
  apiKey: string,
  locale: Locale,
  deps?: CompressionDeps
): Promise<CompressOutcome> => {
  // 兼容未注入的调用方：默认从全局取一次（新代码应显式注入，核心保持纯粹）
  const resolved: CompressionDeps = deps ?? {
    systemPrompt: getActivePresetPrompt(session.id) ?? useSettings.getState().customSystemPrompt,
    toolsJson: useSettings.getState().toolsJson,
  }
  if (!apiKey) {
    return { ok: false, reason: 'noKey' }
  }
  if (running.has(session.id)) {
    return { ok: false, reason: 'busy' }
  }
  const visible = getVisibleMessages(session)
  const userIndexes = visible.flatMap((message, index) =>
    message.role === 'user' ? [index] : []
  )
  if (userIndexes.length < MIN_ROUNDS + KEEP_ROUNDS) {
    return { ok: false, reason: 'tooShort' }
  }
  const cutoffRound = userIndexes.length - KEEP_ROUNDS
  const cutoffIndex = userIndexes[cutoffRound] - 1
  if (cutoffIndex < 0) {
    return { ok: false, reason: 'tooShort' }
  }
  const target = visible.slice(0, cutoffIndex + 1)
  if (!target.some((message) => message.role === 'assistant')) {
    return { ok: false, reason: 'tooShort' }
  }
  running.add(session.id)
  const controller = new AbortController()
  try {
    // 第一次带工具，尽量与对话请求逐字一致；模型若误调工具、没有正文，再去掉工具重试
    let summary = await collectText(
      apiKey,
      buildSummaryRequest(target, locale, session.compression?.summary, true, resolved),
      controller.signal
    )
    if (summary === '') {
      summary = await collectText(
        apiKey,
        buildSummaryRequest(target, locale, session.compression?.summary, false, resolved),
        controller.signal
      )
    }
    if (summary === '') {
      return { ok: false, reason: 'error' }
    }
    return {
      ok: true,
      compression: {
        summary,
        upToMessageId: visible[cutoffIndex].id,
        rounds: cutoffRound,
        at: Date.now(),
      },
    }
  } catch {
    return { ok: false, reason: 'error' }
  } finally {
    running.delete(session.id)
  }
}

/** 请求里跳过已被摘要覆盖的轮次；记录对不上（如分支被删）时原样使用完整历史 */
export const applyCompression = (
  history: Message[],
  compression?: SessionCompression
): Message[] => {
  if (!compression) {
    return history
  }
  const index = history.findIndex((message) => message.id === compression.upToMessageId)
  return index < 0 ? history : history.slice(index + 1)
}

/** 追加到本轮提问末尾的摘要段落；没有压缩记录时为空串 */
export const compressionSummarySection = (
  compression: SessionCompression | undefined,
  locale: Locale
): string => {
  if (!compression) {
    return ''
  }
  return locale === 'zh-CN'
    ? `【较早对话摘要】\n${compression.summary}`
    : `[Earlier conversation summary]\n${compression.summary}`
}
