import { BRAND_LOCKUP_PATHS, WELCOME_WHALE_PATH } from '../../services/brandArt.js'

/**
 * DeepSeek 品牌标识（鲸鱼 + deepseek 字标）。
 *
 * 路径来自对 chat.deepseek.com 公开产物的逆向，viewBox 0 0 182 29。
 * 用 currentColor 渲染，跟随主题色；高度由调用方的 CSS 决定。
 */
export const BrandLogo = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 182 29"
    fill="currentColor"
    role="img"
    aria-label="DeepSeek"
    xmlns="http://www.w3.org/2000/svg"
  >
    {BRAND_LOCKUP_PATHS.map((d, index) => (
      // eslint-disable-next-line react/no-array-index-key
      <path key={index} d={d} />
    ))}
  </svg>
)

/** 欢迎页问候语左侧的小鲸鱼；颜色取品牌色，与官方一致 */
export const WhaleMark = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 35 26"
    fill="none"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path fill="var(--dsw-alias-brand-primary)" d={WELCOME_WHALE_PATH} />
  </svg>
)
