#!/usr/bin/env node
/** 用 CDP 打开页面并打印控制台错误与未捕获异常（用于排查启动卡住）。 */
const PORT = process.argv[2] ?? '9336'
const URL_TO_OPEN = process.argv[3] ?? 'http://localhost:8090/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    console.log('EXCEPTION:', d.exception?.description ?? d.text)
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    console.log('CONSOLE', msg.params.type + ':', msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400))
  }
  if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) {
    console.log('LOG', msg.params.entry.level + ':', msg.params.entry.text.slice(0, 300))
  }
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const send = (method, params = {}) => new Promise((resolve) => {
  const messageId = ++id
  pending.set(messageId, resolve)
  ws.send(JSON.stringify({ id: messageId, method, params }))
})
await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.navigate', { url: URL_TO_OPEN })
await sleep(10000)
const body = await send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0, 300)', returnByValue: true })
console.log('BODY:', JSON.stringify(body.result?.result?.value ?? ''))
ws.close()
