import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { classifyApiError } from '../../services/api/errors.js'
import { getProvider, parseCustomModels, setCustomProviderConfig, useCustomProvider, type WireProtocol } from '../../services/api/providers.js'
import { refreshModels, syncCustomModels } from '../../services/models.js'
import { setProviderModel, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import styles from './CustomProvider.module.css'

/** 自定义服务商：endpoint、协议、模型清单与连接测速 */
export const CustomProviderFields = () => {
  const t = useTranslate()
  const config = useCustomProvider((state) => state.config)
  const apiKey = useSettings((state) => state.apiKeys.custom)
  const savedModel = useSettings((state) => state.models.custom)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const manualModels = parseCustomModels(config)
  const defaultModel = savedModel || config.defaultModel || manualModels[0]?.id || ''

  const update = (patch: Parameters<typeof setCustomProviderConfig>[0]) => {
    setCustomProviderConfig(patch)
    if ('models' in patch || 'defaultModel' in patch) {
      syncCustomModels()
    }
    if ('models' in patch && !useSettings.getState().models.custom) {
      const first = parseCustomModels(useCustomProvider.getState().config)[0]
      if (first) {
        setProviderModel('custom', first.id)
      }
    }
  }

  const pullModels = async () => {
    await refreshModels('custom')
    showToast({ key: 'customProviderModelsPulled' })
  }

  const test = async () => {
    const provider = getProvider('custom')
    if (!provider.baseURL) {
      setTestResult({ ok: false, text: t('customProviderNoEndpoint') })
      return
    }
    if (!apiKey) {
      setTestResult({ ok: false, text: t('customProviderNoKey') })
      return
    }
    if (!defaultModel) {
      setTestResult({ ok: false, text: t('customProviderNoModel') })
      return
    }
    setTesting(true)
    setTestResult(null)
    const started = performance.now()
    try {
      const url =
        provider.protocol === 'openai'
          ? `${provider.baseURL}/chat/completions`
          : `${provider.baseURL}/messages`
      const headers: Record<string, string> =
        provider.protocol === 'openai'
          ? { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
          : {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            }
      const body =
        provider.protocol === 'openai'
          ? {
              model: defaultModel,
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
              stream: false,
            }
          : {
              model: defaultModel,
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
            }
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200)
        throw new Error(`${response.status} ${detail || response.statusText}`)
      }
      setTestResult({
        ok: true,
        text: t('customProviderTestOk', { ms: Math.round(performance.now() - started) }),
      })
    } catch (error) {
      setTestResult({
        ok: false,
        text:
          classifyApiError(error) === 'cors'
            ? t('apiKeyCorsBlocked')
            : t('customProviderTestFailed', {
                message: error instanceof Error ? error.message : String(error),
              }),
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={styles.block}>
      <div className={styles.grid}>
        <label className={styles.field}>
          <span>{t('customProviderName')}</span>
          <input
            value={config.name}
            placeholder="My API"
            onChange={(event) => update({ name: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          <span>{t('customProviderProtocol')}</span>
          <Select
            ariaLabel={t('customProviderProtocol')}
            value={config.protocol}
            options={[
              { value: 'openai', label: 'OpenAI chat/completions' },
              { value: 'anthropic', label: 'Anthropic Messages' },
            ]}
            onChange={(value) => update({ protocol: value as WireProtocol })}
          />
        </label>
        <label className={`${styles.field} ${styles.wide}`}>
          <span>{t('customProviderEndpoint')}</span>
          <input
            value={config.baseURL}
            placeholder={
              config.protocol === 'openai'
                ? 'https://api.example.com/v1'
                : 'https://api.example.com/v1'
            }
            spellCheck={false}
            onChange={(event) => update({ baseURL: event.target.value })}
          />
        </label>
        <label className={`${styles.field} ${styles.wide}`}>
          <span>{t('customProviderModelsURL')}</span>
          <input
            value={config.modelsURL}
            placeholder={`${config.baseURL || 'https://api.example.com/v1'}/models`}
            spellCheck={false}
            onChange={(event) => update({ modelsURL: event.target.value })}
          />
        </label>
        <label className={`${styles.field} ${styles.wide}`}>
          <span>{t('customProviderModels')}</span>
          <textarea
            rows={3}
            value={config.models}
            placeholder={'gpt-4o-mini\nclaude-sonnet-4-5|Claude Sonnet 4.5'}
            spellCheck={false}
            onChange={(event) => update({ models: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          <span>{t('customProviderDefaultModel')}</span>
          <input
            value={config.defaultModel}
            placeholder={manualModels[0]?.id ?? ''}
            spellCheck={false}
            onChange={(event) => update({ defaultModel: event.target.value })}
          />
        </label>
      </div>
      <div className={styles.actions}>
        <Button variant="outlined" size="s" onClick={() => void pullModels()}>
          {t('customProviderPullModels')}
        </Button>
        <Button variant="outlined" size="s" disabled={testing} onClick={() => void test()}>
          {t(testing ? 'customProviderTesting' : 'customProviderTest')}
        </Button>
        {testResult ? (
          <span className={testResult.ok ? styles.ok : styles.error}>{testResult.text}</span>
        ) : null}
      </div>
    </div>
  )
}
