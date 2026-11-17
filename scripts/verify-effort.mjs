#!/usr/bin/env node
/** 验证 output_config.effort / metadata.user_id / 思考 token 明细。Key 只读环境变量。 */

const ORIGIN = 'https://api.deepseek.com'
const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  console.error('missing DEEPSEEK_API_KEY')
  process.exit(2)
}

const post = async (label, body) => {
  const res = await fetch(`${ORIGIN}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  })
  if (!res.ok) {
    console.log(`[${label}] HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    return
  }
  let buffer = ''
  let usage = null
  let text = ''
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString('utf8')
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') continue
      let event
      try {
        event = JSON.parse(raw)
      } catch {
        continue
      }
      if (event.type === 'message_start') usage = event.message?.usage ?? usage
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') text += event.delta.text
      if (event.type === 'message_delta' && event.usage) usage = event.usage
    }
  }
  console.log(`[${label}] ${JSON.stringify(usage)}`)
  console.log(`[${label}] text: ${text.trim().slice(0, 80) || '(empty)'}`)
}

await post('effort-max', {
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: '9.11 和 9.9 哪个大？只回答一个。' }],
  thinking: { type: 'enabled' },
  output_config: { effort: 'max' },
  metadata: { user_id: 'chat-demo-test' },
  max_tokens: 400,
})

await post('thinking-off', {
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: '只回答：好的' }],
  thinking: { type: 'disabled' },
  max_tokens: 50,
})
