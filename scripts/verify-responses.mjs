#!/usr/bin/env node
/** 验证 POST /responses 的流式事件与 usage 结构。Key 只读环境变量。 */

const ORIGIN = 'https://api.deepseek.com'
const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  console.error('missing DEEPSEEK_API_KEY')
  process.exit(2)
}

const res = await fetch(`${ORIGIN}/responses`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  },
  body: JSON.stringify({
    model: 'deepseek-flash',
    instructions: '你是测试助手，回答简短。',
    input: '用一句话说明 Responses API 与 Chat Completions 的区别。',
    reasoning: { effort: 'high' },
    safety_check: { level: 'high' },
    title: { enabled: true },
    user: 'chat-demo-test',
    stream: true,
    max_output_tokens: 400,
  }),
})

if (!res.ok) {
  console.log('HTTP', res.status, (await res.text()).slice(0, 300))
  process.exit(1)
}

let buffer = ''
const counts = new Map()
let text = ''
let reasoning = ''
let final = null
for await (const chunk of res.body) {
  buffer += Buffer.from(chunk).toString('utf8')
  const parts = buffer.split('\n\n')
  buffer = parts.pop() ?? ''
  for (const part of parts) {
    const lines = part.split('\n')
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? ''
    const dataLine = lines.find((line) => line.startsWith('data:'))
    if (!dataLine) continue
    let payload
    try {
      payload = JSON.parse(dataLine.slice(5).trim())
    } catch {
      continue
    }
    const type = payload.type || event
    counts.set(type, (counts.get(type) ?? 0) + 1)
    if (type === 'response.reasoning_text.delta') reasoning += payload.delta ?? ''
    if (type === 'response.output_text.delta') text += payload.delta ?? ''
    if (type === 'response.completed' || type === 'response.incomplete') final = payload.response
  }
}

console.log('events:', [...counts.entries()].map(([k, v]) => `${k}×${v}`).join(', '))
console.log('reasoning chars:', reasoning.length)
console.log('text:', text.trim().slice(0, 120))
console.log('title:', final?.title ?? '(none)')
console.log('status:', final?.status, 'usage:', JSON.stringify(final?.usage ?? null))
