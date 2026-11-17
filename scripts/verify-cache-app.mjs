#!/usr/bin/env node
/**
 * 复现应用的真实请求形态，验证「动态上下文放尾部」之后缓存能命中。
 * 同时验证一个边界：短 prompt 不足以形成缓存单元，需要足够长的稳定前缀。
 */
const ORIGIN = 'https://api.deepseek.com'
const key = process.env.DEEPSEEK_API_KEY
if (!key) { console.error('missing key'); process.exit(2) }

const padding = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 条：这是固定不变的背景说明，用于制造可命中的长前缀。`).join('\n')
const system = `该助手为DeepSeek，由深度求索公司创造。\n${padding}`
const reminder = '2026-11-17,星期二,上海市,Web,中文'

const call = async (messages, label) => {
  const res = await fetch(`${ORIGIN}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', system, messages, thinking: { type: 'disabled' }, max_tokens: 120, stream: true }),
  })
  if (!res.ok) { console.log(label, 'HTTP', res.status, (await res.text()).slice(0, 200)); return null }
  let buf = '', usage = null
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString('utf8')
    const parts = buf.split('\n\n'); buf = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') continue
      let e; try { e = JSON.parse(raw) } catch { continue }
      if (e.type === 'message_start') usage = e.message?.usage ?? usage
      if (e.type === 'message_delta' && e.usage) usage = e.usage
    }
  }
  console.log(label, JSON.stringify(usage))
  return usage
}

const tail = '当前时间：2026-11-17 13:40（星期二，时区 Asia/Shanghai）'
const first = await call([
  { role: 'latest_reminder', content: reminder },
  { role: 'user', content: `${tail}\n\n用一句话说明什么是提示词缓存。` },
], 'turn-1')

await new Promise((r) => setTimeout(r, 1500))

const answer = '提示词缓存是把重复前缀缓存起来复用，减少重复计算。'
const second = await call([
  { role: 'latest_reminder', content: reminder },
  { role: 'user', content: `${tail}\n\n用一句话说明什么是提示词缓存。` },
  { role: 'assistant', content: [{ type: 'text', text: answer }] },
  { role: 'latest_reminder', content: reminder },
  { role: 'user', content: '当前时间：2026-11-17 13:41（星期二，时区 Asia/Shanghai）\n\n再给一个更短的说法。' },
], 'turn-2')

if (second) {
  const prompt = (second.input_tokens ?? 0) + (second.cache_read_input_tokens ?? 0)
  const rate = prompt > 0 ? (((second.cache_read_input_tokens ?? 0) / prompt) * 100).toFixed(1) : '0'
  console.log(`turn-2 cache hit: ${rate}% (read ${second.cache_read_input_tokens ?? 0} / prompt ${prompt})`)
  console.log(rate !== '0.0' ? 'PASS: 动态尾部没有破坏前缀缓存' : 'FAIL: 仍然没有命中')
  console.log('first output tokens:', first?.output_tokens ?? '?')
}
