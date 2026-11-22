import { afterEach, describe, expect, it, vi } from 'vitest'

// providers.ts / client.ts 在求值期读取构建期常量
vi.stubGlobal('__API_ORIGIN__', 'https://api.deepseek.com')
vi.stubGlobal('__DEV_PROXY_PREFIX__', '')

const {
  searchWeb,
  fetchUrl,
  digestForQuestion,
  SEARCH_DIGEST_LABEL,
} = await import('./webSearch.js')

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response

afterEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('__API_ORIGIN__', 'https://api.deepseek.com')
  vi.stubGlobal('__DEV_PROXY_PREFIX__', '')
})

describe('searchWeb', () => {
  it('调用 /v1/tools/search 并映射结构化结果', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          {
            url: 'https://a.com',
            title: '标题 A',
            snippet: '摘要 A',
            content: '正文 A',
            site_name: '站点 A',
            date: '2026-01-01',
            rerank_score: 2.1,
            authority: 3,
          },
          { url: '', title: '无 URL' },
        ],
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const items = await searchWeb('k', '测试查询', { count: 5, needContent: true })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ url: 'https://a.com', title: '标题 A', content: '正文 A' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/v1/tools/search')
    expect(JSON.parse(init.body)).toEqual({ query: '测试查询', count: 5, need_content: true })
  })

  it('count 被夹在 1–50', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchWeb('k', 'q', { count: 999 })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).count).toBe(50)
    await searchWeb('k', 'q', { count: -3 })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).count).toBe(1)
  })

  it('need_content 缺省为 false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchWeb('k', 'q')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).need_content).toBe(false)
  })

  it('snippet 缺失时回落到 summary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ results: [{ url: 'https://a', summary: '长摘要' }] }))
    )
    const items = await searchWeb('k', 'q')
    expect(items[0].snippet).toBe('长摘要')
  })
})

describe('fetchUrl', () => {
  it('调用 /v1/tools/fetch 并返回标题与 Markdown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ title: '页面标题', content: '# 正文\n内容' })
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchUrl('k', 'https://example.com')
    expect(result).toEqual({ title: '页面标题', content: '# 正文\n内容' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/tools/fetch')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ url: 'https://example.com' })
  })

  it('字段缺失时用空串', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    expect(await fetchUrl('k', 'https://example.com')).toEqual({ title: '', content: '' })
  })
})

describe('digestForQuestion', () => {
  it('把搜索结果拼成带来源 URL 的摘编', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          results: [
            { url: 'https://a.com', title: 'A', content: '正文 A' },
            { url: 'https://b.com', title: 'B', snippet: '摘要 B' },
          ],
        })
      )
    )
    const digest = await digestForQuestion('k', '问题', new AbortController().signal)
    expect(digest.text).toContain('正文 A')
    expect(digest.text).toContain('摘要 B')
    expect(digest.text).toContain('URL: https://a.com')
    expect(digest.sources).toEqual([
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
    ])
    expect(SEARCH_DIGEST_LABEL).toContain('联网搜索')
  })

  it('无结果时抛错，让调用方降级', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ results: [] })))
    await expect(
      digestForQuestion('k', '问题', new AbortController().signal)
    ).rejects.toThrow()
  })
})
