import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { compressCurrentSession, useChatStore } from '../../services/chat/store.js'
import {
  aggregateSessionUsage,
  contextPercent,
  findContextWindow,
  formatCacheHitPercent,
  formatTokens,
  projectedContextTokens,
  resolveContextWindow,
  useContextUsage,
} from '../../services/chat/usageStats.js'
import { getCurrentModel, useSettings } from '../../services/settings.js'
import { useModels } from '../../services/models.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { closeStatsDialog, useStatsDialog } from './statsDialogState.js'
import styles from './StatsDialog.module.css'

/**
 * 会话统计弹窗：上下文占用 + 服务端上报的 token 与缓存数据。
 *
 * 这里不做任何计费换算，也不按字符估算：数字全部来自 MessageUsage，
 * 缓存命中率沿用「部分命中不四舍五入成 100%」的规则，窗口未知时只给绝对量。
 */
export const StatsDialog = () => {
  const sessionId = useStatsDialog((state) => state.sessionId)
  return sessionId === null ? null : <StatsContent sessionId={sessionId} />
}

type StatRow = { label: TranslationKey; value: string }

const StatsContent = ({ sessionId }: { sessionId: string }) => {
  const t = useTranslate()
  const session = useChatStore((state) => state.sessionCache[sessionId])
  const model = useSettings((state) => state.models[state.provider]) || getCurrentModel()
  const context = useContextUsage((state) => state.byId[sessionId])
  const [compressing, setCompressing] = useState(false)
  const totals = aggregateSessionUsage(session ?? null)
  // 统计的是这个会话最近一次请求，按当时的模型解释上下文占比
  const usedModel = context?.model ?? model
  const listed = useModels((state) => findContextWindow(state.lists, usedModel))
  const window = resolveContextWindow(usedModel, listed ?? undefined)
  const contextTokens = projectedContextTokens(sessionId, session ?? null)
  const percent = contextPercent(contextTokens, window)
  const cacheRate = formatCacheHitPercent(totals.cacheRead, totals.prompt, 1)
  const ratio = window && window > 0 ? Math.min(1, contextTokens / window) : 0
  const level = ratio >= 0.85 ? 'full' : ratio >= 0.6 ? 'high' : 'normal'
  const rows: StatRow[] = [
    { label: 'statsPrompt', value: formatTokens(totals.prompt) },
    { label: 'statsInputUncached', value: formatTokens(totals.inputUncached) },
    { label: 'statsCacheRead', value: formatTokens(totals.cacheRead) },
    // DeepSeek 的 cache_creation 恒为 0（服务端自动硬盘缓存，不向客户端上报写入量），
    // 只在真正上报了写入量的服务商下才显示这一行，避免永远显示一个无意义的 0。
    ...(totals.cacheWrite > 0
      ? [{ label: 'statsCacheWrite' as const, value: formatTokens(totals.cacheWrite) }]
      : []),
    { label: 'statsOutput', value: formatTokens(totals.output) },
    // 思考与安全审核都包含在 output 里，只在服务端上报时才显示
    ...(totals.thinking > 0
      ? [{ label: 'statsThinking' as const, value: formatTokens(totals.thinking) }]
      : []),
    ...(totals.safety > 0
      ? [{ label: 'statsSafety' as const, value: formatTokens(totals.safety) }]
      : []),
    { label: 'statsRounds', value: String(totals.rounds) },
    { label: 'statsReplies', value: String(totals.replies) },
    { label: 'statsSearch', value: t('statsTimes', { count: totals.searchRequests }) },
    { label: 'statsRead', value: t('statsTimes', { count: totals.readRequests }) },
  ]
  const empty = totals.replies === 0
  const compression = session?.compression

  const compress = async () => {
    setCompressing(true)
    try {
      const outcome = await compressCurrentSession(sessionId)
      if (outcome.ok) {
        showToast({ key: 'statsCompressed', params: { rounds: outcome.compression.rounds } })
      } else {
        // 传对象而不是裸字符串：Toast 会在渲染时按当前语言翻译，直接传 key 会显示成原始标识
        const key =
          outcome.reason === 'tooShort'
            ? 'statsCompressTooShort'
            : outcome.reason === 'noKey'
              ? 'statsCompressNoKey'
              : 'statsCompressFailed'
        showToast({ key })
      }
    } finally {
      setCompressing(false)
    }
  }

  return (
    <Modal
      title={t('statsTitle')}
      closable
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={closeStatsDialog}
    >
      <section className={styles.context}>
        <div className={styles.contextHead}>
          <span className={styles.contextLabel}>{t('statsContext')}</span>
          <span className={styles.contextValue}>
            {contextTokens === 0 ? '–' : formatTokens(contextTokens)}
            {window === null || contextTokens === 0 ? null : (
              <span className={styles.contextTotal}> / {formatTokens(window)}</span>
            )}
          </span>
        </div>
        <div className={styles.bar} aria-hidden>
          <div
            className={styles.barValue}
            data-level={level}
            style={{ width: `${percent ?? 0}%` }}
          />
        </div>
        {window === null ? <p className={styles.note}>{t('statsUnknownWindow')}</p> : null}
      </section>

      <section className={styles.rate}>
        <span className={styles.rateLabel}>{t('statsCacheRate')}</span>
        <span className={styles.rateValue}>{cacheRate === null ? '–' : `${cacheRate}%`}</span>
      </section>
      <p className={styles.note}>{t('statsCacheNote')}</p>
      {/* 短对话命中 0% 是服务端缓存单元还没形成，不是统计错误 */}
      {totals.prompt > 0 && totals.cacheRead === 0 && totals.prompt < 1024 ? (
        <p className={styles.note}>{t('statsCacheShort')}</p>
      ) : null}

      <section className={styles.compress}>
        <span className={styles.compressLabel}>
          {compression
            ? t('statsCompressionActive', { rounds: compression.rounds })
            : t('statsCompressHint')}
        </span>
        <Button variant="outlined" size="s" disabled={compressing} onClick={() => void compress()}>
          {compressing ? t('statsCompressing') : t('statsCompress')}
        </Button>
      </section>

      {empty ? (
        <p className={styles.empty}>{t('statsEmpty')}</p>
      ) : (
        <div className={styles.grid}>
          {rows.map((row) => (
            <div key={row.label} className={styles.item}>
              <span className={styles.itemLabel}>{t(row.label)}</span>
              <span className={styles.itemValue}>{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
