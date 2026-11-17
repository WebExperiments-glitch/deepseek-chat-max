/**
 * 上下文压力模型，对齐 DSH 的压缩预留（compaction-basic：阈值 0.8、预留 65536）：
 * - 自动压缩阈值取窗口的 80%，但不能吃掉「输出预留 + 压缩余量」；
 * - 圆环与统计里也按同一套阈值提示压力，避免两处口径不一致。
 *
 * 这里只有纯函数，不读写状态，方便之后移植到 iOS。
 */

export const COMPACT_THRESHOLD_RATIO = 0.8

/** 压缩预留余量，与 DSH 的 COMPACT_HEADROOM_TOKENS 一致 */
export const COMPACT_HEADROOM_TOKENS = 65_536

export type ContextReserve = {
  window: number
  /** 为本轮输出预留的 token */
  output: number
  /** 压缩余量 */
  headroom: number
  /** 自动压缩触发阈值 */
  threshold: number
}

/**
 * 计算窗口里给输出与压缩留出的空间，以及压力阈值。
 * 窗口小于输出预留 + 余量时返回 undefined：此时不做自动压缩，交给人决定。
 */
export const reserveGeometry = (
  window: number,
  maxOutputTokens: number
): ContextReserve | undefined => {
  if (!Number.isFinite(window) || window <= 0) {
    return undefined
  }
  const output = Math.min(
    Math.max(0, Number.isFinite(maxOutputTokens) ? maxOutputTokens : 0),
    window
  )
  const pressureBudget = window - output - COMPACT_HEADROOM_TOKENS
  if (pressureBudget <= 0) {
    return undefined
  }
  const threshold = Math.min(Math.floor(window * COMPACT_THRESHOLD_RATIO), pressureBudget)
  return { window, output, headroom: COMPACT_HEADROOM_TOKENS, threshold }
}

/** 占用百分比，保留一位小数 */
export const pressurePercent = (tokens: number, window: number): number => {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) {
    return 0
  }
  return Math.min(100, Math.round((tokens / window) * 1000) / 10)
}
