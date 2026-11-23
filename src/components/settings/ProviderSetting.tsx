import { useEffect, useState } from 'react'
import { classifyApiError } from '../../services/api/errors.js'
import {
  getProvider,
  parseCustomModels,
  PROVIDERS,
  PROVIDER_IDS,
  useCustomProvider,
  type ProviderId,
} from '../../services/api/providers.js'
import { PROVIDER_CATALOG } from '../../services/api/providerCatalog.generated.js'
import {
  setProvider,
  setProviderApiKey,
  setProviderModel,
  useSettings,
} from '../../services/settings.js'
import {
  loadModelsWithKey,
  refreshModels,
  syncCustomModels,
  useModels,
} from '../../services/models.js'
import { useModelMeta } from '../../services/modelMeta.js'
import { probeAvailableModels } from '../../services/modelProbe.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { CustomProviderFields } from './CustomProviderFields.js'
import styles from './Settings.module.css'

/**
 * 服务商与模型的配置区：
 * - 顶部切换对话服务商，切换后下面显示该服务商自己的 Key 与模型；
 * - Key 先校验再保存，校验通过后顺手拉取模型清单；
 * - 非 DeepSeek 服务商只提供对话，联网搜索、附件、语音与朗读需切回 DeepSeek。
 */
export const ProviderSetting = () => {
  const t = useTranslate()
  const provider = useSettings((state) => state.provider)
  const customName = useCustomProvider((state) => state.config.name)
  return (
    <div className={styles.cell}>
      <div className={styles.provider}>
        <div className={styles.label}>{t('settingsProvider')}</div>
        <Select
          ariaLabel={t('settingsProvider')}
          className={styles.providerSelect}
          value={provider}
          options={PROVIDER_IDS.map((id) => ({
            value: id,
            label: id === 'custom' ? customName.trim() || t('customProviderFallbackName') : PROVIDERS[id].name,
          }))}
          onChange={setProvider}
        />
        <ProviderBody provider={provider} />
      </div>
    </div>
  )
}

