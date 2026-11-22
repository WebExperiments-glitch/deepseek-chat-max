import { describe, it, expect, vi } from 'vitest'

// client.ts / providers.ts 在求值期读取构建期常量，先桩后导入
vi.stubGlobal('__API_ORIGIN__', 'https://api.deepseek.com')
vi.stubGlobal('__DEV_PROXY_PREFIX__', '')

const { ApiError } = await import('./client.js')
const {
  classifyStatus,
  classifyApiError,
  isRetryableApiError,
  isContextOverflowError,
  getFileErrorCode,
  extractFileIds,
  getUploadErrorInfo,
} = await import('./errors.js')

describe('classifyStatus 状态码分类', () => {
  it('映射鉴权/余额/体积/限流/参数状态码', () => {
    expect(classifyStatus(401)).toBe('unauthorized')
    expect(classifyStatus(402)).toBe('insufficientBalance')
    expect(classifyStatus(413)).toBe('tooLarge')
    expect(classifyStatus(429)).toBe('rateLimited')
    expect(classifyStatus(400)).toBe('invalidRequest')
    expect(classifyStatus(422)).toBe('invalidRequest')
  })

  it('5xx 与 408 归为 serverBusy', () => {
    for (const status of [408, 500, 502, 503, 504, 599]) {
      expect(classifyStatus(status)).toBe('serverBusy')
    }
  })

  it('其他状态与缺省归为 other', () => {
    expect(classifyStatus(200)).toBe('other')
    expect(classifyStatus(404)).toBe('other')
    expect(classifyStatus(undefined)).toBe('other')
  })
})

describe('classifyApiError 错误分类', () => {
  it('非 ApiError 一律归为 other', () => {
    expect(classifyApiError(new Error('boom'))).toBe('other')
    expect(classifyApiError('401')).toBe('other')
    expect(classifyApiError(undefined)).toBe('other')
  })

  it('cors 类别优先返回 cors', () => {
    expect(classifyApiError(new ApiError('cors', 'https://example.com'))).toBe('cors')
  })

  it('无状态码时按 kind 区分 network 与 other', () => {
    expect(classifyApiError(new ApiError('network', 'offline'))).toBe('network')
    expect(classifyApiError(new ApiError('stream', 'oops'))).toBe('other')
    expect(classifyApiError(new ApiError('interrupted', ''))).toBe('other')
    expect(classifyApiError(new ApiError('protocol', 'bad response'))).toBe('other')
  })

  it('带状态码时按状态码分类', () => {
    expect(classifyApiError(new ApiError('http', 'no auth', 401))).toBe('unauthorized')
    expect(classifyApiError(new ApiError('http', 'busy', 503))).toBe('serverBusy')
    expect(classifyApiError(new ApiError('http', 'bad', 400))).toBe('invalidRequest')
  })
})

describe('isRetryableApiError 可重试判断', () => {
  it('非 ApiError 默认可重试', () => {
    expect(isRetryableApiError(new Error('x'))).toBe(true)
    expect(isRetryableApiError(null)).toBe(true)
  })

  it('network / rateLimited / serverBusy 可重试', () => {
    expect(isRetryableApiError(new ApiError('network', 'x'))).toBe(true)
    expect(isRetryableApiError(new ApiError('http', 'x', 429))).toBe(true)
    expect(isRetryableApiError(new ApiError('http', 'x', 500))).toBe(true)
  })

  it('鉴权/余额/体积/参数/CORS 不可重试', () => {
    expect(isRetryableApiError(new ApiError('http', 'x', 401))).toBe(false)
    expect(isRetryableApiError(new ApiError('http', 'x', 402))).toBe(false)
    expect(isRetryableApiError(new ApiError('http', 'x', 413))).toBe(false)
    expect(isRetryableApiError(new ApiError('http', 'x', 400))).toBe(false)
    expect(isRetryableApiError(new ApiError('cors', 'x'))).toBe(false)
  })
})

