import { useState } from 'react'
import { getSearchProvider, SEARCH_PROVIDERS } from '../../services/searchProviders.js'
import { setSearchKey, setSearchProvider, useSettings } from '../../services/settings.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { Select } from '../base/Select.js'
import styles from './Settings.module.css'

/** 联网搜索商选择（可插拔：DeepSeek 边想边搜 / DeepSeek API / Tavily / Serper / Brave） */
export const SearchProviderSetting = () => {
  const t = useTranslate()
  const tr = (key: TranslationKey, fallback: string) => {
    const value = t(key)
    return value === key ? fallback : value
  }
  const providerId = useSettings((state) => state.searchProviderId)
  const searchKeys = useSettings((state) => state.searchKeys)
  const provider = getSearchProvider(providerId)
  const [draft, setDraft] = useState('')

  const currentKey = provider.id === 'deepseek-api' ? '' : (searchKeys[provider.id] ?? '')
  const needKey = provider.kind === 'standalone' && provider.id !== 'deepseek-api'

  return (
    <div className={styles.cell}>
      <div className={styles.label}>{tr('searchProviderLabel', '联网搜索商')}</div>
      <Select
        ariaLabel={tr('searchProviderLabel', '联网搜索商')}
        value={providerId}
        options={SEARCH_PROVIDERS.map((p) => ({ value: p.id, label: p.name }))}
        onChange={setSearchProvider}
      />
      <div className={styles.description}>
        {provider.kind === 'server-tool'
          ? tr('searchProviderServerToolHint', '由模型在对话中自主联网搜索，无需额外配置。')
          : provider.id === 'deepseek-api'
            ? tr('searchProviderDeepseekHint', '使用 DeepSeek Key 做检索摘编。')
            : tr('searchProviderThirdPartyHint', '填入该搜索商的 API Key，检索经本机代理转发。')}
      </div>
      {needKey ? (
        <div className={styles.apiKeyInput}>
          <input
            type="password"
            placeholder={`${provider.name} API Key`}
            autoComplete="off"
            spellCheck={false}
            value={draft || currentKey}
            onChange={(e) => setDraft(e.target.value)}
          />
          {draft.trim() && draft.trim() !== currentKey ? (
            <button
              type="button"
              className={styles.confirm}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setSearchKey(provider.id, draft.trim())
                setDraft('')
              }}
            >
              {t('confirm')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
