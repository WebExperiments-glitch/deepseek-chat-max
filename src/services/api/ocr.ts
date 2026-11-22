import { DEEPSEEK_ORIGIN } from './providers.js'
import { http } from '../../ports/http.js'

/**
 * 文档 OCR：POST /v1/tools/ocr（multipart）。
 *
 * 用途：当前对话服务商不是 DeepSeek 时，PDF / Word / PPT 无法用 file_id 交给模型，
 * 先用 DeepSeek 的 OCR 把内容转成文本，再内联进请求。文件不会存入 Files API。
 * purpose：
 * - text_recognition（默认）：不含图片的 Word/PPT 直接提取文字，其余逐页识别；
 * - rich_layout_recognition：所有文件逐页识别，适合版式重要的文档。
 */

export type OcrPurpose = 'text_recognition' | 'rich_layout_recognition'

type OcrResponse = {
  page_count?: number
  pages?: { index: number; text: string; finish_reason?: string }[]
}

/** 单页输出的最大字符数，避免一页表格把上下文吃满 */
const MAX_PAGE_CHARS = 20_000

export const recognizeDocument = async (
  apiKey: string,
  blob: Blob,
  filename: string,
  purpose: OcrPurpose = 'text_recognition',
  signal?: AbortSignal
): Promise<string> => {
  const form = new FormData()
  form.append('purpose', purpose)
  form.append('file', blob, filename)
  const response = await http(`${DEEPSEEK_ORIGIN}/v1/tools/ocr`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  })
  if (!response.ok) {
    throw new Error(`OCR failed: HTTP ${response.status}`)
  }
  const body = (await response.json()) as OcrResponse
  return (body.pages ?? [])
    .map((page) => {
      const text = page.text ?? ''
      return text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n…（本页已截断）` : text
    })
    .filter((text) => text.trim() !== '')
    .join('\n\n')
}
