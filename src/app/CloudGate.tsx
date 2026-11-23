import { useEffect, useState, type ReactNode } from 'react'
import {
  CloudError,
  cloudFetch,
  cloudJson,
  cloudMode,
  loadCloudConfig,
  useCloud,
  type CloudConfig,
} from '../services/cloud.js'
import { useTranslate } from '../i18n/index.js'
import { ChatGPTBrand } from '../components/base/ChatGPTBrand.js'
import { Button } from '../components/base/Button.js'
import { Modal } from '../components/base/Modal.js'
import styles from './CloudGate.module.css'

export const CloudGate = ({ children }: { children: ReactNode }) => {
  const t = useTranslate()
  const [status, setStatus] = useState<'loading' | 'ready' | 'login' | 'setup' | 'error'>(
    cloudMode ? 'loading' : 'ready'
  )
  const [showLoading, setShowLoading] = useState(false)
  useEffect(() => {
    if (status !== 'loading') {
      setShowLoading(false)
      return
    }
    const timer = setTimeout(() => setShowLoading(true), 700)
    return () => clearTimeout(timer)
  }, [status])
  const [attempt, setAttempt] = useState(0)
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [loginError, setLoginError] = useState<
    'cloudPasswordWrong' | 'cloudPasswordRateLimited' | 'cloudConnectFailed' | null
  >(null)
  const authRequired = useCloud((s) => s.authRequired)
  useEffect(() => {
    if (!cloudMode) {
      return
    }
    let active = true
    if (authRequired) {
      useCloud.setState({ authRequired: false })
      setStatus('login')
      return
    }
    setStatus('loading')
    void (async () => {
      const auth = (await (await cloudFetch('/auth')).json()) as {
        configured: boolean
        authenticated: boolean
        config?: CloudConfig
      }
      if (!active) {
        return
      }
      if (auth.authenticated) {
        if (auth.config) {
          useCloud.setState({ config: auth.config, authRequired: false })
        } else {
          await loadCloudConfig()
        }
        if (active) {
          setStatus('ready')
        }
      } else {
        setStatus(auth.configured ? 'login' : 'setup')
      }
    })().catch(() => {
      if (active) {
        setStatus('error')
      }
    })
    return () => {
      active = false
    }
  }, [attempt, authRequired])
  const signIn = async () => {
    if (submitting) {
      return
    }
    setSubmitting(true)
    setLoginError(null)
    try {
      await cloudFetch('/auth/login', cloudJson('POST', { password }))
      setPassword('')
      await loadCloudConfig()
      setStatus('ready')
    } catch (cause) {
      setLoginError(
        cause instanceof CloudError && cause.status === 401
          ? 'cloudPasswordWrong'
          : cause instanceof CloudError && cause.status === 429
            ? 'cloudPasswordRateLimited'
            : 'cloudConnectFailed'
      )
    } finally {
      setSubmitting(false)
    }
  }
  if (status === 'loading') {
    return (
      <div className={styles.boot} aria-busy="true">
        <ChatGPTBrand />
        {showLoading ? <span role="status">{t('sessionLoading')}</span> : null}
      </div>
    )
  }
  return status === 'ready' ? (
    children
  ) : (
    <Modal
      title={t(status === 'login' ? 'cloudSignIn' : 'cloudTitle')}
      onClose={() => {}}
      footer={
        status === 'error' || status === 'setup' ? (
          <Button
            variant="outlined"
            size="m"
            onClick={() => {
              setAttempt((n) => n + 1)
            }}
          >
            {t('retry')}
          </Button>
        ) : undefined
      }
    >
      {status === 'login' ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault()
            void signIn()
          }}
        >
          <p className={styles.description}>{t('cloudSignInDescription')}</p>
          <label htmlFor="access-password">{t('cloudPasswordLabel')}</label>
          <div className={styles.input}>
            <input
              id="access-password"
              name="password"
              type={visible ? 'text' : 'password'}
              autoComplete="current-password"
              required
              autoFocus
              enterKeyHint="go"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(loginError)}
              aria-describedby={loginError ? 'access-password-error' : undefined}
            />
            <button
              type="button"
              className={styles.toggle}
              aria-pressed={visible}
              onClick={() => setVisible((value) => !value)}
            >
              {t(visible ? 'cloudPasswordHide' : 'cloudPasswordShow')}
            </button>
          </div>
          {loginError ? (
            <div id="access-password-error" role="alert" className={styles.error}>
              {t(loginError)}
            </div>
          ) : null}
          <Button type="submit" size="l" block disabled={submitting}>
            {t(submitting ? 'cloudSigningIn' : 'cloudSignIn')}
          </Button>
          <p className={styles.description}>{t('cloudForgotPassword')}</p>
        </form>
      ) : (
        <p role="status">
          {t(
            status === 'setup'
              ? 'cloudPasswordSetup'
              : status === 'error'
                ? 'cloudConnectFailed'
                : 'sessionLoading'
          )}
        </p>
      )}
    </Modal>
  )
}
