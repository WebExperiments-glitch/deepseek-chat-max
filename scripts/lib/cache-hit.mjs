/**
 * 命中率格式化的脚本副本，源头在 `src/services/chat/usageStats.ts`。
 *
 * 验收脚本是独立的 .mjs，无法直接导入 TypeScript 源码，因此保留这份副本。
 * 修改应用算法时必须同步更新这里，否则验收数字会与应用显示不一致。
 */

/** 整数域二分求「半数进位」后的百分比单位，避免浮点 toFixed 的舍入误差 */
const roundedPercentUnits = (cacheRead, prompt, decimalPlaces) => {
  const scale = (decimalPlaces === 0 ? 1 : 10) * 100
  const doubledScale = scale * 2
  const quotient = Math.floor(prompt / doubledScale)
  const remainder = prompt % doubledScale
  let lower = 0
  let upper = scale
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * quotient + Math.ceil((factor * remainder) / doubledScale)
    if (cacheRead >= threshold) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

const displayPercentUnits = (units, decimalPlaces) => {
  if (decimalPlaces === 0) return String(units)
  const whole = Math.floor(units / 10)
  const tenths = units % 10
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`
}

/**
 * 完全命中返回 100；部分命中若四舍五入会得到 100，则自适应增加小数位
 * 显示真实下界（如 99.99、99.9999），永远不把部分命中显示成 100%。
 */
export const formatCacheHitPercent = (cacheRead, prompt, decimalPlaces = 0) => {
  if (prompt <= 0) return null
  if (cacheRead >= prompt) return '100'
  const missed = prompt - cacheRead
  const rounded = roundedPercentUnits(cacheRead, prompt, decimalPlaces)
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1000
  if (rounded < fullHitUnits) return displayPercentUnits(rounded, decimalPlaces)
  let distinguishingPlaces = 1
  let scaledDoubleGap = missed * 200
  const denominatorTens = Math.floor(prompt / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    distinguishingPlaces += 1
  }
  const denominatorOnes = prompt % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`
}
