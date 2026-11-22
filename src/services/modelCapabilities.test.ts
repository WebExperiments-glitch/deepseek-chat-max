import { describe, expect, it } from 'vitest'
import {
  attachmentModality,
  createCapabilities,
  planDelivery,
} from './modelCapabilities.js'

describe('createCapabilities', () => {
  it('从输入模态推导能力，未知视为不支持多模态', () => {
    expect(createCapabilities(['text', 'image'])).toEqual({
      text: true, image: true, audio: false, video: false, pdf: false,
    })
    expect(createCapabilities(undefined)).toEqual({
      text: true, image: false, audio: false, video: false, pdf: false,
    })
  })

  it('大小写不敏感', () => {
    expect(createCapabilities(['IMAGE', 'Video']).image).toBe(true)
    expect(createCapabilities(['IMAGE', 'Video']).video).toBe(true)
  })
})

describe('attachmentModality', () => {
  it('按 MIME 推导模态', () => {
    expect(attachmentModality('image/png')).toBe('image')
    expect(attachmentModality('video/mp4')).toBe('video')
    expect(attachmentModality('audio/wav')).toBe('audio')
    expect(attachmentModality('application/pdf')).toBe('pdf')
    expect(attachmentModality('text/plain')).toBeUndefined()
  })
})

describe('planDelivery', () => {
  it('模型支持视频→native，不支持→reject', () => {
    const noVideo = createCapabilities(['text', 'image'])
    const withVideo = createCapabilities(['text', 'video'])
    expect(planDelivery(noVideo, 'video/mp4')).toEqual({ kind: 'reject', reason: 'no-video-capability' })
    expect(planDelivery(withVideo, 'video/mp4')).toEqual({ kind: 'native', modality: 'video' })
  })

  it('模型支持图片→native，不支持→OCR 降级', () => {
    const withImage = createCapabilities(['text', 'image'])
    const noImage = createCapabilities(['text'])
    expect(planDelivery(withImage, 'image/png')).toEqual({ kind: 'native', modality: 'image' })
    expect(planDelivery(noImage, 'image/png')).toEqual({ kind: 'ocr', reason: 'no-image-capability' })
  })

  it('OCR 不可用时，图片不支持→reject', () => {
    const noImage = createCapabilities(['text'])
    expect(planDelivery(noImage, 'image/png', { ocrAvailable: false }))
      .toEqual({ kind: 'reject', reason: 'unknown-modality' })
  })

  it('文档无能力→OCR；文本无需能力→native', () => {
    const textOnly = createCapabilities(['text'])
    expect(planDelivery(textOnly, 'application/pdf')).toEqual({ kind: 'ocr', reason: 'no-image-capability' })
    expect(planDelivery(textOnly, 'text/plain')).toEqual({ kind: 'native', modality: 'text' })
  })
})
