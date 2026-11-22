import { useModels } from '../../services/models.js'
import { useModelMeta } from '../../services/modelMeta.js'
import { getCurrentModel, setProviderModel, useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'
import { Menu } from '../base/Menu.js'
import styles from './ModelSwitcher.module.css'

const EXPERT_MODEL = 'deepseek-reasoner'

/**
 * 会话内模型切换：DeepSeek 额外提供“专家模式”入口（映射到 reasoner），
 * 其他模型直接来自设置里已拉取的模型清单。
 */
export const ModelSwitcher = () => {
  const t = useTranslate()
  const provider = useSettings((state) => state.provider)
  const savedModel = useSettings((state) => state.models[state.provider])
  const models = useModels((state) => state.lists[provider])
  const current = getCurrentModel()
  const meta = useModelMeta((state) => state.entries[current])
  const expert = current === EXPERT_MODEL
  const label = expert
    ? t('expertMode')
    : models.find((model) => model.id === current)?.label || savedModel || current

  const options = [
    ...(provider === 'deepseek'
      ? [
          {
            key: EXPERT_MODEL,
            label: t('expertMode'),
            icon: expert ? <IconCheckOutline16 /> : <span />,
            onSelect: () => setProviderModel(provider, EXPERT_MODEL),
          },
        ]
      : []),
    ...(models.length > 0 ? models : [{ id: current, label: current }])
      .filter((model) => !(provider === 'deepseek' && model.id === EXPERT_MODEL))
      .map((model) => ({
        key: model.id,
        label: model.label,
        icon: model.id === current ? <IconCheckOutline16 /> : <span />,
        onSelect: () => setProviderModel(provider, model.id),
      })),
  ]

  return (
    <Menu options={options}>
      {({ toggle }) => (
        <button
          type="button"
          className={styles.trigger}
          title={t('modelSwitchTooltip')}
          onClick={toggle}
        >
          {meta ? (
            <span className={styles.vendor} title={meta.providerName}>
              {meta.providerName.slice(0, 1).toUpperCase()}
            </span>
          ) : null}
          <span className={styles.label}>{label}</span>
          <IconChevronDownOutline14 />
        </button>
      )}
    </Menu>
  )
}
