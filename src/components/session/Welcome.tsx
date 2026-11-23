import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'
import { DesktopHeader } from './DesktopHeader.js'
import { ChatGPTMark } from '../base/ChatGPTBrand.js'

/** 新对话：问候语与输入框作为整体居中，与原版欢迎页保持一致。 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : <DesktopHeader />}
      <div className={styles.welcome}>
        <div className={styles.greeting}>
          <ChatGPTMark />
          <h1>{t('welcomeMessageChat250808')}</h1>
        </div>
        <ChatInput sessionId={null} />
      </div>
    </div>
  )
}
