#!/usr/bin/env node
/**
 * 抓取 https://api-docs.deepseek.com 全站（中文），落成本地 Markdown 语料。
 *
 * 用法：node scripts/crawl-docs.mjs [--base https://api-docs.deepseek.com] [--locale zh-cn]
 * 输出：_docs/api-docs/<locale>/<slug>.md 与 _docs/api-docs/index.json
 *
 * 只做静态抓取与正文抽取：不执行页面脚本，不登录，不改站点。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const BASE = arg('--base', 'https://api-docs.deepseek.com').replace(/\/$/, '')
const LOCALE = arg('--locale', 'zh-cn')
const OUT = path.resolve(process.cwd(), '..', '_docs', 'api-docs')

const decode = (value) =>
  value
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')

/** 去标签、压空白；保留行内代码内容 */
const textOf = (html) =>
  decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<svg[\s\S]*?<\/svg>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|pre|table|section|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** 表格转 Markdown 行，避免表格内容被压成一行 */
const tableOf = (html) => {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => textOf(cell[1]).replace(/\n/g, ' '))
  )
  if (rows.length === 0) {
    return ''
  }
  const header = rows[0]
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`]
  for (const row of rows.slice(1)) {
    lines.push(`| ${row.join(' | ')} |`)
  }
  return lines.join('\n')
}

/** 章节抽取：Docusaurus 的正文在 <article> 里 */
const extract = (html) => {
  const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
  const scope = article ? article[1] : html
  let body = scope
  // 代码块改成围栏代码，保住缩进与语言
  body = body.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    const code = decode(
      inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    ).replace(/^\n+/, '').replace(/\s+$/, '')
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`
  })
  // 表格单独渲染
  body = body.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner) => `\n\n${tableOf(inner)}\n\n`)
  // 标题
  body = body.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, inner) => `\n\n${'#'.repeat(Number(level))} ${textOf(inner)}\n\n`)
  // 列表项
  body = body.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `\n- ${textOf(inner).replace(/\n/g, ' ')}\n`)
  return textOf(body)
}

const fetchText = async (url) => {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) chat-demo-docs-crawler' },
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new Error(`${res.status} ${url}`)
  }
  return res.text()
}

const main = async () => {
  const sitemap = await fetchText(`${BASE}/sitemap.xml`)
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
  const paths = [...new Set(locs.map((loc) => new URL(loc).pathname.replace(/\/$/, '') || '/'))]
  console.log(`sitemap: ${locs.length} urls, ${paths.length} unique paths`)

  const dir = path.join(OUT, LOCALE)
  await mkdir(dir, { recursive: true })
  const index = []

  for (const p of paths) {
    const url = `${BASE}/${LOCALE}${p === '/' ? '' : p}/`
    try {
      const html = await fetchText(url)
      const title = textOf((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? ['', p])[1])
      const md = extract(html)
      const slug = p === '/' ? 'index' : p.replace(/^\//, '').replace(/\//g, '__')
      await writeFile(path.join(dir, `${slug}.md`), `# ${title}\n\n> ${url}\n\n${md}\n`, 'utf8')
      index.push({ path: p, url, title, slug, chars: md.length })
      console.log(`ok ${p} (${md.length} chars)`)
    } catch (error) {
      console.log(`fail ${p}: ${error.message}`)
      index.push({ path: p, url, error: error.message })
    }
    await new Promise((r) => setTimeout(r, 150))
  }

  await writeFile(
    path.join(OUT, 'index.json'),
    JSON.stringify({ base: BASE, locale: LOCALE, crawledAt: new Date().toISOString(), pages: index }, null, 2),
    'utf8'
  )
  const ok = index.filter((item) => !item.error).length
  console.log(`done: ${ok}/${index.length} pages`)
}

main().catch((error) => {
  console.error('crawl failed:', error)
  process.exit(1)
})
