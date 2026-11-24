import { useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { WhaleMark } from '../brand/BrandLogo.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { OnboardingCard } from './OnboardingCard.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 按当前时段挑选问候语；每次进入新对话重新挑一条，与官方一样会变化 */
const pickGreeting = (now: Date): TranslationKey => {
  const hour = now.getHours()
  const slots: TranslationKey[][] = [
    [ 'welcomeGreetingNight' ],
    [ 'welcomeGreetingMorning' ],
    [ 'welcomeGreetingNoon' ],
    [ 'welcomeGreetingAfternoon' ],
    [ 'welcomeGreetingEvening' ],
  ]
  const slot =
    hour < 5 ? slots[0] : hour < 11 ? slots[1] : hour < 14 ? slots[2] : hour < 18 ? slots[3] : slots[4]
  const options = [...slot, 'welcomeGreetingWelcome' as TranslationKey]
  return options[Math.floor(Math.random() * options.length)]
}

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const [greeting] = useState(() => pickGreeting(new Date()))
  // 没有任何服务商配置 Key 时显示首次引导；填入 Key 后自动回到正常欢迎页
  const hasAnyKey = useSettings((state) => Object.values(state.apiKeys).some((v) => !!v))
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>
          <WhaleMark className={styles.whale} />
          <span>{t(greeting)}</span>
        </div>
        {!hasAnyKey ? <OnboardingCard /> : null}
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
