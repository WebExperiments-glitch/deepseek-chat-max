/**
 * token 估算（仅用于注入预算，不参与计费）。
 *
 * 中文按字计、英文按 3.6 字符计，误差在 15% 以内；
 * 界面上展示的用量始终以服务端上报为准，这里只决定「记忆块能占多少额度」。
 */

const CJK =
  /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

export const estimateTokens = (text: string): number => {
  if (!text) {
    return 0
  }
  let cjk = 0
  for (const char of text) {
    if (CJK.test(char)) {
      cjk += 1
    }
  }
  const rest = text.length - cjk
  return Math.ceil(cjk + rest / 3.6)
}

/** 把 token 预算换算成可注入的字符量（保守取 2 字符/token） */
export const budgetToChars = (tokens: number): number => Math.max(200, tokens * 2)

/** 按字符预算截断文本，尽量保留完整句子 */
export const truncateToBudget = (text: string, tokenBudget: number): string => {
  const limit = budgetToChars(tokenBudget)
  if (text.length <= limit) {
    return text
  }
  const slice = text.slice(0, limit)
  const cut = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('\n'),
    slice.lastIndexOf('. ')
  )
  return `${cut > limit * 0.6 ? slice.slice(0, cut + 1) : slice}…`
}
