/**
 * 平台端口（PlatformPort）—— 所有浏览器/平台 API 的唯一边界。
 *
 * 核心服务层不再直接引用 document / window / navigator / AudioContext / URL.createObjectURL
 * 等全局对象，而是调用这里的能力。默认实现是 Web（ guarded，Node 环境加载不报错），
 * iOS / 原生容器在组装根调用 setPlatform() 一次性替换全部实现即可。
 *
 * 与 HttpPort 同一模式：setter 注入 + 默认 Web 降级，核心零平台依赖。
 */

export type PlatformPort = {
  /** 把 blob 保存到用户可见位置（浏览器=触发下载；iOS=文件App/分享面板） */
  saveBlob(blob: Blob, filename: string): void
  /** 为 blob 建一个可展示的 URL（缩略图预览、代码预览 iframe） */
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
  canCreateObjectURL(): boolean
  /** 动画帧调度（流式刷新节流；非浏览器退化为定时器） */
  scheduleFrame(callback: () => void): number
  cancelFrame(handle: number): void
  /** 当前站点来源，用于生成分享链接 */
  locationOrigin(): string
  /** 系统语言（用于默认界面语言判断） */
  userLanguage(): string
  /** UA（代码预览做 Android 判断） */
  userAgent(): string
  /** 字节数组 → base64（附件内联，避免核心层依赖 btoa 全局） */
  bytesToBase64(bytes: Uint8Array): string
  /** 创建音频上下文（朗读 / 录音入口，Web Audio 图操作本身保持标准 API） */
  createAudioContext(sampleRate: number): AudioContext
  /** 申请麦克风权限（录音入口） */
  requestMicrophone(): Promise<MediaStream>
  /** 页面生命周期 */
  isPageHidden(): boolean
  onVisibilityChange(listener: () => void): () => void
  onPageHide(listener: () => void): () => void
  /** 监听 window message（代码预览 iframe 就绪信号） */
  onWindowMessage(listener: (event: MessageEvent) => void): () => void
}

/** 默认 Web 实现；所有全局访问都在使用时读取，模块导入阶段不触碰 DOM */
const webCreateObjectURL = (blob: Blob) => URL.createObjectURL(blob)
const webRevokeObjectURL = (url: string) => URL.revokeObjectURL(url)

const webPlatform: PlatformPort = {
  saveBlob(blob, filename) {
    const url = webCreateObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    setTimeout(() => webRevokeObjectURL(url), 10_000)
  },
  createObjectURL: webCreateObjectURL,
  revokeObjectURL: webRevokeObjectURL,
  canCreateObjectURL() {
    return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
  },
  scheduleFrame(callback) {
    return requestAnimationFrame(callback)
  },
  cancelFrame(handle) {
    cancelAnimationFrame(handle)
  },
  locationOrigin() {
    return window.location.origin
  },
  userLanguage() {
    return typeof navigator === 'undefined' ? '' : navigator.language
  },
  userAgent() {
    return typeof navigator === 'undefined' ? '' : navigator.userAgent
  },
  bytesToBase64(bytes) {
    // 分块转换，避免超长参数导致栈溢出
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
  },
  createAudioContext(sampleRate) {
    return new AudioContext({ sampleRate })
  },
  requestMicrophone() {
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
  },
  isPageHidden() {
    return document.hidden
  },
  onVisibilityChange(listener) {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
  onPageHide(listener) {
    window.addEventListener('pagehide', listener)
    return () => window.removeEventListener('pagehide', listener)
  },
  onWindowMessage(listener) {
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  },
}

let current: PlatformPort = webPlatform

/** 取当前平台实现 */
export const platform = (): PlatformPort => current

/** 注入自定义平台实现（iOS / 原生容器）；传 webPlatform 恢复默认 */
export const setPlatform = (impl: PlatformPort): void => {
  current = impl
}

export { webPlatform }
