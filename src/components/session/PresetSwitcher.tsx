import { useTranslate } from '../../i18n/index.js'
import { applyPreset, usePresets } from '../../services/presets.js'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconSettingsOutline16,
} from '../base/icons.js'
import { Menu } from '../base/Menu.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './PresetSwitcher.module.css'

/** 会话头部：快速切换启用的提示词预设，入口同时提供预设管理 */
export const PresetSwitcher = ({ sessionId }: { sessionId: string }) => {
  const t = useTranslate()
  const presets = usePresets((state) => state.presets)
  const activeId = usePresets((state) => state.activeId)
  const active = presets.find((preset) => preset.id === activeId)
  const label = active?.name || t('presetDefaultName')

  const options = [
    {
      key: 'default',
      label: t('presetDefaultName'),
      icon: activeId === null ? <IconCheckOutline16 /> : <span />,
      onSelect: () => applyPreset(null, sessionId),
    },
    ...presets.map((preset) => ({
      key: preset.id,
      label: preset.name,
      icon: preset.id === activeId ? <IconCheckOutline16 /> : <span />,
      onSelect: () => applyPreset(preset.id, sessionId),
    })),
    {
      key: 'manage',
      label: t('presetManage'),
      icon: <IconSettingsOutline16 />,
      onSelect: () => openSettings('chat'),
    },
  ]

  return (
    <Menu options={options}>
      {({ toggle }) => (
        <button
          type="button"
          className={styles.trigger}
          title={t('presetSwitchTooltip')}
          onClick={toggle}
        >
          <span className={styles.label}>{label}</span>
          <IconChevronDownOutline14 />
        </button>
      )}
    </Menu>
  )
}
