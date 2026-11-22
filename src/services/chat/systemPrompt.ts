/**
 * 系统提示词组装：只生产稳定的身份说明，逐轮变化的动态内容一律不进这里。
 *
 * 摘要 / 记忆 / 当前时间由调用方放进本轮 user 消息的 requestContext，
 * 系统提示词必须逐字不变，服务端的提示词缓存才能命中。组装是纯函数，方便移植。
 */

/** 官方角色设定：与 DeepSeek 官方示例一致 */
export const OFFICIAL_SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

/**
 * 填了自定义提示词就整段替换官方身份说明；否则用官方身份说明。
 * 不接收摘要参数：压缩摘要属于动态内容，放在本轮提问末尾，不写进 system。
 */
export const composeSystemPrompt = (custom: string | null): string =>
  custom && custom.trim() !== '' ? custom.trim() : OFFICIAL_SYSTEM_PROMPT
