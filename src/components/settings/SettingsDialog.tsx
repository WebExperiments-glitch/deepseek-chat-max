import clsx from 'clsx'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconThinkOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import { useIsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  EFFORT_LEVELS,
  isChineseBrowser,
  resetBrand,
  setAutoCompress,
  setBrandMode,
  setBrandText,
  setCodeCollapse,
  setCodeWrap,
  setCustomSystemPrompt,
  setDeepseekProtocol,
  setEffort,
  setImageDetail,
  setJsonMode,
  setReadingWidth,
  setSafetyCheck,
  setSendShortcut,
  setShowRefusalDetail,
  setTimeContext,
  setToolsJson,
  setUserId,
  type EffortLevel,
  setLocale,
  setLocation,
  setMaxTokens,
  setTemperature,
  setThemePreference,
  setTopP,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { ParamControl } from './ParamControls.js'
import paramStyles from './ParamControls.module.css'
import { ProviderSetting } from './ProviderSetting.js'
import { ModelPicker } from './ModelPicker.js'
import { AppearanceSetting } from './AppearanceSetting.js'
import { createLatestReminder } from '../../services/chat/latestReminder.js'
import { useModels } from '../../services/models.js'
import { getBalance, type DeepseekBalance } from '../../services/api/client.js'
import {
  deleteShare,
  listShares,
  shareLink,
  type ShareMeta,
} from '../../services/shares.js'
import { MemoryPanel } from '../memory/MemoryPanel.js'
import { FilesManager } from './FilesManager.js'
import { PresetManager } from './PresetManager.js'
import { PromptPreview } from './PromptPreview.js'
import { UsagePanel } from './UsagePanel.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  {
    value: 'chat',
    label: 'settingsChatSection',
    icon: <IconEditOutline16 />,
  },
  {
    value: 'model',
    label: 'settingsModelSection',
    icon: <IconSearchOutline16 />,
  },
  {
    value: 'memory',
    label: 'settingDialogAsideMemoryOptionLabel',
    icon: <IconThinkOutline16 />,
  },
  {
    value: 'advanced',
    label: 'settingsAdvancedSection',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <BrandSetting />
              <ThemeSetting />
              <AppearanceSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
            </>
          ) : section === 'chat' ? (
            <ChatSettings />
          ) : section === 'model' ? (
            <ModelPicker />
          ) : section === 'memory' ? (
            <MemoryPanel />
          ) : section === 'advanced' ? (
            <AdvancedSettings />
          ) : (
            <>
              <ProviderSetting />
              <ApiKeyField editor={apiKeyEditor} />
              <BalanceCell />
              <UsagePanel />
              <FilesManager />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <ShareLinksManager />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
              {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

/**
 * 对话参数：温度、Top P 与最大输出 Token。
 * 三个参数在每次发请求时读取，改动立即对下一轮生效，不影响已生成的内容。
 */
const ChatSettings = () => {
  const t = useTranslate()
  const promptId = useId()
  const customSystemPrompt = useSettings((state) => state.customSystemPrompt)
  const imageDetail = useSettings((state) => state.imageDetail)
  const safetyCheck = useSettings((state) => state.safetyCheck)
  const timeContext = useSettings((state) => state.timeContext)
  const autoCompress = useSettings((state) => state.autoCompress)
  const readingWidth = useSettings((state) => state.readingWidth)
  const codeWrap = useSettings((state) => state.codeWrap)
  const codeCollapse = useSettings((state) => state.codeCollapse)
  const sendShortcut = useSettings((state) => state.sendShortcut)
  return (
    <>
      <PresetManager />
      <PromptPreview />
      {/* 默认提示词：没有启用预设时才生效；预设会覆盖这里 */}
      <div className={paramStyles.promptCell}>
        <label className={paramStyles.promptLabel} htmlFor={promptId}>
          {t('settingsSystemPrompt')}
        </label>
        <p className={paramStyles.promptDescription}>{t('settingsSystemPromptDescription')}</p>
        <textarea
          id={promptId}
          className={paramStyles.promptArea}
          rows={3}
          value={customSystemPrompt}
          placeholder={t('settingsSystemPromptPlaceholder')}
          onChange={(event) => setCustomSystemPrompt(event.target.value)}
        />
      </div>
      <SettingCell
        label={t('settingsSafetyCheck')}
        description={t('settingsSafetyCheckDescription')}
        status={null}
        action={
          <input
            type="checkbox"
            className={paramStyles.checkbox}
            checked={safetyCheck}
            aria-label={t('settingsSafetyCheck')}
            onChange={(event) => setSafetyCheck(event.target.checked)}
          />
        }
      />

      <SettingCell
        label={t('settingsTimeContext')}
        description={t('settingsTimeContextDescription')}
        status={null}
        action={
          <input
            type="checkbox"
            className={paramStyles.checkbox}
            checked={timeContext}
            aria-label={t('settingsTimeContext')}
            onChange={(event) => setTimeContext(event.target.checked)}
          />
        }
      />

      <SettingCell
        label={t('settingsImageDetail')}
        description={t('settingsImageDetailDescription')}
        status={null}
        action={
          <Select
            ariaLabel={t('settingsImageDetail')}
            className={styles.effortSelect}
            value={imageDetail}
            options={[
              { value: 'auto', label: t('imageDetailAuto') },
              { value: 'low', label: t('imageDetailLow') },
              { value: 'high', label: t('imageDetailHigh') },
            ]}
            onChange={(value) => setImageDetail(value as 'auto' | 'low' | 'high')}
          />
        }
      />

      <SettingCell
        label={t('settingsAutoCompress')}
        description={t('settingsAutoCompressDescription')}
        status={null}
        action={
          <input
            type="checkbox"
            className={paramStyles.checkbox}
            checked={autoCompress}
            aria-label={t('settingsAutoCompress')}
            onChange={(event) => setAutoCompress(event.target.checked)}
          />
        }
      />
      <SettingCell
        label={t('readingWidth')}
        description={t('readingWidthDescription')}
        status={null}
        action={
          <Select
            ariaLabel={t('readingWidth')}
            className={styles.effortSelect}
            value={readingWidth}
            options={[
              { value: 'standard', label: t('readingWidthStandard') },
              { value: 'wide', label: t('readingWidthWide') },
            ]}
            onChange={(value) => setReadingWidth(value as 'standard' | 'wide')}
          />
        }
      />
      <SettingCell
        label={t('codeWrap')}
        description={t('codeWrapDescription')}
        status={null}
        action={
          <input
            type="checkbox"
            className={paramStyles.checkbox}
            checked={codeWrap}
            aria-label={t('codeWrap')}
            onChange={(event) => setCodeWrap(event.target.checked)}
          />
        }
      />
      <SettingCell
        label={t('codeCollapse')}
        description={t('codeCollapseDescription')}
        status={null}
        action={
          <input
            type="checkbox"
            className={paramStyles.checkbox}
            checked={codeCollapse}
            aria-label={t('codeCollapse')}
            onChange={(event) => setCodeCollapse(event.target.checked)}
          />
        }
      />
      <SettingCell
        label={t('sendShortcut')}
        description={t('sendShortcutDescription')}
        status={null}
        action={
          <Select
            ariaLabel={t('sendShortcut')}
            className={styles.effortSelect}
            value={sendShortcut}
            options={[
              { value: 'enter', label: t('sendShortcutEnter') },
              { value: 'mod-enter', label: t('sendShortcutModEnter') },
            ]}
            onChange={(value) => setSendShortcut(value as 'enter' | 'mod-enter')}
          />
        }
      />
    </>
  )
}

/** 高级功能：开发者与进阶用户才用得上的设置，普通人不必碰 */
const AdvancedSettings = () => {
  const t = useTranslate()
  const toolsId = useId()
  const temperature = useSettings((state) => state.temperature)
  const topP = useSettings((state) => state.topP)
  const maxTokens = useSettings((state) => state.maxTokens)
  const userId = useSettings((state) => state.userId)
  const showRefusalDetail = useSettings((state) => state.showRefusalDetail)
  const deepseekProtocol = useSettings((state) => state.deepseekProtocol)
  const effort = useSettings((state) => state.effort)
  const jsonMode = useSettings((state) => state.jsonMode)
  const toolsJson = useSettings((state) => state.toolsJson)
  const provider = useSettings((state) => state.provider)
  const model = useSettings((state) => state.models[state.provider]) ?? ''
  const [toolsError, setToolsError] = useState(false)
  const listed = useModels((state) => state.lists[provider].find((option) => option.id === model))
  const effortLevels = listed?.effortLevels ?? EFFORT_LEVELS
  const maxOutput = listed?.maxOutputTokens ?? 393216
  return (
    <>
      <p className={styles.sectionIntro}>{t('advancedSettingsIntro')}</p>
      {/* 协议切换：Responses 下部分能力（如联网工具）不可用 */}
      <SettingCell
        label={t('settingsApiProtocol')}
        description={t('settingsApiProtocolDescription')}
        status={null}
        action={
          <Select
            ariaLabel={t('settingsApiProtocol')}
            className={styles.effortSelect}
            value={deepseekProtocol}
            options={[
              { value: 'messages', label: t('protocolMessages') },
              { value: 'responses', label: t('protocolResponses') },
            ]}
            onChange={(value) => setDeepseekProtocol(value as 'messages' | 'responses')}
          />
        }
      />
      <SettingCell
        label={t('jsonMode')}
        description={t('jsonModeDescription')}
        status={null}
        action={
          <input
            type="checkbox"
            className={paramStyles.checkbox}
            checked={jsonMode}
            aria-label={t('jsonMode')}
            onChange={(event) => setJsonMode(event.target.checked)}
          />
        }
      />
      <SettingCell
        label={t('settingsShowRefusalDetail')}
        description={t('settingsShowRefusalDetailDescription')}
        status={null}
        action={
          <input
            type="checkbox"
            className={paramStyles.checkbox}
            checked={showRefusalDetail}
            aria-label={t('settingsShowRefusalDetail')}
            onChange={(event) => setShowRefusalDetail(event.target.checked)}
          />
        }
      />
      <SettingCell
        label={t('settingsUserId')}
        description={t('settingsUserIdDescription')}
        status={null}
        action={
          <input
            className={paramStyles.textInput}
            value={userId}
            placeholder={t('settingsUserIdPlaceholder')}
            aria-label={t('settingsUserId')}
            onChange={(event) => setUserId(event.target.value)}
          />
        }
      />
      <SettingCell
        label={t('settingsEffort')}
        description={t('settingsEffortDescription')}
        status={null}
        action={
          <Select
            ariaLabel={t('settingsEffort')}
            className={styles.effortSelect}
            value={effort ?? ''}
            options={[
              { value: '', label: t('settingsEffortDefault') },
              ...effortLevels.map((level) => ({ value: level, label: level })),
            ]}
            onChange={(value) => setEffort(value === '' ? null : (value as EffortLevel))}
          />
        }
      />
      <SettingCell
        label={t('settingsTemperature')}
        description={t('settingsTemperatureDescription')}
        status={null}
        className={paramStyles.cell}
        action={
          <ParamControl
            label={t('settingsTemperature')}
            value={temperature}
            min={0}
            max={2}
            step={0.05}
            onChange={(value) => setTemperature(value ?? 1)}
          />
        }
      />
      <SettingCell
        label={t('settingsTopP')}
        description={t('settingsTopPDescription')}
        status={null}
        className={paramStyles.cell}
        action={
          <ParamControl
            label={t('settingsTopP')}
            value={topP}
            min={0.01}
            max={1}
            step={0.01}
            onChange={(value) => setTopP(value ?? 1)}
          />
        }
      />
      <SettingCell
        label={t('settingsMaxTokens')}
        description={t('settingsMaxTokensDescription')}
        status={null}
        className={paramStyles.cell}
        action={
          <ParamControl
            label={t('settingsMaxTokens')}
            value={maxTokens}
            min={1}
            max={maxOutput}
            step={1}
            optional
            onChange={setMaxTokens}
          />
        }
      />
      {/* 函数调用：保存前校验 JSON 数组，避免无效定义发给服务端 */}
      <div className={paramStyles.promptCell}>
        <label className={paramStyles.promptLabel} htmlFor={toolsId}>
          {t('settingsTools')}
        </label>
        <p className={paramStyles.promptDescription}>{t('settingsToolsDescription')}</p>
        <textarea
          id={toolsId}
          className={paramStyles.promptArea}
          rows={6}
          defaultValue={toolsJson}
          placeholder={t('settingsToolsPlaceholder')}
          spellCheck={false}
          onBlur={(event) => {
            const value = event.target.value.trim()
            if (!value) {
              setToolsError(false)
              setToolsJson('')
              return
            }
            try {
              const parsed: unknown = JSON.parse(value)
              if (!Array.isArray(parsed)) {
                throw new Error('not an array')
              }
              setToolsError(false)
              setToolsJson(value)
            } catch {
              setToolsError(true)
            }
          }}
        />
        {toolsError ? <p className={styles.error}>{t('settingsToolsInvalid')}</p> : null}
      </div>
    </>
  )
}

/** 品牌标识：默认 DeepSeek lockup，也可以换成任意文字；随时可复原 */
const BrandSetting = () => {
  const t = useTranslate()
  const brandMode = useSettings((state) => state.brandMode)
  const brandText = useSettings((state) => state.brandText)
  return (
    <SettingCell
      label={t('settingsBrand')}
      description={t('settingsBrandDescription')}
      status={null}
      action={
        <div className={styles.brandControls}>
          <Select
            ariaLabel={t('settingsBrand')}
            className={styles.brandSelect}
            value={brandMode}
            options={[
              { value: 'logo', label: t('brandModeLogo') },
              { value: 'text', label: t('brandModeText') },
            ]}
            onChange={(value) => setBrandMode(value as 'logo' | 'text')}
          />
          {brandMode === 'text' ? (
            <input
              className={paramStyles.textInput}
              value={brandText}
              placeholder={t('appName')}
              aria-label={t('brandModeText')}
              onChange={(event) => setBrandText(event.target.value)}
            />
          ) : null}
          <Button variant="outlined" size="s" onClick={resetBrand}>
            {t('brandReset')}
          </Button>
        </div>
      }
    />
  )
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  // 让用户看到真实下发的 latest_reminder，位置填没填一眼就知道
  const reminder = createLatestReminder({ locale, location })
  return (
    <SettingCell
      label={t('settingsLocation')}
      description={t('settingsLocationPreview', { value: reminder })}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

/** DeepSeek 账户余额：进入设置时自动查询，可手动刷新 */
const BalanceCell = () => {
  const t = useTranslate()
  const provider = useSettings((state) => state.provider)
  const apiKey = useSettings((state) => state.apiKeys.deepseek)
  const [balance, setBalance] = useState<DeepseekBalance | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (!apiKey) {
      return
    }
    setBusy(true)
    setFailed(false)
    try {
      setBalance(await getBalance(apiKey))
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }, [apiKey])

  useEffect(() => {
    void load()
  }, [load])

  if (provider !== 'deepseek' || !apiKey) {
    return null
  }
  const info = balance?.balance_infos?.[0]
  const description = busy
    ? t('balanceLoading')
    : info
      ? `${t('balanceTotal')} ${info.total_balance} ${info.currency} · ${t('balanceGranted')} ${info.granted_balance} · ${t('balanceToppedUp')} ${info.topped_up_balance}`
      : failed
        ? t('balanceFailed')
        : t('balanceUnavailable')

  return (
    <SettingCell
      label={t('balanceTitle')}
      description={description}
      status={null}
      action={
        <Button variant="outlined" size="m" disabled={busy} onClick={() => void load()}>
          {t('balanceRefresh')}
        </Button>
      }
    />
  )
}

const ShareLinksManager = () => {
  const t = useTranslate()
  const [shares, setShares] = useState<ShareMeta[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ShareMeta | null>(null)

  useEffect(() => {
    let cancelled = false
    listShares()
      .then((list) => {
        if (!cancelled) {
          setShares(list)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setShares([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const copy = async (share: ShareMeta) => {
    await navigator.clipboard.writeText(shareLink(share.id)).catch(() => undefined)
    showToast({ key: 'shareLinkCopied' })
  }

  const remove = async () => {
    if (!confirm) {
      return
    }
    setBusyId(confirm.id)
    try {
      await deleteShare(confirm.id)
      setShares((list) => list?.filter((item) => item.id !== confirm.id) ?? [])
      showToast({ key: 'shareDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      setBusyId(null)
      setConfirm(null)
    }
  }

  return (
    <div className={styles.shareBlock}>
      <div className={styles.shareBlockTitle}>{t('shareManageTitle')}</div>
      {shares === null ? (
        <div className={styles.shareEmpty}>{t('shareLoading')}</div>
      ) : shares.length === 0 ? (
        <div className={styles.shareEmpty}>{t('shareManageEmpty')}</div>
      ) : (
        <div className={styles.shareList}>
          {shares.map((share) => (
            <div key={share.id} className={styles.shareRow}>
              <div className={styles.shareInfo}>
                <div className={styles.shareTitle}>{share.title || t('untitledChat')}</div>
                <div className={styles.shareMeta}>
                  {t('shareMessageCount', { count: share.count })} ·{' '}
                  {new Date(share.createdAt).toLocaleString()}
                </div>
              </div>
              <Button variant="outlined" size="s" onClick={() => void copy(share)}>
                {t('copy')}
              </Button>
              <Button
                variant="dangerOutlined"
                size="s"
                disabled={busyId === share.id}
                onClick={() => setConfirm(share)}
              >
                {t('delete')}
              </Button>
            </div>
          ))}
        </div>
      )}
      {confirm ? (
        <Modal
          title={t('shareManageTitle')}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setConfirm(null)}>
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={busyId !== null} onClick={() => void remove()}>
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('shareDeleteConfirm')}
        </Modal>
      ) : null}
    </div>
  )
}

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    try {
      const count = await importHistory(file)
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { file, busy, status, select: setFile, cancel: () => setFile(null), confirm }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
