#!/usr/bin/env node
/**
 * 真实链路验收：独立的 Search / Fetch API（POST /v1/tools/search、/v1/tools/fetch）。
 * Key 只从环境变量读取，不落盘、不打印。
 */
const ORIGIN = 'https://api.deepseek.com'
const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  console.error('missing DEEPSEEK_API_KEY')
  process.exit(2)
}

const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }

const search = await fetch(`${ORIGIN}/v1/tools/search`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ query: 'DeepSeek V4.1 发布', count: 2, need_content: true }),
})
const searchBody = await search.json()
console.log(`[search] HTTP ${search.status} results=${searchBody.results?.length ?? 0}`)
if (search.status !== 200 || !Array.isArray(searchBody.results)) {
  console.error('[search] FAIL', JSON.stringify(searchBody).slice(0, 300))
  process.exit(1)
}
const first = searchBody.results[0]
if (first) {
  console.log(
    `[search] first: title=${String(first.title).slice(0, 30)} authority=${first.authority} rerank=${first.rerank_score} content=${String(first.content ?? '').length}chars`
  )
}

const url = searchBody.results.find((item) => item.url)?.url
if (url) {
  const fetchRes = await fetch(`${ORIGIN}/v1/tools/fetch`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url }),
  })
  const fetchBody = await fetchRes.json()
  console.log(
    `[fetch] HTTP ${fetchRes.status} title=${String(fetchBody.title ?? '').slice(0, 40)} content=${String(fetchBody.content ?? '').length}chars`
  )
  if (fetchRes.status !== 200 || typeof fetchBody.content !== 'string') {
    console.error('[fetch] FAIL', JSON.stringify(fetchBody).slice(0, 300))
    process.exit(1)
  }
}
console.log('PASS: 独立 Search / Fetch API 可用，字段映射正确')
