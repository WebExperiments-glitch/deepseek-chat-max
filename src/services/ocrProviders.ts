/**
 * OCR 引擎注册表（可插拔：用户/系统可按能力选择 OCR 实现）。
 *
 * 用途：当模型不支持某模态（如图片/文档）时，把附件转成文字再喂给模型。
 * 每家 OCR 实现同一接口；内置 DeepSeek OCR，未来可加第三方（本地模型、云 OCR）。
 * 零运行时依赖的注册表（动态 import 具体实现），与 UI 解耦。
 */
import type { OcrPurpose } from './api/ocr.js'

export type OcrProvider = {
  id: string
  name: string
  /** 是否需要 API Key（DeepSeek OCR 用 DeepSeek Key） */
  needsKey: boolean
  recognize: (
    key: string,
    blob: Blob,
    filename: string,
    purpose: OcrPurpose,
    signal?: AbortSignal
  ) => Promise<string>
}

/** DeepSeek 文档 OCR（内置默认） */
const deepseekOcr: OcrProvider = {
  id: 'deepseek',
  name: 'DeepSeek OCR',
  needsKey: true,
  recognize: async (key, blob, filename, purpose, signal) => {
    const { recognizeDocument } = await import('./api/ocr.js')
    return recognizeDocument(key, blob, filename, purpose, signal)
  },
}

export const OCR_PROVIDERS: OcrProvider[] = [deepseekOcr]
export const OCR_PROVIDER_IDS = OCR_PROVIDERS.map((p) => p.id)

export const getOcrProvider = (id: string): OcrProvider =>
  OCR_PROVIDERS.find((p) => p.id === id) ?? deepseekOcr
