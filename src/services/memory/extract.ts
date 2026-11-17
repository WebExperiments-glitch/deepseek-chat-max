import { createId } from '../../utils/id.js'
import { streamMessage } from '../api/client.js'
import type { CreateMessageRequest } from '../api/types.js'
import type { Locale } from '../settings.js'
import { initialStability } from './ebbinghaus.js'
import type { ExtractedMemory, MemoryEntry } from './types.js'

/**
 * 记忆抽取。
 *
 * 每轮回复结束后在后台跑一次：把这轮对话交给 flash 模型，判断哪些内容值得长期记住。
 * 抽取属于增强，失败一律静默——不能因为一次后台请求失败影响对话本身。
 * 固定用 flash：抽取是分类 + 改写任务，不需要对话所用的大模型。
 */

const EXTRACT_MODEL = 'deepseek-flash'
const MAX_PER_ROUND = 4
const MIN_USER_CHARS = 4
const MIN_REPLY_CHARS = 40

const EXTRACT_SYSTEM: Record<Locale, string> = {
  'zh-CN': `你是一个记忆整理器。阅读一轮对话，提炼出值得长期记住的信息。

判断标准：这条信息在几天后、几十轮对话之后是否仍然有用。
值得记住：对方的身份、职业、环境、背景；稳定的偏好与习惯；明确的角色设定、称呼与约定；
双方约定的规则或长期任务；发生过且后续可能被提起的事。
不值得记住：一次性的提问与答案、临时的情绪与寒暄、通用知识、你自己刚给出的解释。

输出要求：
- 每条用第三人称中文陈述，一句话说清，不超过 60 字
- 直接写事实本身，不要写「用户说」「我记住了」这类元描述
- kind 取 fact（身份背景）、preference（偏好习惯）、persona（设定约定）、event（事件）
- importance 0-1：会明显影响后续对话走向的给 0.7 以上
- difficulty 0-1：越琐碎、越偶然提到的给越高
- keywords：2-5 个检索词

只输出 JSON 数组，不要解释、不要代码块标记。没有值得记住的内容就输出 []。
示例：[{"kind":"fact","text":"对方是一名前端工程师，主要使用 TypeScript","keywords":["职业","前端","TypeScript"],"importance":0.7,"difficulty":0.3}]`,
  'en-US': `You curate long-term memory. Read one exchange and extract what is worth remembering.

Worth keeping: identity, occupation, environment, background; stable preferences and habits;
explicit role-play setup, forms of address, agreements; rules or long-running tasks; events likely
to come up again. Not worth keeping: one-off questions and answers, transient moods and pleasantries,
general knowledge, your own explanations.

Output: a JSON array only, no prose, no code fences. Use English third-person sentences under 60 words.
kind is one of fact, preference, persona, event. importance 0-1 (0.7+ when it steers future replies),
difficulty 0-1 (higher for incidental details), keywords 2-5 terms.
Empty array when nothing is worth keeping.
Example: [{"kind":"fact","text":"The user is a frontend engineer working mainly in TypeScript","keywords":["occupation","frontend","TypeScript"],"importance":0.7,"difficulty":0.3}]`,
}

const VALID_KINDS = ['fact', 'preference', 'persona', 'event'] as const

const parseArray = (raw: string): unknown[] => {
  const text = raw.trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const clamp01 = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5
}

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** 校验并规范化单条候选；结构不合格的直接丢弃 */
const toCandidate = (raw: unknown): ExtractedMemory | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const item = raw as Record<string, unknown>
  const text = asString(item.text)
  if (!text || text.length < 4 || text.length > 200) {
    return null
  }
  const kindRaw = asString(item.kind)
  const kind = (VALID_KINDS as readonly string[]).includes(kindRaw)
    ? (kindRaw as ExtractedMemory['kind'])
    : 'fact'
  const keywords = Array.isArray(item.keywords)
    ? item.keywords
        .map(asString)
        .filter((word) => word.length > 0 && word.length <= 16)
        .slice(0, 6)
    : []
  return { kind, text, keywords, importance: clamp01(item.importance), difficulty: clamp01(item.difficulty) }
}

/** 把候选转成可入库的条目 */
export const toEntry = (
  candidate: ExtractedMemory,
  sourceSessionId: string,
  sourceMessageIds: string[],
  now: number
): MemoryEntry => ({
  id: createId(),
  sourceSessionId,
  kind: candidate.kind,
  text: candidate.text,
  keywords: candidate.keywords,
  stability: initialStability(candidate.difficulty),
  difficulty: candidate.difficulty,
  reps: 0,
  lapses: 0,
  createdAt: now,
  lastReviewAt: now,
  sourceMessageIds,
  pinned: false,
  archived: false,
  manual: false,
  importance: candidate.importance,
})

/** 消费一次流式响应，拼出完整文本 */
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
  return text
}

/** 抽取一轮对话中的记忆；空数组表示没有值得记住的内容或抽取失败 */
export const extractFromRound = async ({
  apiKey,
  locale,
  sourceSessionId,
  userText,
  replyText,
  sourceMessageIds,
  signal,
}: {
  apiKey: string
  locale: Locale
  sourceSessionId: string
  userText: string
  replyText: string
  sourceMessageIds: string[]
  signal?: AbortSignal
}): Promise<MemoryEntry[]> => {
  if (userText.trim().length < MIN_USER_CHARS && replyText.trim().length < MIN_REPLY_CHARS) {
    return []
  }
  const transcript = [
    `${locale === 'zh-CN' ? '用户' : 'User'}：${userText.trim().slice(0, 2000)}`,
    `${locale === 'zh-CN' ? '助手' : 'Assistant'}：${replyText.trim().slice(0, 3000)}`,
  ].join('\n\n')
  const body: CreateMessageRequest = {
    model: EXTRACT_MODEL,
    system: EXTRACT_SYSTEM[locale],
    messages: [{ role: 'user', content: transcript }],
    thinking: { type: 'disabled' },
    max_tokens: 900,
    temperature: 0.2,
    tools: [],
    safety_check: { level: 'high' },
  }
  try {
    const raw = await collectText(apiKey, body, signal ?? new AbortController().signal)
    const now = Date.now()
    return parseArray(raw)
      .map(toCandidate)
      .filter((candidate): candidate is ExtractedMemory => candidate !== null)
      .slice(0, MAX_PER_ROUND)
      .map((candidate) => toEntry(candidate, sourceSessionId, sourceMessageIds, now))
  } catch {
    return []
  }
}
