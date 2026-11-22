import { createId } from '../../utils/id.js'
import { streamMessage } from '../api/client.js'
import type { CreateMessageRequest } from '../api/types.js'
import type { Locale } from '../settings.js'
import { initialStability, relevance } from './ebbinghaus.js'
import type {
  ExtractedMemory,
  ExtractedOperation,
  MemoryEntry,
} from './types.js'

/**
 * 记忆抽取。
 *
 * 每轮回复结束后在后台跑一次：把这轮对话连同已有记忆交给 flash 模型，
 * 由它决定 ADD / UPDATE / DELETE（对齐 Mem0 的写操作语义），而不是盲目新增。
 * 抽取属于增强，失败一律静默——不能因为一次后台请求失败影响对话本身。
 * 固定用 flash：抽取是分类 + 改写任务，不需要对话所用的大模型。
 */

const EXTRACT_MODEL = 'deepseek-flash'
/** 单轮最多产生的写入操作数 */
const MAX_OPS = 4
/** 单轮最多删除的条数：删除不可逆，保守一些 */
const MAX_DELETES = 2
/** 送给抽取器的已有记忆条数上限 */
const MAX_EXISTING = 50
const MIN_USER_CHARS = 4
const MIN_REPLY_CHARS = 40

const EXTRACT_SYSTEM: Record<Locale, string> = {
  'zh-CN': `你是长期记忆整理器。你只保留对用户**长期有价值的核心信息**，其余一律不记。

【必须记住的四类】
1. 长期目标（goal）：用户的核心追求、持续在做的任务、以后想达成的目标、长期计划。
   例：用户想做独立游戏、正在准备考研、希望把项目开源、打算长期学日语。
2. 稳定偏好（preference）：用户希望被怎样对待、用什么语气/风格回应、表达与做事习惯。
   例：希望回答简洁、讨厌客套话、喜欢用表格、要求中文、偏好先结论后理由。
3. 角色设定（persona）：称呼约定、扮演关系、性格设定、明确要求遵守的规则。
   例：叫我老大、你扮演严格老师、回答都要押韵。
4. 客观事实（fact）：仅在长期明显有用时保留，如稳定身份、职业、所在地、长期背景。
   一次性的、临时的、琐碎的信息不记。

【坚决不记】
一次性提问与答案、临时情绪与寒暄、通用知识、你自己给出的解释和结论、猎奇细节、
偶发的小事、没有长期价值的事件。宁可少记，不要滥记。

【操作】已有记忆以 JSON 数组给出（id、kind、text）。对每条新信息选择：
- add：全新的长期信息
- update：补充/纠正/刷新已有条目；带 id 并给出合并后的完整文本
- delete：新信息明确推翻旧记忆（目标改变、偏好反转）；带 id；不确定就不删
- 重复或无关内容直接省略，不输出 noop

【约束】
- 只用本轮出现的信息，不臆造
- 优先 update 而非重复 add；一条信息最多更新 2 条
- 最多 4 项操作；删除最多 2 项
- text 用第三人称中文陈述，一句话，不超过 60 字，不写「用户说」「我记住了」
- kind 只能是 goal / preference / persona / fact之一
- importance 必须是 0 到 1 的小数：核心追求与长期目标给 0.9 以上，明确偏好给 0.7 以上，
  一般事实给 0.5 左右。绝不要给大于 1 的数
- difficulty 0 到 1 的小数：越明确稳定越低，越偶然琐碎越高
- keywords：2-5 个检索词

只输出 JSON 数组，不要解释、不要代码块标记。没有值得长期记住的就输出 []。
示例：[{"op":"add","kind":"goal","text":"用户希望把当前项目做成开源产品并长期维护","keywords":["开源","项目","长期目标"],"importance":0.95,"difficulty":0.2}]`,
  'en-US': `You curate LONG-TERM memory. Keep only information with lasting value; ignore everything else.

【KEEP these four】
1. goal: the user's core aspirations, ongoing tasks, long-term plans or aims.
   e.g. wants to build an indie game, is preparing for exams, plans to open-source a project.
2. preference: how the user wants to be answered — tone, style, format, communication habits.
   e.g. concise answers, no pleasantries, tables, Chinese, conclusion-first.
3. persona: forms of address, role-play setup, personality, explicit standing rules.
   e.g. call them "boss", act as a strict teacher, always answer in rhyme.
4. fact: stable identity, occupation, location, background — ONLY when clearly useful long-term.

【NEVER keep】
one-off Q&A, transient moods and pleasantries, general knowledge, your own explanations,
curious trivia, incidental small events. Prefer forgetting over over-saving.

【Operations】Existing memories are given as JSON (id, kind, text):
- add: genuinely new long-term info
- update: complement/correct/refresh an item; include id and the full merged text
- delete: new info clearly contradicts an old one (goal/preference reversed); include id; when unsure, skip
- skip duplicates and irrelevant details; never output noop

【Constraints】
- Only use information from this exchange; never invent
- Prefer update over duplicate add; at most two updates per fact
- At most four operations; at most two deletes
- Third-person sentence under 60 words; no "the user said" or "I remember"
- kind is one of goal / preference / persona / fact
- importance MUST be a decimal between 0 and 1: core goals 0.9+, clear preferences 0.7+,
  ordinary facts around 0.5. Never output a number greater than 1
- difficulty 0-1: lower for clear/stable, higher for incidental
- keywords: 2-5 terms

Output a JSON array only, no prose, no code fences. Output [] when nothing has lasting value.
Example: [{"op":"add","kind":"goal","text":"The user wants to open-source their project and maintain it long-term","keywords":["open-source","project","goal"],"importance":0.95,"difficulty":0.2}]`,
}

