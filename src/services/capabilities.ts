/**
 * 能力注册中心（capability registry）——借鉴 DSH 的"单一扩展面 + 可逆注册"，轻量纯 TS 实现。
 *
 * 三角色 seam：
 *   Definition = 端口接口（ports/ 与各能力的 Provider 类型）
 *   Provider   = 具体实现（SEARCH_PROVIDERS / SPEECH_PROVIDERS / PROVIDERS ...）
 *   Consumer   = 只经本注册中心按 id 取，不 import 具体实现
 *
 * 可逆注册：register 返回 disposer；切换/卸载时逆序回滚、幂等（借鉴 DSH fiber effect）。
 * 对无活资源的静态 provider，dispose 是空操作；对有连接/watcher 的未来 provider，
 * 可在 dispose 里释放。这样"切换能力不损坏功能"由所有权保证，不靠记得手动清理。
 */

export type Disposer = () => void

export type CapabilityEntry<T> = {
  id: string
  value: T
  /** 该注册拥有的资源释放函数（可选） */
  dispose?: Disposer
}

/**
 * 通用能力注册表。一个实例管理一类能力（搜索商 / 语音引擎 / 模型源 ...）。
 * 纯 TS，无平台依赖，可单测、可移植。
 */
export class CapabilityRegistry<T> {
  private readonly entries = new Map<string, CapabilityEntry<T>>()
  private readonly listeners = new Set<() => void>()
  private activeId = ''
  private disposed = false

  constructor(
    private readonly fallback: CapabilityEntry<T>,
    initialId = ''
  ) {
    this.activeId = initialId || fallback.id
  }

  /** 注册一个实现，返回本次注册的 disposer（幂等） */
  register(entry: CapabilityEntry<T>): Disposer {
    if (this.disposed) {
      return () => {}
    }
    this.entries.set(entry.id, entry)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      if (this.entries.get(entry.id) === entry) {
        this.entries.delete(entry.id)
      }
      entry.dispose?.()
    }
  }

  /** 当前激活的实现（找不到 id 时降级到 fallback，绝不返回空） */
  get(id = this.activeId): T {
    return this.entries.get(id)?.value ?? this.fallback.value
  }

  /** 切换激活实现：先释放旧实现拥有的资源，再激活新实现 */
  activate(id: string): T {
    if (this.disposed) {
      return this.fallback.value
    }
    const previous = this.entries.get(this.activeId)
    this.activeId = id
    if (previous && previous.id !== id) {
      previous.dispose?.()
    }
    this.emit()
    return this.get(id)
  }

  currentId(): string {
    return this.activeId
  }

  /** 订阅切换（UI 用），返回取消订阅函数 */
  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    for (const listener of this.listeners) {
      listener()
    }
  }

  /** 整个注册表销毁：逆序释放所有资源，幂等 */
  disposeAll(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const entry of [...this.entries.values()].reverse()) {
      entry.dispose?.()
    }
    this.entries.clear()
    this.listeners.clear()
  }
}
