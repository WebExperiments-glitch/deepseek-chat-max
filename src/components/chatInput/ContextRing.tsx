import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { getCurrentModel, useSettings } from '../../services/settings.js'
import { useModels } from '../../services/models.js'
import { useChatStore } from '../../services/chat/store.js'
import {
  contextPercent,
  findContextWindow,
  formatTokens,
  projectedContextTokens,
  resolveContextWindow,
  useContextUsage,
} from '../../services/chat/usageStats.js'
import { Tooltip } from '../base/Tooltip.js'
import styles from './ContextRing.module.css'

const SIZE = 30
const STROKE = 2.5
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * 上下文占用圆环：把最近一次请求的 prompt 体量按模型窗口折算成百分比。
 *
 * 数值只来自服务端上报的用量；窗口优先取服务商模型清单里的 context_window，
 * 清单没给又不在已知 DeepSeek 列表里时不画进度，只显示绝对 token 数，
 * 避免用猜测的窗口给出错误的百分比。
 */
export const ContextRing = ({
  sessionId,
  streaming = false,
  onOpen,
}: {
  sessionId: string | null
  streaming?: boolean
  /** 点击圆环打开会话统计；移动端没有单独的统计入口 */
  onOpen?: () => void
}) => {
  const t = useTranslate()
  const model = useSettings((state) => state.models[state.provider]) ?? ''
  const usage = useContextUsage((state) => (sessionId ? state.byId[sessionId] : undefined))
  const session = useChatStore((state) => (sessionId ? state.sessionCache[sessionId] : undefined))
  // 锚点来自服务端 usage，压缩后的历史缩减即时叠加为增量
  const tokens = projectedContextTokens(sessionId ?? '', session ?? null)
  // 用量记录里带着发请求时的模型：之后换模型或换服务商，也按当时的窗口解释这个数字
  const usedModel = usage?.model ?? (model || getCurrentModel())
  const listed = useModels((state) => findContextWindow(state.lists, usedModel))
  const window = resolveContextWindow(usedModel, listed ?? undefined)
  const percent = contextPercent(tokens, window)
  const ratio = window && window > 0 ? Math.min(1, tokens / window) : 0
  const level = ratio >= 0.85 ? 'full' : ratio >= 0.6 ? 'high' : 'normal'
  const tip =
    tokens === 0
      ? t('contextUsageEmpty')
      : window === null
        ? t('contextUsageUnknownWindow', { used: formatTokens(tokens) })
        : t('contextUsageTip', {
            used: formatTokens(tokens),
            total: formatTokens(window),
            percent: Math.round(percent ?? 0),
          })

  return (
    <Tooltip content={tip}>
      <button
        type="button"
        className={clsx(styles.ring, streaming && styles.active)}
        data-level={level}
        data-empty={tokens === 0 || undefined}
        aria-label={
          window === null
            ? t('contextUsageUnknownWindow', { used: formatTokens(tokens) })
            : t('contextUsageLabel', { percent: Math.round(percent ?? 0) })
        }
        onClick={onOpen}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
          <circle
            className={styles.track}
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
          />
          <circle
            className={styles.value}
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        </svg>
        {/* 窗口未知时显示破折号，表示只有绝对用量、没有百分比 */}
        <span className={styles.percent}>
          {tokens === 0 || percent === null ? '–' : Math.round(percent)}
        </span>
      </button>
    </Tooltip>
  )
}
