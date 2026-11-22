import clsx from 'clsx'

import styles from './Shimmer.module.css'

/**
 * 官方的扫光文字：正文保持原色，上方叠一层白色高光条从左向右扫过（2s ease-out 无限循环）。
 * 高光条宽度固定，末尾的透明副本负责撑出文字宽度。
 */
export const Shimmer = ({
  text,
  width = 120,
  active = true,
  className,
}: {
  text: string
  width?: number
  active?: boolean
  className?: string
}) => (
  <span className={clsx(styles.shimmer, className)}>
    {text}
    {active ? (
      <span className={styles.overlay}>
        <span className={styles.band} style={{ width }} />
        <span className={styles.spacer}>{text}</span>
      </span>
    ) : null}
  </span>
)
