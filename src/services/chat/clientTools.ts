/**
 * 用户自定义工具（设置里的 tools JSON）的解析与协议转换。
 *
 * 独立成模块，避免请求组装（stream）与会话压缩（compression）互相 import：
 * 压缩摘要要重放与对话完全一致的工具声明，才能复用提供方的前缀缓存。
 */

/** 设置里的工具定义：OpenAI chat/completions 的 function 形状 */
export type ClientTool = {
  type: 'function'
  function: { name: string; description?: string; parameters?: unknown }
}

export const parseClientTools = (raw: string): ClientTool[] => {
  const value = raw.trim()
  if (!value) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (item): item is ClientTool =>
        typeof item === 'object' &&
        item !== null &&
        (item as ClientTool).type === 'function' &&
        typeof (item as ClientTool).function?.name === 'string'
    )
  } catch {
    return []
  }
}

/** Anthropic Messages：input_schema 承载参数定义 */
export const toAnthropicTools = (tools: ClientTool[]) =>
  tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
  }))

/** OpenAI Responses：扁平的 function 定义 */
export const toResponsesTools = (tools: ClientTool[]) =>
  tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    parameters: tool.function.parameters ?? { type: 'object', properties: {} },
  }))
