import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCloseOutline16,
  IconDownloadOutline16,
  IconZoomInOutline16,
  IconZoomOutOutline16,
} from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import styles from './ImageLightbox.module.css'

/** 图片灯箱：全屏预览，支持缩放与下载原图；Esc / 点背景关闭 */
export const ImageLightbox = ({
  src,
  name,
  onClose,
}: {
  src: string
  name: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return createPortal(
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <img
        className={styles.image}
        src={src}
        alt={name}
        style={{ transform: `scale(${scale})` }}
        onDoubleClick={() => setScale((value) => (value === 1 ? 2 : 1))}
      />
      <div className={styles.actions}>
        <IconButton
          tone="primary"
          icon={<IconZoomOutOutline16 />}
          tooltip={t('imageZoomOut')}
          onClick={() => setScale((value) => Math.max(0.5, Number((value - 0.25).toFixed(2))))}
        />
        <IconButton
          tone="primary"
          icon={<IconZoomInOutline16 />}
          tooltip={t('imageZoomIn')}
          onClick={() => setScale((value) => Math.min(4, Number((value + 0.25).toFixed(2))))}
        />
        <a
          className={styles.download}
          href={src}
          download={name}
          title={t('imageDownload')}
          aria-label={t('imageDownload')}
        >
          <IconDownloadOutline16 />
        </a>
        <IconButton
          tone="primary"
          icon={<IconCloseOutline16 />}
          tooltip={t('close')}
          onClick={onClose}
        />
      </div>
    </div>,
    document.body
  )
}
