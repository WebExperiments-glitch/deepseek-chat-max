/**
 * 键值存储的平台层。
 *
 * 浏览器里用 localStorage；移植到 iOS / 原生容器时，只需要替换这一份实现
 * （例如换成 UserDefaults 或文件存储），业务代码不用改。
 * 存储不可用（隐私模式、配额耗尽）时静默降级，调用方不需要处理异常。
 */

export const readStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export const writeStorage = (key: string, value: string | null): void => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}
