/**
 * HTTP 端口：全局可注入的 fetch 实现。
 *
 * 所有网络请求经此，而不是直接调全局 fetch——iOS 移植时只需 setHttp(URLSession 实现)。
 * 默认实现是浏览器 fetch（懒解析，避免非浏览器环境模块加载报错）。
 * 这是适配器边界：核心逻辑只认这个端口，不认平台 fetch。
 */

export type HttpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

let current: HttpFetch | null = null

const webFetch: HttpFetch = (input, init) => fetch(input, init)

/** 取当前 HTTP 实现（未注入时用浏览器 fetch） */
export const http: HttpFetch = (input, init) => (current ?? webFetch)(input, init)

/** 注入自定义实现（iOS: URLSession / RN: polyfill）。传 null 恢复默认。 */
export const setHttp = (impl: HttpFetch | null): void => {
  current = impl
}
