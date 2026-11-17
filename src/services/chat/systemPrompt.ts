/**
 * 系统提示词组装。
 *
 * 只保留产品需要的部分：官方身份说明 + 用户自定义提示词 + 可选的较早对话摘要。
 * 组装结果是一次请求的纯输入，不读写状态，方便移植。
 */

/** 官方角色设定：与 DeepSeek 官方示例一致 */
export const OFFICIAL_SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

/**
 * 组装本次请求的系统提示词：
 * - 填了自定义提示词就整段替换官方身份说明；
 * - 压缩摘要（若有）始终追加在末尾，作为「较早对话」的上下文，而不是伪造一轮对话。
 */
export const composeSystemPrompt = (custom: string | null, summarySection = ''): string => {
  const base = custom && custom.trim() !== '' ? custom.trim() : OFFICIAL_SYSTEM_PROMPT
  return summarySection === '' ? base : `${base}\n\n${summarySection}`
}
