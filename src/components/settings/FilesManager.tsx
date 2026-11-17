import { useCallback, useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { FileObject } from '../../services/api/types.js'
import { deleteFile, listFiles } from '../../services/api/client.js'
import { getDeepseekApiKey, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconRefreshOutline16, IconTrashOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import styles from './FilesManager.module.css'

/** 一页 20 个，与 Anthropic 兼容 Files API 的默认 limit 一致 */
const PAGE_SIZE = 20

/** 1024 进制；小于 1 KB 直接显示字节 */
const formatSize = (bytes: number | undefined): string => {
  if (!bytes || bytes <= 0) {
    return '–'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

/**
 * Files API 管理：列出、分页、删除。
 * 删除只影响服务端的文件；本地原件与历史消息不受影响，
 * 已经被历史消息引用的 file_id 被删除后，那一轮的图片会变成解析失败。
 */
export const FilesManager = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const hasKey = useSettings((state) => !!state.apiKeys.deepseek)
  const [files, setFiles] = useState<FileObject[]>([])
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (reset: boolean) => {
      const apiKey = getDeepseekApiKey()
      if (!apiKey) {
        return
      }
      setLoading(true)
      setError(null)
      try {
        const page = await listFiles(apiKey, {
          limit: PAGE_SIZE,
          ...(reset || files.length === 0 ? {} : { afterId: files[files.length - 1].id }),
        })
        setFiles((previous) => (reset ? page.data : [...previous, ...page.data]))
        setHasMore(page.has_more === true)
      } catch {
        setError(t('filesLoadFailed'))
      } finally {
        setLoading(false)
      }
    },
    [files, t]
  )

  // 打开数据管理并有 Key 时自动加载第一页
  useEffect(() => {
    if (hasKey && files.length === 0 && !loading) {
      void load(true)
    }
    // 只在首次进入时拉取；后续由按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKey])

  const remove = async (file: FileObject) => {
    const apiKey = getDeepseekApiKey()
    if (!apiKey || deleting) {
      return
    }
    setDeleting(file.id)
    try {
      await deleteFile(apiKey, file.id)
      setFiles((previous) => previous.filter((item) => item.id !== file.id))
      showToast({ key: 'filesDeleted' })
    } catch {
      showToast({ key: 'filesDeleteFailed', type: 'error' })
    } finally {
      setDeleting(null)
    }
  }

  if (!hasKey) {
    return null
  }

  return (
    <div className={styles.cell}>
      <div className={styles.header}>
        <div>
          <div className={styles.label}>{t('filesTitle')}</div>
          <div className={styles.description}>{t('filesDescription')}</div>
        </div>
        <IconButton
          icon={<IconRefreshOutline16 />}
          tooltip={t('filesRefresh')}
          aria-label={t('filesRefresh')}
          disabled={loading}
          onClick={() => void load(true)}
        />
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}
      {files.length === 0 && !loading ? (
        <div className={styles.empty}>{t('filesEmpty')}</div>
      ) : (
        <ul className={styles.list}>
          {files.map((file) => (
            <li key={file.id} className={styles.item}>
              <div className={styles.meta}>
                <span className={styles.name} title={file.filename}>
                  {file.filename}
                </span>
                <span className={styles.sub}>
                  {formatSize(file.size_bytes)} ·{' '}
                  {file.created_at ? new Date(file.created_at).toLocaleString(locale) : '–'}
                </span>
              </div>
              <IconButton
                icon={<IconTrashOutline16 />}
                tooltip={t('filesDelete')}
                aria-label={t('filesDelete')}
                disabled={deleting === file.id}
                onClick={() => void remove(file)}
              />
            </li>
          ))}
        </ul>
      )}

      {hasMore ? (
        <Button variant="outlined" size="s" disabled={loading} onClick={() => void load(false)}>
          {loading ? t('filesLoading') : t('filesLoadMore')}
        </Button>
      ) : null}
    </div>
  )
}
