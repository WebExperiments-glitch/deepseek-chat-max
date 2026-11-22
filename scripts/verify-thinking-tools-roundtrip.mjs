#!/usr/bin/env node
/**
 * 真实多轮验证：思考模式 + 联网工具下，历史助手消息「不回传 thinking 块」是否触发 400。
 *
 * 背景：官方文档两处要求——
 * - Chat Completions：携带 tools 的请求，历史轮次 reasoning_content 均应回传，否则 400；
 * - Anthropic Messages：思考模式下建议原样回传完整 content（含 thinking），遗漏时服务端
 *   可能按工具调用 ID 恢复，无法恢复时 400，「请勿依赖自动恢复」。
 *
 * demo 的 toAssistantParam 对历史轮次省略 thinking 块，只保留 read_link 工具块。
 * 本脚本用官方端点复现这一形态，验证服务端能否接受。Key 只从环境变量读取，不落盘。
 */
const ORIGIN = 'https://api.deepseek.com'
const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  console.error('missing DEEPSEEK_API_KEY')
  process.exit(2)
}

const HEADERS = { 'x-api-key': key, 'Content-Type': 'application/json' }
const TOOLS = [
  { type: 'deepseek_web_search', name: 'deepseek_web_search' },
  { type: 'deepseek_read_url', name: 'deepseek_read_url' },
]

/** 发一次非流式 Messages 请求，返回 { status, body } */
const call = async (messages) => {
  const res = await fetch(`${ORIGIN}/anthropic/v1/messages`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      model: 'deepseek-flash',
      max_tokens: 256,
      thinking: { type: 'enabled' },
      tools: TOOLS,
      messages,
      stream: false,
    }),
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  return { status: res.status, body }
}

const blockTypes = (content) =>
  Array.isArray(content) ? content.map((block) => block.type).join(',') : String(content)

// 第一轮：让模型用一次搜索
console.log('[turn-1] 发起带思考 + 联网工具的请求…')
const first = await call([
  { role: 'user', content: '请联网查一下 DeepSeek V4.1 的发布日期，一句话回答。' },
])
console.log(`[turn-1] HTTP ${first.status}  blocks=[${blockTypes(first.body?.content)}]`)
if (first.status !== 200) {
  console.log('[turn-1] 失败，终止:', JSON.stringify(first.body).slice(0, 400))
  process.exit(1)
}

// 按 demo 的行为构造历史助手消息：保留工具块与文本，丢弃 thinking 块
const firstAssistant = { role: 'assistant', content: [] }
for (const block of first.body.content ?? []) {
  if (block.type === 'thinking') continue
  if (block.type === 'server_tool_use' || block.type === 'web_search_tool_result' ||
      block.type === 'web_fetch_tool_result' || block.type === 'text') {
    firstAssistant.content.push(block)
  }
}
console.log(`[turn-2] 回传助手消息（去掉 thinking，保留 ${firstAssistant.content.length} 块: ${blockTypes(firstAssistant.content)}）…`)
const second = await call([
  { role: 'user', content: '请联网查一下 DeepSeek V4.1 的发布日期，一句话回答。' },
  firstAssistant,
  { role: 'user', content: '再确认一下，同上。' },
])

console.log(`[turn-2] HTTP ${second.status}`)
if (second.status === 200) {
  console.log('[turn-2] blocks=' + blockTypes(second.body?.content))
  console.log('PASS: 省略历史 thinking 块未触发 400（服务端可恢复或不需要）')
} else {
  console.log('[turn-2] 响应:', JSON.stringify(second.body).slice(0, 600))
  const msg = JSON.stringify(second.body)
  if (second.status === 400 && /thinking|reasoning|restore|content/i.test(msg)) {
    console.log('FAIL: 省略历史 thinking 块触发了 400 —— demo 需要回传 thinking 块')
  } else {
    console.log('INCONCLUSIVE: 400 但不是思考回传相关，需人工判读')
  }
}
