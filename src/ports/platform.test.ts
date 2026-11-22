import { afterEach, describe, expect, it } from 'vitest'
import { platform, setPlatform, webPlatform } from './platform.js'
import { shareLink } from '../services/shares.js'

describe('PlatformPort', () => {
  afterEach(() => setPlatform(webPlatform))

  it('setPlatform 替换实现，platform() 返回当前实现，可恢复默认', () => {
    const fake = { ...webPlatform, locationOrigin: () => 'https://ios.example' }
    setPlatform(fake)
    expect(platform().locationOrigin()).toBe('https://ios.example')
    setPlatform(webPlatform)
    expect(platform()).toBe(webPlatform)
  })

  it('服务层确实经由端口取平台能力（分享链接用注入的 origin）', () => {
    setPlatform({ ...webPlatform, locationOrigin: () => 'https://custom.host' })
    expect(shareLink('abc')).toBe('https://custom.host/share/abc')
  })

  it('默认 Web 实现在无 DOM 环境加载时不抛错（全局访问是惰性的）', () => {
    expect(() => platform()).not.toThrow()
    expect(typeof platform().bytesToBase64).toBe('function')
  })
})
