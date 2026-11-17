#!/usr/bin/env node
/**
 * 真实链路验收脚本（不进入应用构建，不会被前端打包）。
 *
 * 用法：DEEPSEEK_API_KEY=sk-xxx node scripts/verify-api.mjs [--search]
 *
 * 验证四件事：
 * 1. GET /models 能用 x-api-key 通过，并给出 context_window；
 * 2. /anthropic/v1/messages 流式返回，usage 字段齐全；
 * 3. 同一段长前缀请求两次，第二次出现 cache_read_input_tokens（命中缓存）；
 * 4. 命中率按应用同一套规则格式化：部分命中不四舍五入成 100%。
 *
 * Key 只从环境变量读取，不落盘、不打印。
 */

const ORIGIN = 'https://api.deepseek.com'
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'
const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  console.error('missing DEEPSEEK_API_KEY')
  process.exit(2)
}

const headers = { 'x-api-key': key, 'Content-Type': 'application/json' }

/** 与应用 usageStats.formatCacheHitPercent 完全一致的算法 */
const formatCacheHitPercent = (cacheRead, prompt) => {
  if (prompt <= 0) return null
  if (cacheRead >= prompt) return '100'
  const one = ((cacheRead / prompt) * 100).toFixed(1)
  if (Number(one) < 99.95) return one
  const two = ((cacheRead / prompt) * 100).toFixed(2)
  return two === '100.00' ? '>99.99' : two
}

const usageLine = (usage) => {
  if (!usage) return 'usage: (none)'
  const input = usage.input_tokens ?? 0
  const read = usage.cache_read_input_tokens ?? 0
  const write = usage.cache_creation_input_tokens ?? 0
  const prompt = input + read + write
  const rate = formatCacheHitPercent(read, prompt)
  return [
    `usage: input=${input} cache_read=${read} cache_write=${write} output=${usage.output_tokens ?? 0}`,
    `prompt=${prompt} hit=${rate === null ? 'n/a' : rate + '%'} search=${usage.server_tool_use?.web_search_requests ?? 0}`,
  ].join(' | ')
}

/** 发一次流式请求，返回 { text, usage } */
const streamOnce = async (body, label) => {
  const res = await fetch(`${ORIGIN}/anthropic/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, stream: true }),
  })
  if (!res.ok) {
    console.log(`[${label}] HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return { text: '', usage: null }
  }
  let buffer = ''
  let text = ''
  let usage = null
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
  console.log(`[${label}] ${usageLine(usage)}`)
  console.log(`[${label}] text: ${text.trim().slice(0, 120) || '(empty)'}`)
  return { text, usage }
}

const main = async () => {
  const models = await fetch(`${ORIGIN}/models`, { headers })
  const modelBody = models.ok ? await models.json() : null
  console.log(`[models] HTTP ${models.status}`)
  for (const item of modelBody?.data ?? []) {
    console.log(`  - ${item.id}  context=${item.context_window ?? item.contextWindow ?? '?'}  max_out=${item.max_output_tokens ?? '?'}`)
  }

  // 一段足够长的稳定前缀，用来制造可命中的缓存
  const prefix = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 条：这是用于测试提示词缓存的长文本片段，内容固定不变。`).join('\n')
  const body = {
    model: MODEL,
    system: `你是测试助手，只回答一句话。\n${prefix}`,
    messages: [{ role: 'user', content: '用一句话说明什么是提示词缓存。' }],
    thinking: { type: 'disabled' },
    max_tokens: 200,
    temperature: 0.3,
    tools: process.argv.includes('--search') ? [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }] : [],
    safety_check: { level: 'high' },
  }

  const first = await streamOnce(body, 'call-1')
  await new Promise((r) => setTimeout(r, 1500))
  const second = await streamOnce(body, 'call-2')

  const u = second.usage
  if (u) {
    const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    const hit = formatCacheHitPercent(u.cache_read_input_tokens ?? 0, prompt)
    console.log(`[cache] second call hit=${hit === null ? 'n/a' : hit + '%'} (first text ${first.text.length} chars)`)
    if ((u.cache_read_input_tokens ?? 0) > 0) {
      console.log('[cache] PASS: 服务端确实上报了缓存命中')
    } else if ((u.cache_creation_input_tokens ?? 0) > 0) {
      console.log('[cache] PARTIAL: 只看到缓存写入，第二次请求可能还没命中，再跑一次即可')
    } else {
      console.log('[cache] NO-HIT: 本次没有命中；可能前缀太短或服务端未启用')
    }
  }
}

main().catch((error) => {
  console.error('verify failed:', error?.message ?? error)
  process.exit(1)
})
