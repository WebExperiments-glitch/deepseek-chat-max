/**
 * 端口层（ports）—— 极致解耦的核心。
 *
 * 这里只定义纯接口，零实现、零依赖、零平台 API。核心逻辑(domain/application)只依赖这些端口，
 * 具体实现由 adapters 层提供，在 composition root(bootstrap) 注入。
 *
 * 每个能力都像"插件"一样：实现对应端口即可插入/替换，核心不认任何具体实现。
 * 与 DSH 不同：这里没有 agent 工具循环、没有运行时 npm 安装、没有模型驱动的插件调用——
 * 只是编译期的依赖倒置，核心与平台/UI/框架完全隔离。
 */

/** HTTP 端口的实现与注入见 ./http.ts；这里只保留类型别名供需要的地方引用 */
export type Http = (url: string, init?: RequestInit) => Promise<Response>

/** 键值存储端口：platform/storage.ts 的抽象，可换 UserDefaults */
export type KeyValueStore = {
  read(key: string): string | null
  write(key: string, value: string | null): void
}

/** 当前时间端口：便于确定性测试与跨端一致 */
export type Clock = () => number

/** 用户提示端口：替代核心层直接 import UI 的 showToast */
export type ToastPort = {
  info(message: string): void
  error(message: string): void
}

/** 国际化提示端口：核心层发出翻译键，由 adapter 负责展示（不依赖 UI/i18n 实现） */
export type NotifyPort = (message: {
  key: string
  params?: Record<string, string | number>
}) => void

/** 语言端口：i18n 不再读全局 store，由外部注入当前 locale */
export type LocalePort = {
  get(): string
  subscribe(listener: (locale: string) => void): () => void
}

/** 页面生命周期端口：替代 store 里直接用 document/window 事件 */
export type PageLifecyclePort = {
  isHidden(): boolean
  onHidden(listener: () => void): () => void
  onHide(listener: () => void): () => void
}

/**
 * 能力插件通用契约：每个可插拔能力（搜索商/语音引擎/模型源/场景）实现它。
 * 核心只通过注册表按 id 找到插件，调用其端口方法，不 import 具体实现。
 */
export type CapabilityPlugin<Id = string> = {
  readonly id: Id
  readonly name: string
  readonly capabilities?: Readonly<Record<string, boolean>>
}
