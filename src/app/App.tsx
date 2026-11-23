import { useEffect, useState } from 'react'
import { cloudMode } from '../services/cloud.js'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  bindCloudSync,
  keepCopiesAndSync,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { DesktopHeader } from '../components/session/DesktopHeader.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import styles from './App.module.css'
import { HistorySearch } from '../components/search/HistorySearch.js'
import { openHistorySearch } from '../services/chat/historySearchState.js'
import { useSettingsDialog } from '../components/settings/settingsDialogState.js'
import { loadModels } from '../services/models.js'

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const saveErrors = useChatStore((state) => state.sessionSaveErrors)
  const saveDetails = useChatStore((state) => state.sessionSaveDetails)
  const summaries = useChatStore((state) => state.sessions)
  const retryingSaves = useChatStore((state) =>
    Object.entries(state.sessionSaving).some(
      ([id, saving]) => saving && state.sessionSaveErrors[id]
    )
  )
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)
  const loadingKey = !ready ? 'initial' : activeId !== null && !session ? activeId : null
  const [loadingNoticeKey, setLoadingNoticeKey] = useState<string | null>(null)
  const loadError = !ready ? initError : sessionLoadError

  useEffect(() => {
    if (loadingKey === null) {
      setLoadingNoticeKey(null)
      return
    }
    const timer = setTimeout(() => setLoadingNoticeKey(loadingKey), 600)
    return () => clearTimeout(timer)
  }, [loadingKey])

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])
  useEffect(bindCloudSync, [])
  useEffect(() => {
    if (cloudMode) {
      void loadModels()
    }
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'k' &&
        !useSettingsDialog.getState().open
      ) {
        event.preventDefault()
        openHistorySearch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    void initChat()
    // 首次打开先在设置里输入 API Key
    ensureApiKey()
  }, [])

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
        <main className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <details>
                <summary>
                  {t('saveFailedCount', {
                    count: Object.values(saveErrors).filter(Boolean).length,
                  })}
                </summary>
                <ul>
                  {Object.entries(saveErrors)
                    .filter(([, failed]) => failed)
                    .map(([id]) => (
                      <li key={id}>
                        {summaries.find((session) => session.id === id)?.title || t('untitledChat')}
                        :{' '}
                        {saveDetails[id]?.status === 409
                          ? t('saveConflict')
                          : saveDetails[id]?.message ||
                            t(cloudMode ? 'cloudSaveFailed' : 'sessionSaveFailed')}
                      </li>
                    ))}
                </ul>
              </details>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory || retryingSaves}
                onClick={retrySaveSessions}
              >
                {t(retryingSaves ? 'saveRetrying' : 'retry')}
              </Button>
              {cloudMode ? (
                <Button
                  variant="outlined"
                  size="s"
                  disabled={importingHistory || streaming}
                  onClick={() => {
                    void keepCopiesAndSync()
                  }}
                >
                  {t('cloudKeepCopies')}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className={styles.content}>
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView} aria-busy={!loadError}>
                {isMobile ? <MobileHeader /> : <DesktopHeader />}
                {loadError || loadingNoticeKey === loadingKey ? (
                  <div className={styles.loadingState} role="status" aria-live="polite">
                    <span>
                      {loadError
                        ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                        : t('sessionLoading')}
                    </span>
                    {loadError ? (
                      <Button
                        variant="outlined"
                        size="m"
                        onClick={() => {
                          if (!ready) {
                            void initChat()
                          } else if (activeId !== null) {
                            selectSession(activeId)
                          }
                        }}
                      >
                        {t('retry')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : session ? (
              <SessionView session={session} streaming={streaming} />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
      </div>
      <SettingsDialog />
      <HistorySearch />
      <Toast />
    </>
  )
}
