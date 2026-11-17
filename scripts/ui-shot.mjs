#!/usr/bin/env node
/** 用 CDP 给本地页面拍一张截图：先注入 localStorage（API Key / 位置），再刷新。 */
import { writeFile } from 'node:fs/promises'

const PORT = process.argv[2] ?? '9334'
const OUT = process.argv[3] ?? 'C:/Users/30500/AppData/Local/Temp/ui-shot.png'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())

let targets = await list()
let page = targets.find((t) => t.type === 'page')
if (!page) {
  await fetch(`http://127.0.0.1:${PORT}/json/new?http://localhost:8090/`, { method: 'PUT' })
  await sleep(1500)
  targets = await list()
  page = targets.find((t) => t.type === 'page')
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const messageId = ++id
    pending.set(messageId, resolve)
    ws.send(JSON.stringify({ id: messageId, method, params }))
  })

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: 'http://localhost:8090/' })
await sleep(2500)
await send('Runtime.evaluate', {
  expression: `localStorage.setItem('chat-demo:api-keys', JSON.stringify({deepseek:'sk-test', 'opencode-go':null, 'opencode-zen':null, opendesign:null}));
  localStorage.setItem('chat-demo:location', JSON.stringify({region:'CN',province:'310000',city:'310100'}));`,
})
await send('Page.reload')
await sleep(4000)
const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(OUT, Buffer.from(shot.result.data, 'base64'))
console.log('saved', OUT)
ws.close()
