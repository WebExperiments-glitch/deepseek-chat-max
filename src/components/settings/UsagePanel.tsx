import { useCallback, useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getDeepseekApiKey } from '../../services/settings.js'
import {
  loadUsage,
  probeCache,
  type CacheProbeResult,
  type UsageSummary,
} from '../../services/usage.js'
import { Button } from '../base/Button.js'
import styles from './UsagePanel.module.css'

const percent = (value: number) => `${(value * 100).toFixed(1)}%`

const compact = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}K`
      : String(value)

/** 数据管理：跨会话统计输入/输出与缓存命中，回答「缓存真的命中了没有」 */
export const UsagePanel = () => {
  const t = useTranslate()
  const [data, setData] = useState<UsageSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [probe, setProbe] = useState<CacheProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    setFailed(false)
    try {
      setData(await loadUsage())
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runProbe = async () => {
    const key = getDeepseekApiKey()
    if (!key) {
      setProbeError(t('usageProbeNoKey'))
      return
    }
    setProbing(true)
    setProbeError(null)
    setProbe(null)
    try {
      const result = await probeCache(key)
      if (result.first.error || result.second.error) {
        setProbeError(
          t('usageProbeFailed', {
            message: result.first.error ?? result.second.error ?? '',
          })
        )
        return
      }
      setProbe(result)
    } catch (error) {
      setProbeError(
        t('usageProbeFailed', {
          message: error instanceof Error ? error.message : String(error),
        })
      )
    } finally {
      setProbing(false)
    }
  }

  return (
    <div className={styles.block}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>{t('usageTitle')}</div>
          <p className={styles.description}>{t('usageDescription')}</p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="outlined" size="s" disabled={busy} onClick={() => void load()}>
            {t('usageRefresh')}
          </Button>
          <Button variant="outlined" size="s" disabled={probing} onClick={() => void runProbe()}>
            {t(probing ? 'usageProbing' : 'usageProbe')}
          </Button>
        </div>
      </div>
      <p className={styles.note}>{t('usageProbeHint')}</p>
      {probeError ? <div className={styles.error}>{probeError}</div> : null}
      {probe ? (
        <div className={styles.probe}>
          <div className={styles.probeRow}>
            {t('usageProbeResult', {
              chars: probe.prefixChars,
              first: probe.first.cacheReadTokens,
              second: probe.second.cacheReadTokens,
            })}
          </div>
          <div className={probe.cached ? styles.probeOk : styles.probeMiss}>
            {t(probe.cached ? 'usageProbeHit' : 'usageProbeMiss')}
          </div>
          <div className={styles.probeMeta}>
            {t('usageProbeTiming', {
              first: probe.first.ms,
              second: probe.second.ms,
              input: probe.second.inputTokens,
            })}
          </div>
        </div>
      ) : null}
      {failed ? (
        <div className={styles.error}>{t('usageFailed')}</div>
      ) : !data ? (
        <div className={styles.empty}>{t('usageLoading')}</div>
      ) : data.totals.requests === 0 ? (
        <div className={styles.empty}>{t('usageEmpty')}</div>
      ) : (
        <>
          <div className={styles.metrics}>
            <div className={styles.metric}>
              <span>{t('usageRequests')}</span>
              <strong>{data.totals.requests}</strong>
            </div>
            <div className={styles.metric}>
              <span>{t('usagePrompt')}</span>
              <strong>{compact(data.totals.promptTokens)}</strong>
            </div>
            <div className={styles.metric}>
              <span>{t('usageCacheRead')}</span>
              <strong>{compact(data.totals.cacheReadTokens)}</strong>
            </div>
            <div className={styles.metric}>
              <span>{t('usageHitRate')}</span>
              <strong>{percent(data.totals.cacheHitRate)}</strong>
            </div>
            <div className={styles.metric}>
              <span>{t('usageOutput')}</span>
              <strong>{compact(data.totals.outputTokens)}</strong>
            </div>
          </div>
          <div className={styles.list}>
            {data.sessions.map((session) => (
              <div key={session.id} className={styles.row}>
                <span className={styles.sessionTitle}>{session.title || t('untitledChat')}</span>
                <span className={styles.sessionMeta}>
                  {t('usageSessionMeta', {
                    requests: session.requests,
                    prompt: compact(session.promptTokens),
                  })}
                </span>
                <span className={styles.rate}>{percent(session.cacheHitRate)}</span>
              </div>
            ))}
          </div>
          <p className={styles.note}>{t('usageNote')}</p>
        </>
      )}
    </div>
  )
}
