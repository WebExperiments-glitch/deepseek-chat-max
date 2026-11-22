import { useSettings } from '../settings.js'
import { getVisibleMessages } from './branches.js'
import type { AssistantMessage, Message, Session } from './types.js'

export type SessionExportFormat = 'markdown' | 'json' | 'html'

const pad = (value: number) => String(value).padStart(2, '0')

const stamp = (time: number) => {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

const fileNameStamp = (time: number) => {
  const date = new Date(time)
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

const labels = () =>
  useSettings.getState().locale === 'en-US'
    ? { user: 'You', assistant: 'DeepSeek', thinking: 'Thinking', files: 'Attachments' }
    : { user: '你', assistant: 'DeepSeek', thinking: '思维链', files: '附件' }

const answerText = (message: AssistantMessage): string =>
  message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

const thinkingText = (message: AssistantMessage): string =>
  message.blocks
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking)
    .join('\n\n')

const fileNames = (message: Message): string[] =>
  message.role === 'user' ? message.files.map((file) => file.name) : []

const toMarkdown = (session: Session): string => {
  const text = labels()
  const lines = [
    `# ${session.title || text.assistant}`,
    '',
    `> ${stamp(session.createdAt)} · ${session.messages.length} messages`,
    '',
  ]
  for (const message of getVisibleMessages(session)) {
    if (message.role === 'user') {
      lines.push(`## ${text.user}`, '')
      const files = fileNames(message)
      if (files.length > 0) {
        lines.push(`${text.files}: ${files.map((name) => `\`${name}\``).join(', ')}`, '')
      }
      if (message.content) {
        lines.push(message.content, '')
      }
      continue
    }
    lines.push(`## ${text.assistant}`, '')
    const thinking = thinkingText(message)
    if (thinking) {
      lines.push(`<details><summary>${text.thinking}</summary>`, '', thinking, '', '</details>', '')
    }
    const body = answerText(message)
    if (body) {
      lines.push(body, '')
    }
  }
  return lines.join('\n')
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const toHtml = (session: Session): string => {
  const text = labels()
  const messages = getVisibleMessages(session)
    .map((message) => {
      const role = message.role === 'user' ? 'user' : 'assistant'
      const name = message.role === 'user' ? text.user : text.assistant
      const files = fileNames(message)
      const fileList =
        files.length > 0
          ? `<div class="files">${text.files}: ${files.map(escapeHtml).join(', ')}</div>`
          : ''
      if (message.role === 'user') {
        return `<section class="message ${role}"><h2>${name}</h2>${fileList}<div class="body">${escapeHtml(
          message.content
        )}</div></section>`
      }
      const thinking = thinkingText(message)
      const thinkingBlock = thinking
        ? `<details><summary>${text.thinking}</summary><pre>${escapeHtml(thinking)}</pre></details>`
        : ''
      return `<section class="message ${role}"><h2>${name}</h2>${thinkingBlock}<div class="body">${escapeHtml(
        answerText(message)
      )}</div></section>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="${useSettings.getState().locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(session.title || text.assistant)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.7; color: #1f2329; background: #fff; }
  main { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 8px; }
  .meta { color: #8a919f; font-size: 13px; margin-bottom: 28px; }
  .message { margin: 0 0 28px; }
  .message h2 { font-size: 15px; margin: 0 0 8px; color: #4d6bfe; }
  .message.user h2 { color: #1f2329; }
  .body { white-space: pre-wrap; overflow-wrap: anywhere; }
  .message.user .body { padding: 12px 16px; border-radius: 14px; background: #f3f5f9; }
  .files { margin-bottom: 8px; color: #8a919f; font-size: 13px; }
  details { margin: 8px 0; padding: 8px 12px; border-radius: 10px; background: #f6f7fb; }
  summary { cursor: pointer; color: #8a919f; font-size: 13px; }
  details pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; font: inherit; color: #4b5563; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e8ee; background: #17181c; }
    .message.user h2 { color: #e6e8ee; }
    .message.user .body { background: #26272e; }
    details { background: #202127; }
    details pre { color: #aeb4c2; }
  }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(session.title || text.assistant)}</h1>
<div class="meta">${stamp(session.createdAt)} · ${session.messages.length} messages</div>
${messages}
</main>
</body>
</html>`
}

const sanitize = (value: string): string =>
  value
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'chat'

const download = (name: string, content: string, mime: string) => {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 导出当前分支可见消息：Markdown / 完整 JSON / 自包含 HTML */
export const exportSession = (session: Session, format: SessionExportFormat) => {
  const base = `${sanitize(session.title)}-${fileNameStamp(session.createdAt)}`
  if (format === 'markdown') {
    download(`${base}.md`, toMarkdown(session), 'text/markdown;charset=utf-8')
    return
  }
  if (format === 'json') {
    download(`${base}.json`, JSON.stringify(session, null, 2), 'application/json;charset=utf-8')
    return
  }
  download(`${base}.html`, toHtml(session), 'text/html;charset=utf-8')
}
