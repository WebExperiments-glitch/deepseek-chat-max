import { streamMessage } from '../api/client.js'
import type { CreateMessageRequest } from '../api/types.js'
import type { Locale } from '../settings.js'
import { getVisibleMessages } from './branches.js'
import { reserveGeometry } from './contextPressure.js'
import { getReplyAnswerText } from './reply.js'
import type { Message, Session, SessionCompression } from './types.js'

/**
 * 长对话压缩：把较早的轮次交给模型总结成摘要，摘要进入后续请求的系统提示词，
 * 本地完整历史仍然保留（只在请求里跳过被摘要覆盖的部分），不删任何消息。
 *
 * 摘要请求固定走 DeepSeek（与附件、语音、检索一致），因为它是后台工具，
 * 不应该因为换了对话服务商就失效；没有 DeepSeek Key 时压缩功能关闭。
 */

/** 至少要有 5 轮才压缩，避免一上来就把对话抽干 */
const MIN_ROUNDS = 3
/** 压缩时始终保留最近 2 轮原文 */
const KEEP_ROUNDS = 2
/** 上次压缩后新增多少轮才再自动压缩一次 */
const AUTO_MIN_NEW_ROUNDS = 2
/** 摘要请求的输入上限，避免一次塞入过长文本 */
const MAX_TRANSCRIPT_CHARS = 48_000
/** 摘要输出上限 */
const SUMMARY_MAX_TOKENS = 1200

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

const messageText = (message: Message): string => {
  if (message.role === 'user') {
    return message.content
  }
  return message.role === 'assistant' ? getReplyAnswerText(message) : ''
}

/** 把要压缩的消息拼成带角色的纯文本，单条过长时截断 */
const buildTranscript = (messages: Message[], locale: Locale): string => {
  const userLabel = locale === 'zh-CN' ? '用户' : 'User'
  const assistantLabel = locale === 'zh-CN' ? '助手' : 'Assistant'
  const lines: string[] = []
  let total = 0
  for (const message of messages) {
    const text = messageText(message).trim()
    if (text === '') {
      continue
    }
    const clipped = text.length > 4000 ? `${text.slice(0, 4000)}…` : text
    const line = `${message.role === 'user' ? userLabel : assistantLabel}: ${clipped}`
    if (total + line.length > MAX_TRANSCRIPT_CHARS) {
      break
    }
    lines.push(line)
    total += line.length + 1
  }
  return lines.join('\n\n')
}

const summarize = async (
  apiKey: string,
  transcript: string,
  locale: Locale,
  signal: AbortSignal
): Promise<string> => {
  const system =
    locale === 'zh-CN'
      ? '你是对话压缩器。把用户给出的对话记录压缩成结构化摘要，固定包含：1) 目标与约束；2) 已确认的事实、决定与结论；3) 代码/文件/产物的当前状态；4) 未完成事项与下一步；5) 重要错误与规避方式。用第三人称分条列出，保留关键标识符与数字；不要编造，不要评论，只输出摘要正文。'
      : 'You compress conversations. Summarise the transcript into a structured summary with: 1) goals and constraints; 2) confirmed facts, decisions and conclusions; 3) current state of code/files/artifacts; 4) open items and next steps; 5) important errors and workarounds. Use third person bullets, keep identifiers and numbers; do not invent, do not comment; output only the summary body.'
  const body: CreateMessageRequest = {
    model: 'deepseek-flash',
    system,
    messages: [{ role: 'user', content: transcript }],
    thinking: { type: 'disabled' },
    temperature: 0.3,
    max_tokens: SUMMARY_MAX_TOKENS,
    tools: [],
    safety_check: { level: 'high' },
  }
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
 * 已压缩过的会话再次压缩时，会把上一次的摘要一并作为输入，避免丢信息。
 */
export const compressSession = async (
  session: Session,
  apiKey: string,
  locale: Locale
): Promise<CompressOutcome> => {
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
  const transcript = buildTranscript(target, locale)
  if (transcript === '') {
    return { ok: false, reason: 'tooShort' }
  }
  running.add(session.id)
  const controller = new AbortController()
  try {
    const previous = session.compression
    const header =
      previous && locale === 'zh-CN'
        ? `上一次的摘要：\n${previous.summary}\n\n新增对话：\n`
        : previous
          ? `Previous summary:\n${previous.summary}\n\nNew transcript:\n`
          : ''
    const summary = await summarize(apiKey, `${header}${transcript}`, locale, controller.signal)
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

/** 追加到系统提示词末尾的摘要段落；没有压缩记录时为空串 */
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
