/**
 * 模型能力判断（纯 TS，零依赖，可单测、可移植）。
 *
 * 数据来自 models.dev / 服务商模型清单的 input_modalities（text/image/audio/video/pdf）。
 * 策略（对齐 HANDOFF「未知不猜测」）：
 * - 清单明确声明的模态为准；
 * - 未声明时视为「未知」，对图片/视频这类可能不被支持的模态采取保守策略（不支持），
 *   这样不会把视频/图片发给不支持的模型导致 API 报错；
 * - 文本永远支持（所有 chat 模型都能处理文本）。
 */

export type Modality = 'text' | 'image' | 'audio' | 'video' | 'pdf'

/** 从模型的输入模态列表判断能力。undefined = 未知 → 不支持多模态。 */
export const createCapabilities = (inputModalities?: readonly string[]) => {
  const set = new Set((inputModalities ?? []).map((m) => m.toLowerCase()))
  return {
    text: true, // 所有 chat 模型都支持文本
    image: set.has('image'),
    audio: set.has('audio'),
    video: set.has('video'),
    pdf: set.has('pdf'),
  }
}

export type ModelCapabilities = ReturnType<typeof createCapabilities>

/**
 * 一条附件的投递策略：
 * - 'native'   原样作为多模态块发送（模型支持该模态）
 * - 'ocr'      先转文字再喂给模型（模型不支持 image，但附件是可 OCR 的图片/文档）
 * - 'reject'   模型不支持且无法降级（如视频模型不支持、且无视频转文字能力）
 */
export type DeliveryPlan =
  | { kind: 'native'; modality: Modality }
  | { kind: 'ocr'; reason: 'no-image-capability' }
  | { kind: 'reject'; reason: 'no-video-capability' | 'unknown-modality' }

/** 附件类型 → 模态（用于和能力比对） */
export const attachmentModality = (mime: string): Modality | undefined => {
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) {
    return 'image'
  }
  if (m.startsWith('video/')) {
    return 'video'
  }
  if (m.startsWith('audio/')) {
    return 'audio'
  }
  if (m === 'application/pdf' || m.includes('officedocument') || m === 'application/msword') {
    return 'pdf'
  }
  return undefined // 纯文本等，无需模态能力
}

/**
 * 决定一条附件如何投递给指定能力的模型。
 * 规则（用户要求）：
 * - 视频：模型支持→native，不支持→reject（不给发送）
 * - 图片：模型支持→native，不支持→ocr（转文字再喂）
 * - 文档(pdf/office)：模型支持→native，不支持→ocr
 * - 文本/未知：native（无需能力）
 */
export const planDelivery = (
  caps: ModelCapabilities,
  mime: string,
  options: { ocrAvailable: boolean } = { ocrAvailable: true }
): DeliveryPlan => {
  const modality = attachmentModality(mime)
  if (!modality || modality === 'text') {
    return { kind: 'native', modality: 'text' }
  }
  const supported = caps[modality]
  if (supported) {
    return { kind: 'native', modality }
  }
  // 模型不支持该模态 → 看能否降级
  if (modality === 'video') {
    // 视频无 OCR 降级路径：直接拒绝
    return { kind: 'reject', reason: 'no-video-capability' }
  }
  // 图片/文档：OCR 降级
  if (options.ocrAvailable) {
    return { kind: 'ocr', reason: 'no-image-capability' }
  }
  return { kind: 'reject', reason: 'unknown-modality' }
}
