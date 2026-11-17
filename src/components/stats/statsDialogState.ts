import { create } from 'zustand'

/**
 * 会话统计弹窗。
 *
 * 只保存要查看的会话 id：统计数字每次打开时从会话缓存与上下文用量实时汇总，
 * 不额外持久化，避免出现和对话内容不一致的第二份数据。
 */
export const useStatsDialog = create<{ sessionId: string | null }>(() => ({ sessionId: null }))

export const openStatsDialog = (sessionId: string) => useStatsDialog.setState({ sessionId })

export const closeStatsDialog = () => useStatsDialog.setState({ sessionId: null })
