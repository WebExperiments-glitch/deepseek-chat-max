import { create } from 'zustand'
import { createId } from '../../../utils/id.js'
import { platform } from '../../../ports/platform.js'
import { getCurrentModel, useSettings } from '../../settings.js'
import * as db from '../db.js'
import { settleReply } from '../reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type Folder,
  type Session,
  type SessionSummary,
} from '../types.js'
// 纯请求配置已抽到 requestConfig.ts（零依赖）；这里 re-export 保持所有调用方兼容
export {
  DEFAULT_OUTPUT_RESERVE,
  SAFETY_CHECK,
  FILE_RETRY_LIMIT,
  FILE_RETRY_BASE_DELAY,
  serverTools,
} from '../requestConfig.js'

/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
export const SESSION_CACHE_LIMIT = 5

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
export const titleRequests = new Set<AbortController>()

export type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  /** 侧栏文件夹；只影响列表归档，不参与请求 */
  folders: Folder[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
  /** 搜索结果跳转目标；消息列表滚动到位后清空 */
  focusMessageId: string | null
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  folders: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
  focusMessageId: null,
}))

export const { getState: get, setState: set } = useChatStore

export const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort(
    (a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt
  )

export const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

export const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

export const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

export const sessionAccess = new Map<string, number>()
export const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
export const pendingFiles = new Map<string, db.StoredFile[]>()
export const deletingSessions = new Set<string>()
export const deletionTasks = new Set<Promise<boolean>>()
export const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
export const history = { epoch: 0 }
export const sessionLoads = new Map<string, { promise: Promise<void> }>()

export const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

export const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

export const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

export const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

export const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = history.epoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== history.epoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === history.epoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const p = platform()
  const offVisibility = p.onVisibilityChange(() => {
    if (p.isPageHidden()) {
      save()
    }
  })
  const offPageHide = p.onPageHide(save)
  return () => {
    offVisibility()
    offPageHide()
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
export const createReply = (
  overrides?: Partial<Pick<AssistantMessage, 'thinking' | 'search' | 'model'>>
): AssistantMessage => {
  const { thinking, search } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    // 记录创建时的模型：会话切到另一家服务商后，重新生成仍沿用本轮的选择
    model: getCurrentModel(),
    thinking,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
    ...overrides,
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
export const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

