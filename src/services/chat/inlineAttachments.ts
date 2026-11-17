import type { ImageDetail, InlineAttachment, SkippedAttachment } from '../api/toOpenAi.js'
import type { FileAttachment } from './types.js'
import { loadFile } from './db.js'
import { recognizeDocument } from '../api/ocr.js'

/**
 * 把附件读成可以内联进 OpenAI 请求的内容：
 * 图片转 data URL，纯文本类文件读成正文，其余（PDF、Word、表格等二进制文档）无法内联。
 * 与 DeepSeek 的 Files API 无关，直接使用本地原件。
 */

/** 允许内联为文本的扩展名；与 uploadExts 的白名单取交集后使用 */
const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'ps1',
  'bat',
  'sql',
  'vue',
  'svelte',
  'qml',
  'qss',
  'wxml',
  'wxss',
  'axml',
  'acss',
  'log',
])

/**
 * 图像理解的限制（对齐文档）：
 * - 内联单图 32 MiB；
 * - 不含 file_id 的图片合计 64 MiB，但整个请求体上限 48 MiB（base64 会膨胀 4/3），
 *   因此这里按 base64 字符数守住 48 MiB 的总闸。
 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_INLINE_DATA_CHARS = 48 * 1024 * 1024
const MIB = 1024 * 1024
/** 可以交给 OCR 的文档扩展名（其余二进制仍按跳过处理） */
const OCR_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])
/** 文档上传上限 100 MiB */
const MAX_DOCUMENT_BYTES = 100 * MIB

const extOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 无法内联的附件提示：与上传配额提示一样，由界面层转成 toast */
export type InlineNotice = { names: string[] }
const noticeListeners = new Set<(notice: InlineNotice) => void>()

/** 订阅「附件无法随当前服务商发送」的提示，由界面层转成 toast */
export const onInlineNotice = (listener: (notice: InlineNotice) => void) => {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

/** 通知所有订阅者；没有订阅者时静默丢弃 */
export const notifyInlineNotice = (notice: InlineNotice) => {
  for (const listener of noticeListeners) {
    listener(notice)
  }
}

/** 去重后最多列三个文件名，其余用数量概括 */
export const describeSkippedNames = (names: string[]): InlineNotice => {
  const unique = [...new Set(names)]
  return {
    names: unique.slice(0, 3).concat(unique.length > 3 ? [`+${unique.length - 3}`] : []),
  }
}

const toDataUrl = (blob: Blob, mimeType: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    // 有些附件在 IndexedDB 里没有 MIME，按图片类别补一个默认值
    reader.readAsDataURL(new Blob([blob], { type: mimeType || blob.type || 'image/png' }))
  })

export type InlineOptions = {
  /** 图片细节级别，透传给 image_url.detail（file_id 引用时服务端忽略） */
  detail?: ImageDetail
  /** 有 DeepSeek Key 时，PDF / Word / PPT 先走 OCR 转文本，而不是直接跳过 */
  ocrKey?: string
  signal?: AbortSignal
}

/**
 * 解析一组附件。本地没有原件、体积超限或 OCR 失败的按跳过处理，
 * 由调用方提示「这些附件未进入本次请求」。
 */
export const inlineAttachments = async (
  files: FileAttachment[],
  options: InlineOptions = {}
): Promise<{ inline: InlineAttachment[]; skipped: SkippedAttachment[] }> => {
  const inline: InlineAttachment[] = []
  const skipped: SkippedAttachment[] = []
  let dataChars = 0
  for (const file of files) {
    const ext = extOf(file.name)
    const isText = !file.isImage && TEXT_EXTS.has(ext)
    const canOcr = !file.isImage && !isText && OCR_EXTS.has(ext) && !!options.ocrKey
    if (!file.isImage && !isText && !canOcr) {
      skipped.push({ name: file.name })
      continue
    }
    if (file.isImage && file.size > MAX_IMAGE_BYTES) {
      skipped.push({ name: file.name })
      continue
    }
    if (!file.isImage && file.size > MAX_DOCUMENT_BYTES) {
      skipped.push({ name: file.name })
      continue
    }
    const blob = await loadFile(file.id)
    if (!blob) {
      skipped.push({ name: file.name })
      continue
    }
    if (file.isImage) {
      const dataUrl = await toDataUrl(blob, file.mimeType || blob.type)
      // 守 48 MiB 请求体：已经装下的继续，装不下的跳过并在提示里点名
      if (dataChars + dataUrl.length > MAX_INLINE_DATA_CHARS) {
        skipped.push({ name: file.name })
        continue
      }
      dataChars += dataUrl.length
      inline.push({
        kind: 'image',
        name: file.name,
        dataUrl,
        ...(options.detail ? { detail: options.detail } : {}),
      })
    } else if (isText) {
      inline.push({ kind: 'text', name: file.name, text: await blob.text() })
    } else if (canOcr && options.ocrKey) {
      try {
        const text = await recognizeDocument(
          options.ocrKey,
          blob,
          file.name,
          'text_recognition',
          options.signal
        )
        if (text.trim() === '') {
          skipped.push({ name: file.name })
        } else {
          inline.push({ kind: 'text', name: file.name, text, source: 'ocr' })
        }
      } catch {
        // OCR 失败不影响主请求，按未进入请求处理
        skipped.push({ name: file.name })
      }
    }
  }
  return { inline, skipped }
}