const VALID_KINDS = ['goal', 'preference', 'persona', 'fact', 'event'] as const

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
const toCandidate = (raw: Record<string, unknown>): ExtractedMemory | null => {
  const text = asString(raw.text)
  if (!text || text.length < 4 || text.length > 200) {
    return null
  }
  const kindRaw = asString(raw.kind)
  const kind = (VALID_KINDS as readonly string[]).includes(kindRaw)
    ? (kindRaw as ExtractedMemory['kind'])
    : 'fact'
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords
        .map(asString)
        .filter((word) => word.length > 0 && word.length <= 16)
        .slice(0, 6)
    : []
  return {
    kind,
    text,
    keywords,
    importance: clamp01(raw.importance),
    difficulty: clamp01(raw.difficulty),
  }
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

/** 只把与本轮最相关的已有记忆交给抽取器，控制 token 且减少误判 */
const focusExisting = (existing: MemoryEntry[], userText: string): MemoryEntry[] =>
  [...existing]
    .sort((a, b) => relevance(b, userText) - relevance(a, userText))
    .slice(0, MAX_EXISTING)

/**
 * 抽取一轮对话中的记忆写操作；空数组表示没有值得记住的内容或抽取失败。
 * 兼容旧版纯候选数组输出（没有 op 字段时按 add 处理）。
 */
export const extractFromRound = async ({
  apiKey,
  locale,
  existing,
  sourceSessionId,
  userText,
  replyText,
  sourceMessageIds,
  signal,
}: {
  apiKey: string
  locale: Locale
  existing: MemoryEntry[]
  sourceSessionId: string
  userText: string
  replyText: string
  sourceMessageIds: string[]
  signal?: AbortSignal
}): Promise<ExtractedOperation[]> => {
  if (userText.trim().length < MIN_USER_CHARS && replyText.trim().length < MIN_REPLY_CHARS) {
    return []
  }
  const focus = focusExisting(existing, userText)
  const existingJson = JSON.stringify(
    focus.map((entry) => ({ id: entry.id, kind: entry.kind, text: entry.text.slice(0, 100) }))
  )
  const transcript = [
    locale === 'zh-CN' ? `已有记忆：${existingJson}` : `Existing memories: ${existingJson}`,
    '',
    locale === 'zh-CN' ? '本轮对话：' : 'New exchange:',
    `${locale === 'zh-CN' ? '用户' : 'User'}：${userText.trim().slice(0, 2000)}`,
    `${locale === 'zh-CN' ? '助手' : 'Assistant'}：${replyText.trim().slice(0, 3000)}`,
  ].join('\n')
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
    const known = new Set(focus.map((entry) => entry.id))
    const operations: ExtractedOperation[] = []
    let deletes = 0
    for (const item of parseArray(raw)) {
      if (operations.length >= MAX_OPS) {
        break
      }
      if (typeof item !== 'object' || item === null) {
        continue
      }
      const record = item as Record<string, unknown>
      const op = asString(record.op).toLowerCase()
      if (op === 'noop') {
        continue
      }
      if (op === 'delete') {
        const id = asString(record.id)
        if (!known.has(id) || deletes >= MAX_DELETES) {
          continue
        }
        deletes += 1
        operations.push({ op: 'delete', id })
        continue
      }
      const candidate = toCandidate(record)
      if (!candidate) {
        continue
      }
      const entry = toEntry(candidate, sourceSessionId, sourceMessageIds, now)
      const id = asString(record.id)
      if (op === 'update' && known.has(id)) {
        operations.push({ op: 'update', id, entry })
        continue
      }
      operations.push({ op: 'add', entry })
    }
    return operations
  } catch {
    return []
  }
}
