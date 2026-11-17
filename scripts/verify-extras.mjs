#!/usr/bin/env node
/** 附件（Files API + image file_id）与联网搜索的真实验收。Key 只读环境变量。 */

const ORIGIN = 'https://api.deepseek.com'
const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  console.error('missing DEEPSEEK_API_KEY')
  process.exit(2)
}
const jsonHeaders = { 'x-api-key': key, 'Content-Type': 'application/json' }
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const readStream = async (res) => {
  let buffer = ''
  let text = ''
  let usage = null
  let tools = []
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
      if (event.type === 'content_block_start') tools.push(event.content_block?.type)
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') text += event.delta.text
      if (event.type === 'message_delta' && event.usage) usage = event.usage
    }
  }
  return { text, usage, tools }
}

const main = async () => {
  // 1. 上传图片
  const form = new FormData()
  form.append('file', new Blob([RED_PNG], { type: 'image/png' }), 'pixel.png')
  const up = await fetch(`${ORIGIN}/anthropic/v1/files`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-beta': 'files-api-2025-04-14' },
    body: form,
  })
  const file = up.ok ? await up.json() : null
  console.log(`[files] HTTP ${up.status} id=${file?.id ?? '(none)'} type=${file?.type ?? '?'}`)
  if (!file?.id) {
    console.log('[files] body:', (await up.text()).slice(0, 300))
    return
  }

  // 2. 用 file_id 引用图片
  const msg = await fetch(`${ORIGIN}/anthropic/v1/messages`, {
    method: 'POST',
    // 引用 file_id 的图片必须带 beta 头，与应用 client.ts 的 hasFile 逻辑一致
    headers: { ...jsonHeaders, 'anthropic-beta': 'files-api-2025-04-14' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      system: '你是测试助手，回答尽量短。',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'file', file_id: file.id } },
            { type: 'text', text: '这张图是什么颜色？只回答颜色。' },
          ],
        },
      ],
      thinking: { type: 'disabled' },
      max_tokens: 50,
      temperature: 0,
      tools: [],
      safety_check: { level: 'high' },
      stream: true,
    }),
  })
  if (!msg.ok) {
    console.log(`[image] HTTP ${msg.status}: ${(await msg.text()).slice(0, 300)}`)
  } else {
    const { text, usage } = await readStream(msg)
    console.log(`[image] text: ${text.trim().slice(0, 80) || '(empty)'}`)
    console.log(
      `[image] usage: input=${usage?.input_tokens ?? 0} read=${usage?.cache_read_input_tokens ?? 0} write=${usage?.cache_creation_input_tokens ?? 0} out=${usage?.output_tokens ?? 0}`
    )
  }

  // 3. 联网搜索工具
  const search = await fetch(`${ORIGIN}/anthropic/v1/messages`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      model: 'deepseek-flash',
      system: '你是测试助手。',
      messages: [{ role: 'user', content: '用一句话概括 DeepSeek 官网首页在介绍什么，并给出来源。' }],
      thinking: { type: 'disabled' },
      max_tokens: 300,
      temperature: 0.3,
      tools: [
        { type: 'deepseek_read_url', name: 'deepseek_read_url' },
        { type: 'deepseek_web_search', name: 'deepseek_web_search' },
      ],
      safety_check: { level: 'high' },
      stream: true,
    }),
  })
  if (!search.ok) {
    console.log(`[search] HTTP ${search.status}: ${(await search.text()).slice(0, 300)}`)
  } else {
    const { text, usage, tools } = await readStream(search)
    console.log(`[search] blocks: ${[...new Set(tools)].join(',')}`)
    console.log(`[search] web_search_requests=${usage?.server_tool_use?.web_search_requests ?? 0}`)
    console.log(`[search] text: ${text.trim().slice(0, 200) || '(empty)'}`)
  }
}

main().catch((e) => {
  console.error('failed:', e?.message ?? e)
  process.exit(1)
})
