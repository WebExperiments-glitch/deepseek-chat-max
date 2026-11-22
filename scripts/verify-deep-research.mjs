#!/usr/bin/env node
/**
 * 验证官方原版智能搜索：服务端边想边搜（声明 deepseek_web_search 工具后，
 * 由 DeepSeek 自行决定搜几轮、读哪些网页）。统计响应里的服务端工具块数量。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/verify-deep-research.mjs
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/verify-deep-research.mjs "调研一下量子计算最新进展"
 */
const ORIGIN = process.env.DEEPSEEK_ORIGIN ?? 'https://api.deepseek.com'
const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  console.error('missing DEEPSEEK_API_KEY')
  process.exit(2)
}

const question =
  process.argv.slice(2).join(' ').trim() || '帮我调研一下量子计算的最新进展，并给出可靠来源。'

const res = await fetch(`${ORIGIN}/anthropic/v1/messages`, {
  method: 'POST',
  headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek-flash',
    max_tokens: 1024,
    thinking: { type: 'enabled' },
    tools: [
      { type: 'deepseek_web_search', name: 'deepseek_web_search' },
      { type: 'deepseek_read_url', name: 'deepseek_read_url' },
    ],
    system: '该助手为DeepSeek，由深度求索公司创造。',
    messages: [{ role: 'user', content: question }],
    stream: true,
  }),
})

if (!res.ok || !res.body) {
  console.error('HTTP', res.status, (await res.text()).slice(0, 300))
  process.exit(1)
}

const decoder = new TextDecoder()
let buffer = ''
let searches = 0
let reads = 0
let thinkingChunks = 0
let text = ''
let usage = null
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let evt
    try {
      evt = JSON.parse(data)
    } catch {
      continue
    }
    if (evt.type === 'content_block_start') {
      const b = evt.content_block
      if (b?.type === 'server_tool_use' && b.input?.action === 'search') searches += 1
      if (b?.type === 'server_tool_use' && b.input?.action === 'read_link') reads += 1
    }
    if (evt.type === 'content_block_delta') {
      if (evt.delta?.type === 'thinking_delta') thinkingChunks += 1
      if (evt.delta?.type === 'text_delta') text += evt.delta.text
    }
    if (evt.type === 'message_delta' && evt.usage) usage = evt.usage
  }
}

console.log(`问题: ${question}`)
console.log(`thinking 增量块: ${thinkingChunks}`)
console.log(`搜索调用块: ${searches}  阅读链接块: ${reads}`)
console.log('usage:', JSON.stringify(usage))
console.log('回答(前 400 字):', text.replace(/\s+/g, ' ').slice(0, 400))
console.log(`服务端自主判断：发起了 ${searches} 次搜索、${reads} 次阅读`)
