import { create } from 'zustand'

/** 全局搜索弹窗：侧栏入口与 Ctrl/⌘+K 共用 */
export const useSearchDialog = create(() => ({ open: false }))

export const openSearchDialog = () => useSearchDialog.setState({ open: true })

export const closeSearchDialog = () => useSearchDialog.setState({ open: false })
