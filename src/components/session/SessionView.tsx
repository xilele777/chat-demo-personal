import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'
import { SaveStatus } from './SaveStatus.js'
import { SessionTokenUsage } from '../messages/TokenUsage.js'
import { DesktopHeader } from './DesktopHeader.js'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({ session, streaming }: { session: Session; streaming: boolean }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const title = session.title || t('untitledChat')
  return (
    <div className={styles.view}>
      {isMobile ? <MobileHeader title={title} /> : <DesktopHeader title={title} />}
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          <div className={styles.inputContainer}>
            <ChatInput sessionId={session.id} />
            <div className={styles.statusRow}>
              <SessionTokenUsage session={session} />
              <SaveStatus sessionId={session.id} />
            </div>
            <div className={styles.caveat}>{t('contentCaveat')}</div>
          </div>
        }
      />
    </div>
  )
}
