import { create } from 'zustand'

/**
 * 右侧「代码预览」面板：与搜索面板并列的全局面板。
 * 同一代码块再次点击收起，换代码块时替换内容。
 */
type PreviewPanelState = {
  /** 预览标识（用代码块内容 hash 或位置），用于判断再次点击是否收起 */
  key: string | null
  /** 要运行的 HTML 代码 */
  code: string
  /** 展示用的语言名 */
  language: string
}

export const usePreviewPanel = create<PreviewPanelState>(() => ({
  key: null,
  code: '',
  language: '',
}))

/** 打开或收起预览面板 */
export const togglePreviewPanel = (key: string, code: string, language: string) =>
  usePreviewPanel.setState((state) =>
    state.key === key
      ? { key: null, code: '', language: '' }
      : { key, code, language }
  )

export const closePreviewPanel = () =>
  usePreviewPanel.setState({ key: null, code: '', language: '' })
