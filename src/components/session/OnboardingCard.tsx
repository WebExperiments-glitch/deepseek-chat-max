/**
 * 首次启动引导：解决「用户拿到 API Key 不知道能干嘛」的冷启动问题。
 *
 * 当没有任何服务商配置 Key 时显示在欢迎页：粘贴 Key → 自动检测可用模型 → 直接开聊。
 * 检测复用 modelProbe（先 /models，拿不到才小规模并发探测），把最独特的功能放到最显眼处。
 */
import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { getProvider, isProviderId } from '../../services/api/providers.js'
import { setProviderApiKey, setProviderModel, useSettings } from '../../services/settings.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { useModels } from '../../services/models.js'
import { probeAvailableModels } from '../../services/modelProbe.js'
import { Button } from '../base/Button.js'
import styles from './OnboardingCard.module.css'

const tr = (t: (k: TranslationKey) => string, key: TranslationKey, fallback: string): string => {
  const value = t(key)
  return value === key ? fallback : value
}

export const OnboardingCard = () => {
  const t = useTranslate()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<'input' | 'done'>('input')
  const [found, setFound] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const provider = useSettings((state) => state.provider)

  const start = async () => {
    const trimmed = key.trim()
    if (!trimmed || busy || !isProviderId(provider)) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await probeAvailableModels(getProvider(provider), trimmed, {
        candidates: useModels.getState().lists[provider].map((m) => m.id),
      })
      if (result.aborted === 'auth') {
        setError(tr(t, 'onboardingInvalidKey', '密钥无效，请检查后重试'))
        return
      }
      if (result.aborted === 'balance') {
        setError(tr(t, 'onboardingNoBalance', '账户余额不足，请先充值'))
        return
      }
      if (result.models.length === 0) {
        setError(tr(t, 'onboardingNoModels', '没检测到可用模型，换个服务商或检查 Key'))
        return
      }
      setProviderApiKey(provider, trimmed)
      useModels.setState((state) => ({
        lists: { ...state.lists, [provider]: result.models.map((id) => ({ id, label: id })) },
      }))
      setProviderModel(provider, result.models[0])
      setFound(result.models)
      setStep('done')
    } catch {
      setError(tr(t, 'onboardingDetectFailed', '检测失败，请检查网络或换个服务商'))
    } finally {
      setBusy(false)
    }
  }

  if (step === 'done') {
    return (
      <div className={styles.card}>
        <div className={styles.title}>{tr(t, 'onboardingDoneTitle', '可以用了！')}</div>
        <div className={styles.desc}>
          {tr(t, 'onboardingDoneDesc', '这个密钥可以使用以下模型，已帮你选好第一个：')}
        </div>
        <div className={styles.models}>
          {found.map((id) => (
            <span key={id} className={styles.model}>{id}</span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.card}>
      <div className={styles.title}>{tr(t, 'onboardingTitle', '先填一个 API Key 开始聊天')}</div>
      <div className={styles.desc}>
        {tr(t, 'onboardingDesc', '粘贴密钥，我们会自动检测它能用哪些模型——不用你去猜。密钥只存在你的浏览器里。')}
      </div>
      <div className={styles.row}>
        <input
          type="password"
          className={styles.input}
          placeholder={tr(t, 'onboardingPlaceholder', '粘贴 API Key（sk-…）')}
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              void start()
            }
          }}
        />
        <Button variant="primary" size="m" disabled={!key.trim() || busy} onClick={() => void start()}>
          {busy ? tr(t, 'onboardingDetecting', '检测中…') : tr(t, 'onboardingDetect', '检测并开始')}
        </Button>
      </div>
      {error ? <div className={styles.error}>{error}</div> : null}
      <button type="button" className={styles.skip} onClick={() => openSettings('data')}>
        {tr(t, 'onboardingSkip', '或：去设置里详细配置')}
      </button>
    </div>
  )
}
