import { useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  createPreset,
  deletePreset,
  exportPresets,
  importPresets,
  setActivePreset,
  updatePreset,
  usePresets,
} from '../../services/presets.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './PresetManager.module.css'

type PresetForm = {
  id?: string
  name: string
  content: string
  openingMessage: string
}

/** 设置页：提示词预设与角色卡的增删改、启用、导入导出 */
export const PresetManager = () => {
  const t = useTranslate()
  const presets = usePresets((state) => state.presets)
  const activeId = usePresets((state) => state.activeId)
  const [form, setForm] = useState<PresetForm | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const deletingPreset = presets.find((preset) => preset.id === deleting)

  const openNew = () => {
    setInvalid(false)
    setForm({ name: '', content: '', openingMessage: '' })
  }

  const openEdit = (id: string) => {
    const preset = presets.find((item) => item.id === id)
    if (!preset) {
      return
    }
    setInvalid(false)
    setForm({
      id,
      name: preset.name,
      content: preset.content,
      openingMessage: preset.openingMessage ?? '',
    })
  }

  const save = () => {
    if (!form) {
      return
    }
    if (!form.name.trim() || !form.content.trim()) {
      setInvalid(true)
      return
    }
    if (form.id) {
      updatePreset(form.id, {
        name: form.name,
        content: form.content,
        openingMessage: form.openingMessage,
      })
    } else {
      createPreset({
        name: form.name,
        content: form.content,
        openingMessage: form.openingMessage,
      })
    }
    setForm(null)
    setInvalid(false)
  }

  const download = () => {
    const blob = new Blob([exportPresets()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'prompt-presets.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const importFile = async (file: File) => {
    try {
      const count = importPresets(await file.text())
      showToast({ key: 'presetImported', params: { count } })
    } catch {
      showToast({ key: 'presetImportFailed', type: 'error' })
    }
  }

  return (
    <div className={styles.block}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <div className={styles.title}>{t('presetManagerTitle')}</div>
          <p className={styles.description}>{t('presetManagerDescription')}</p>
        </div>
        <div className={styles.actions}>
          <Button variant="outlined" size="s" onClick={openNew}>
            {t('presetNew')}
          </Button>
          <Button variant="outlined" size="s" onClick={download}>
            {t('presetExport')}
          </Button>
          <Button variant="outlined" size="s" onClick={() => fileRef.current?.click()}>
            {t('presetImport')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                void importFile(file)
              }
            }}
          />
        </div>
      </div>

      {presets.length === 0 ? (
        <div className={styles.empty}>{t('presetEmpty')}</div>
      ) : (
        <div className={styles.list}>
          {presets.map((preset) => (
            <div key={preset.id} className={styles.row}>
              <div className={styles.info}>
                <div className={styles.name}>
                  {preset.name}
                  {preset.id === activeId ? (
                    <span className={styles.badge}>{t('presetActive')}</span>
                  ) : null}
                </div>
                {preset.openingMessage ? (
                  <div className={styles.opening}>{preset.openingMessage}</div>
                ) : null}
              </div>
              <div className={styles.rowActions}>
                {preset.id === activeId ? null : (
                  <Button variant="outlined" size="s" onClick={() => setActivePreset(preset.id)}>
                    {t('presetActivate')}
                  </Button>
                )}
                <Button variant="outlined" size="s" onClick={() => openEdit(preset.id)}>
                  {t('presetEdit')}
                </Button>
                <Button variant="dangerOutlined" size="s" onClick={() => setDeleting(preset.id)}>
                  {t('delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {form ? (
        <div className={styles.form}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('presetName')}</span>
            <input
              className={styles.input}
              value={form.name}
              maxLength={60}
              placeholder={t('presetName')}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('presetContent')}</span>
            <textarea
              className={styles.textarea}
              rows={8}
              value={form.content}
              placeholder={'{{cur_date}} · {{model_name}}'}
              spellCheck={false}
              onChange={(event) => setForm({ ...form, content: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('presetOpening')}</span>
            <textarea
              className={styles.textarea}
              rows={2}
              value={form.openingMessage}
              placeholder={t('presetOpeningHint')}
              onChange={(event) => setForm({ ...form, openingMessage: event.target.value })}
            />
          </label>
          {invalid ? <div className={styles.error}>{t('presetInvalid')}</div> : null}
          <div className={styles.formActions}>
            <Button variant="outlined" size="m" onClick={() => setForm(null)}>
              {t('cancel')}
            </Button>
            <Button size="m" onClick={save}>
              {t('save')}
            </Button>
          </div>
        </div>
      ) : null}

      {deletingPreset ? (
        <Modal
          title={t('presetDeleteConfirm')}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  deletePreset(deletingPreset.id)
                  setDeleting(null)
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {deletingPreset.name}
        </Modal>
      ) : null}
    </div>
  )
}