describe('附件 file_id 失效识别', () => {
  it('getFileErrorCode 识别三类附件失效文案', () => {
    expect(
      getFileErrorCode(
        new ApiError('http', 'file_ids do not exist or are not created under your account', 400)
      )
    ).toBe('fileIdMissing')
    expect(
      getFileErrorCode(new ApiError('http', 'file data not found for file_id file-api-123', 400))
    ).toBe('fileDataMissing')
    expect(getFileErrorCode(new ApiError('http', '.source.file_id: invalid file_id', 400))).toBe(
      'invalidFileId'
    )
  })

  it('getFileErrorCode 只处理 400 且文案匹配的错误', () => {
    expect(
      getFileErrorCode(
        new ApiError('http', 'file_ids do not exist or are not created under your account', 403)
      )
    ).toBeNull()
    expect(getFileErrorCode(new ApiError('http', 'random error', 400))).toBeNull()
    expect(getFileErrorCode(new Error('file data not found for file_id'))).toBeNull()
    expect(getFileErrorCode(undefined)).toBeNull()
  })

  it('extractFileIds 提取并去重服务端 file_id', () => {
    expect(extractFileIds('file-api-abc and file-api-abc, file-api-x_y-1')).toEqual([
      'file-api-abc',
      'file-api-x_y-1',
    ])
    expect(extractFileIds('nothing here')).toEqual([])
    expect(extractFileIds('')).toEqual([])
  })
})

describe('上传错误识别', () => {
  it('getUploadErrorInfo 识别数量与容量上限', () => {
    expect(
      getUploadErrorInfo(new ApiError('http', 'User file count limit exceeded, limit 50', 400))
    ).toEqual({ code: 'fileCountLimit', limit: '50' })
    expect(
      getUploadErrorInfo(new ApiError('http', 'User storage quota exceeded, limit 2.5 GB', 400))
    ).toEqual({ code: 'storageLimit', limit: '2.5' })
  })

  it('getUploadErrorInfo 识别文件解析失败', () => {
    const messages = [
      'You have uploaded an unsupported file',
      'You have uploaded an invalid image',
      'The image is too large to process',
      'This document is password-protected',
      'Failed to recognize the file',
    ]
    for (const message of messages) {
      expect(getUploadErrorInfo(new ApiError('http', message, 400))).toEqual({
        code: 'parseFailed',
      })
    }
  })

  it('getUploadErrorInfo 非 400 或未匹配文案返回 null', () => {
    expect(
      getUploadErrorInfo(new ApiError('http', 'User file count limit exceeded, limit 50', 429))
    ).toBeNull()
    expect(getUploadErrorInfo(new ApiError('http', 'some 400 error', 400))).toBeNull()
    expect(getUploadErrorInfo(new Error('User storage quota exceeded, limit 2 GB'))).toBeNull()
  })
})

describe('isContextOverflowError', () => {
  it('识别各家服务的上下文溢出文案', () => {
    const messages = [
      "This model's maximum context length is 128000 tokens. However, you requested 130000 tokens",
      'context_length_exceeded',
      'Your request exceeds the context window of this model',
      'Input is too long',
      'maximum context window reached',
    ]
    for (const message of messages) {
      expect(isContextOverflowError(new ApiError('http', message, 400))).toBe(true)
    }
    expect(isContextOverflowError(new ApiError('http', 'context length exceeded', 422))).toBe(true)
  })

  it('普通 400/422 不算溢出', () => {
    expect(isContextOverflowError(new ApiError('http', 'invalid api key', 400))).toBe(false)
    expect(isContextOverflowError(new ApiError('http', 'bad request', 422))).toBe(false)
  })

  it('其他状态码与非 ApiError 不算溢出', () => {
    expect(isContextOverflowError(new ApiError('http', 'context length exceeded', 429))).toBe(false)
    expect(isContextOverflowError(new Error('context length exceeded'))).toBe(false)
  })
})
