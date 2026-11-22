import { useState } from 'react'
import { cloudFetch, useCloud } from '../../services/cloud.js'
import { syncCloudSessions, uploadLocalHistory, useChatStore } from '../../services/chat/store.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import styles from './Settings.module.css'

export const CloudSettings = () => {
  const t = useTranslate()
  const { config, syncing, error, lastSyncedAt } = useCloud()
  const busy = useChatStore(
    (s) =>
      s.importingHistory ||
      Object.keys(s.streaming).length > 0 ||
      Object.values(s.sessionSaveErrors).some(Boolean)
  )
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  return (
    <>
      <div className={styles.cell}>
        <div className={styles.label}>
          {t('cloudProvider')}
          {config ? ` · ${config.model} (${config.protocol})` : ''}
        </div>
        <div className={config?.configured ? styles.description : styles.error}>
          {t(config?.configured ? 'cloudConfigured' : 'cloudNotConfigured')}
        </div>
      </div>
      <div className={`${styles.cell} ${styles.row}`}>
        <div className={styles.text}>
          <div className={styles.label}>{t('cloudTitle')}</div>
          <div className={styles.description}>{t('cloudSyncDescription')}</div>
          {lastSyncedAt ? (
            <div className={styles.description}>
              {t('cloudSynced', { time: new Date(lastSyncedAt).toLocaleTimeString() })}
            </div>
          ) : null}
          {error ? (
            <div role="status" className={styles.error}>
              {error}
            </div>
          ) : null}
        </div>
        <Button
          variant="outlined"
          size="m"
          disabled={syncing || busy || uploading}
          onClick={() => {
            void syncCloudSessions()
          }}
        >
          {t(syncing ? 'cloudSyncing' : 'cloudSync')}
        </Button>
      </div>
      <div className={`${styles.cell} ${styles.row}`}>
        <div className={styles.text}>
          <div className={styles.label}>{t('cloudSignOut')}</div>
          <div className={styles.description}>{t('cloudSignOutDescription')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          disabled={busy || uploading || syncing}
          onClick={() => {
            void cloudFetch('/auth/logout', { method: 'POST' })
              .then(() => window.location.reload())
              .catch(() => {
                setFailed(true)
                setMessage(t('cloudConnectFailed'))
              })
          }}
        >
          {t('cloudSignOut')}
        </Button>
      </div>
      <div className={`${styles.cell} ${styles.row}`}>
        <div className={styles.text}>
          <div className={styles.label}>{t('cloudMigrate')}</div>
          <div className={styles.description}>{t('cloudMigrateDescription')}</div>
          {message ? (
            <div role="status" className={failed ? styles.error : styles.description}>
              {message}
            </div>
          ) : null}
        </div>
        <Button
          variant="outlined"
          size="m"
          disabled={busy || uploading || syncing}
          onClick={() => {
            setUploading(true)
            setMessage(null)
            setFailed(false)
            void uploadLocalHistory()
              .then((count) => setMessage(t('cloudMigrated', { count })))
              .catch((cause: unknown) => {
                setFailed(true)
                setMessage(cause instanceof Error ? cause.message : t('cloudConnectFailed'))
              })
              .finally(() => setUploading(false))
          }}
        >
          {t(uploading ? 'cloudSyncing' : 'upload')}
        </Button>
      </div>
    </>
  )
}