/** 当前服务商的 Key 与模型；Key 保存后重新拉取模型清单 */
const ProviderBody = ({ provider }: { provider: ProviderId }) => {
  const t = useTranslate()
  const customConfig = useCustomProvider((state) => state.config)
  const apiKey = useSettings((state) => state.apiKeys[provider])
  const savedModel = useSettings((state) => state.models[provider])
  const models = useModels((state) => state.lists[provider])
  const loading = useModels((state) => state.loading[provider])
  const meta = useModelMeta((state) => state.entries[savedModel ?? ''])
  const [value, setValue] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeProgress, setProbeProgress] = useState('')
  const [probeMsg, setProbeMsg] = useState<string | null>(null)

  // 自定义服务商的模型来自手动清单，配置变化后立即同步
  useEffect(() => {
    if (provider === 'custom') {
      syncCustomModels()
    }
  }, [provider, customConfig.models])

  // 已有 Key（或免 Key 服务商）但还没拉过清单时补拉一次
  const noKey = PROVIDER_CATALOG.find((p) => p.id === provider)?.noKey === true
  useEffect(() => {
    if ((apiKey || noKey) && models.length === 0 && !loading) {
      void refreshModels(provider)
    }
  }, [apiKey, noKey, models.length, loading, provider])

  // 网关没有文档化的默认模型：清单到达后自动选中第一条，避免发空 model
  useEffect(() => {
    if (!savedModel && models.length > 0) {
      setProviderModel(provider, models[0].id)
    }
  }, [savedModel, models, provider])

  const submit = async () => {
    const key = value.trim()
    if (!key || verifying) {
      return
    }
    setVerifying(true)
    setError(null)
    try {
      // 自定义服务商没有模型清单地址时无法在线校验，保存后由「连接测速」确认
      const skipVerify =
        provider === 'custom' && !customConfig.modelsURL.trim()
      if (!skipVerify) {
        await verifyKey(provider, key)
      } else {
        syncCustomModels()
      }
      setProviderApiKey(provider, key)
      setValue('')
      await refreshModels(provider)
    } catch (e) {
      setError(
        classifyApiError(e) === 'unauthorized'
          ? t('apiKeyInvalid')
          : classifyApiError(e) === 'cors'
            ? t('apiKeyCorsBlocked')
            : classifyApiError(e) === 'network'
              ? t('commonNetworkErrorToast')
              : t('apiKeyVerificationFailed', {
                  message: e instanceof Error ? e.message : String(e),
                })
      )
    } finally {
      setVerifying(false)
    }
  }

  const defaultModel = getProvider(provider).defaultModel
  const manualModels = provider === 'custom' ? parseCustomModels(customConfig) : []
  const options =
    manualModels.length > 0
      ? manualModels.map((model) => ({ value: model.id, label: model.label }))
      : models.length > 0
        ? models.map((model) => ({ value: model.id, label: model.label }))
        : [{ value: defaultModel, label: defaultModel }]

  /**
   * 一键检测可用模型：先 /models（零成本），拿不到才小规模并发真实探测。
   * 候选来自模型元数据目录里该服务商的条目 + 当前默认模型。
   */
  const runProbe = async () => {
    const key = apiKey || (noKey ? 'public' : '')
    if (!key || probing) {
      return
    }
    setProbing(true)
    setProbeMsg(null)
    setProbeProgress('')
    try {
      const allMeta = useModelMeta.getState().entries
      const catalogCandidates = Object.values(allMeta)
        .filter((entry) => entry.providerId === provider)
        .map((entry) => entry.id)
      const candidates = [...new Set([defaultModel, ...manualModels.map((m) => m.id), ...catalogCandidates])].filter(
        Boolean
      )
      const result = await probeAvailableModels(getProvider(provider), key, {
        candidates,
        onProgress: (done, total) => setProbeProgress(t('probeModelsProbing', { done, total })),
      })
      if (result.aborted === 'auth') {
        setProbeMsg(t('probeModelsAbortedAuth'))
        return
      }
      if (result.aborted === 'balance') {
        setProbeMsg(t('probeModelsAbortedBalance'))
        return
      }
      if (result.models.length === 0) {
        setProbeMsg(t('probeModelsEmpty'))
        return
      }
      // 写回可用模型列表并选中第一个，形成「检测 → 开聊」闭环
      const available = result.models.map((id) => ({ id, label: id }))
      useModels.setState((state) => ({ lists: { ...state.lists, [provider]: available } }))
      setProviderModel(provider, result.models[0])
      setProbeMsg(
        result.source === 'models-endpoint'
          ? t('probeModelsFromList', { n: result.models.length })
          : t('probeModelsFromProbe', { tested: result.tested, n: result.models.length })
      )
    } catch {
      setProbeMsg(t('probeModelsEmpty'))
    } finally {
      setProbing(false)
      setProbeProgress('')
    }
  }

  return (
    <>
      {provider === 'custom' ? <CustomProviderFields /> : null}
      {noKey ? (
        <div className={styles.description}>{t('providerNoKeyNeeded')}</div>
      ) : apiKey ? (
        <div className={styles.apiKeySaved}>
          <span className={styles.apiKeyMask}>{'*'.repeat(apiKey.length)}</span>
          <Button variant="outlined" size="s" onClick={() => setProviderApiKey(provider, null)}>
            {t('apiKeyClear')}
          </Button>
        </div>
      ) : (
        <div className={styles.apiKeyInput}>
          <input
            type="password"
            placeholder={t('apiKeyPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                void submit()
              }
            }}
          />
          {value.trim() ? (
            <button
              type="button"
              className={styles.confirm}
              disabled={verifying}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void submit()}
            >
              {verifying ? t('apiKeyVerifying') : t('confirm')}
            </button>
          ) : null}
        </div>
      )}
      {error ? <div className={styles.error}>{error}</div> : null}
      <div className={styles.modelRow}>
        <span className={styles.description}>{t('settingsModel')}</span>
        <Select
          ariaLabel={t('settingsModel')}
          value={savedModel ?? defaultModel}
          options={options}
          disabled={loading}
          onChange={(model) => setProviderModel(provider, model)}
        />
      </div>
      {apiKey || noKey ? (
        <div className={styles.modelRow}>
          <Button
            variant="outlined"
            size="s"
            disabled={probing || verifying}
            onClick={() => void runProbe()}
          >
            {probing && probeProgress ? probeProgress : t('probeModelsButton')}
          </Button>
        </div>
      ) : null}
      {probeMsg ? <div className={styles.description}>{probeMsg}</div> : null}
      {meta ? (
        <div className={styles.description}>
          {meta.providerName}
          {meta.contextWindow
            ? ` · ${Math.round((meta.contextWindow / 1000) * 10) / 10}K context`
            : ''}
          {meta.inputModalities?.includes('image') ? ' · vision' : ''}
        </div>
      ) : null}
      {provider !== 'deepseek' ? (
        <div className={styles.description}>{t('settingsProviderAttachmentHint')}</div>
      ) : null}
    </>
  )
}

/** 用尚未保存的 Key 拉一次清单：既能校验 Key 是否可用，也能立刻得到模型选项 */
const verifyKey = async (provider: ProviderId, apiKey: string) => {
  await loadModelsWithKey(provider, apiKey)
}
