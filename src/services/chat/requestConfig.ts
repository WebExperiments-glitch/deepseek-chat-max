/**
 * 请求相关的纯配置与纯函数（零运行时依赖，可移植）。
 *
 * 从 store/state.ts 抽离——那里是 zustand 应用状态模块（含 db/reply/settings 依赖），
 * 压缩等核心算法只需要这些纯常量/纯函数，不该被拖进整个 store 依赖链。
 * 照搬 clientTools.ts 的拆环模式。
 */
import type { CreateMessageRequest } from '../api/types.js'

/** 未设置最大输出时，给压缩阈值预留的输出量（保守值，宁早压缩不晚压缩） */
export const DEFAULT_OUTPUT_RESERVE = 8192
/** 安全审核固定开启，所有请求都走扩展模式 */
export const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
export const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍 */
export const FILE_RETRY_BASE_DELAY = 1000

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
export const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}
