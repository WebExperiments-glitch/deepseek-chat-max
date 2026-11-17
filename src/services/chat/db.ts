import {
  deleteJson,
  getBlob,
  getJson,
  getJsonOptional,
  patchJson,
  postJson,
  putBlob,
  putJson,
} from '../api/localServer.js'
import type { Session, SessionSummary } from './types.js'

/**
 * 会话与附件的本地存储。
 *
 * 数据由本机 Node 服务写入 SQLite，浏览器只负责通过 /api 读写。
 * 会话正文保持 JSON（分支树与消息块顺序由上层维护），服务端只存不解析；
 * 附件以原始字节单独上传，避免把大文件塞进会话 JSON。
 */
export type StoredFile = {
  id: string
  blob: Blob
}

const filePath = (id: string, staging = false) =>
  `/api/files/${encodeURIComponent(id)}${staging ? '?staging=1' : ''}`

const uploadFiles = async (files: StoredFile[], staging = false): Promise<void> => {
  await Promise.all(files.map((file) => putBlob(filePath(file.id, staging), file.blob)))
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const { sessions } = await getJson<{ sessions: SessionSummary[] }>('/api/sessions')
  return sessions
}

export const loadSession = async (id: string): Promise<Session | undefined> =>
  getJsonOptional<Session>(`/api/sessions/${encodeURIComponent(id)}`)

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  await uploadFiles(files)
  await putJson(`/api/sessions/${encodeURIComponent(session.id)}`, { session })
}

/** 未打开的会话也可重命名，只更新标题列与会话 JSON。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  await patchJson(`/api/sessions/${encodeURIComponent(id)}`, { title })
}

/** 置顶只改列表排序，不触碰会话正文 */
export const setSessionPinned = async (id: string, pinned: boolean): Promise<void> => {
  await patchJson(`/api/sessions/${encodeURIComponent(id)}`, { pinned })
}

/** 删除会话，服务端会清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  await deleteJson(`/api/sessions/${encodeURIComponent(sessionId)}`)
}

export const saveFiles = (files: StoredFile[]): Promise<void> => uploadFiles(files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  getBlob(filePath(id))

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  await postJson('/api/staging/clear', {})
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await putJson(`/api/staging/sessions/${encodeURIComponent(session.id)}`, { session })
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  uploadFiles(files, true)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  await postJson('/api/staging/types', { types: [...types] })
}

/**
 * 导入完成后用暂存替换正式数据：服务端在同一事务中替换会话与原件，并清空暂存。
 * 返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const { sessions } = await postJson<{ sessions: SessionSummary[] }>('/api/staging/commit', {})
  return sessions
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
