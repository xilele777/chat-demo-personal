import { useTranslate } from '../../i18n/index.js'
import { retrySaveSessions, useChatStore } from '../../services/chat/store.js'
import styles from './SessionView.module.css'

export const SaveStatus = ({ sessionId }: { sessionId: string }) => {
  const t = useTranslate()
  const saving = useChatStore((state) => state.sessionSaving[sessionId])
  const failed = useChatStore((state) => state.sessionSaveErrors[sessionId])
  const detail = useChatStore((state) => state.sessionSaveDetails[sessionId])
  const disabled = useChatStore((state) => state.importingHistory)
  if (!failed) {
    return null
  }
  const label = t(saving ? 'saveRetrying' : 'saveFailed')
  return (
    <span
      className={failed ? styles.statusError : undefined}
      title={detail?.status === 409 ? t('saveConflict') : detail?.message}
    >
      {label}
      {failed && !saving ? (
        <button type="button" disabled={disabled} onClick={retrySaveSessions}>
          {t('retry')}
        </button>
      ) : null}
    </span>
  )
}
