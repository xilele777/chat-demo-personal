import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconPanelLeftOutline16,
  IconSettingsOutline16,
  NewChatIcon,
  HistorySearchIcon,
  IconCloseOutline16,
  IconTrashOutline16,
  IconCheckOutline16,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { useSessionSelection, clearSessionSelection } from '../../services/chat/selection.js'
import {
  newChat,
  removeSession,
  setSessionPinned,
  useChatStore,
} from '../../services/chat/store.js'
import { PinIcon } from '../base/PinIcon.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import { ChatGPTBrand } from '../base/ChatGPTBrand.js'
import styles from './Sider.module.css'
import { openHistorySearch } from '../../services/chat/historySearchState.js'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary[] | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const importing = useChatStore((state) => state.importingHistory)
  const { multi, selected } = useSessionSelection()
  const setMulti = (multi: boolean) => useSessionSelection.setState({ multi })
  const setSelected = (value: Set<string> | ((previous: Set<string>) => Set<string>)) =>
    useSessionSelection.setState((state) => ({
      selected: typeof value === 'function' ? value(state.selected) : value,
    }))
  const selectedSessions = sessions.filter((session) => selected.has(session.id))
  const allPinned =
    selectedSessions.length > 0 && selectedSessions.every((session) => session.pinned)
  const exitMulti = () => {
    clearSessionSelection()
  }
  const goHome = () => {
    exitMulti()
    newChat()
    closeMobileSider()
  }
  const toggleSelection = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  useEffect(() => {
    setSelected((previous) => {
      const next = new Set(
        [...previous].filter((id) => sessions.some((session) => session.id === id))
      )
      return next.size === previous.size ? previous : next
    })
  }, [sessions])
  useEffect(() => {
    if (!multi || deleting) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMulti(false)
        setSelected(new Set())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [multi, deleting])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)} data-chat-sidebar>
      <div className={styles.top}>
        <div className={styles.appName}>
          <ChatGPTBrand onClick={goHome} />
        </div>
        <div className={styles.headerActions}>
          <IconButton
            size="xs"
            icon={<HistorySearchIcon />}
            tooltip={t('historySearch')}
            tooltipPlacement="bottom"
            onClick={() => {
              closeMobileSider()
              openHistorySearch()
            }}
          />
          <IconButton
            size="m"
            icon={<IconPanelLeftOutline16 />}
            tooltip={t('collapseSiderbarButton')}
            tooltipPlacement="bottom"
            onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
          />
        </div>
      </div>
      {multi ? (
        <div className={styles.batchHeading}>
          <span>{t('selectedChats', { count: selectedSessions.length })}</span>
          <IconButton
            icon={<IconCloseOutline16 />}
            aria-label={t('exitMultiSelect')}
            onClick={exitMulti}
            disabled={deletePending}
          />
        </div>
      ) : (
        <button type="button" className={styles.newChat} onClick={goHome}>
          <span className={styles.newChatIcon}>
            <NewChatIcon />
          </span>
          {t('newChat')}
        </button>
      )}
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {groups.map((group, index) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>
                <span>{group.label}</span>
                {index === 0 && multi ? (
                  <button
                    type="button"
                    className={styles.batchEntry}
                    aria-label={t(
                      multi
                        ? selectedSessions.length === sessions.length
                          ? 'deselectAllChats'
                          : 'selectAllChats'
                        : 'multiSelect'
                    )}
                    title={t(
                      multi
                        ? selectedSessions.length === sessions.length
                          ? 'deselectAllChats'
                          : 'selectAllChats'
                        : 'multiSelect'
                    )}
                    disabled={importing || deletePending}
                    onClick={() => {
                      if (!multi) {
                        setMulti(true)
                        setSelected(new Set())
                      } else {
                        setSelected(
                          selectedSessions.length === sessions.length
                            ? new Set()
                            : new Set(sessions.map((session) => session.id))
                        )
                      }
                    }}
                  >
                    <IconCheckOutline16 />
                  </button>
                ) : null}
              </div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  onDelete={() => setDeleting([session])}
                  multi={multi}
                  selected={selected.has(session.id)}
                  disabled={deletePending || importing}
                  onToggle={() => toggleSelection(session.id)}
                  onMultiSelect={() => {
                    setMulti(true)
                    setSelected(new Set([session.id]))
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {multi ? (
        <div className={styles.batchActions}>
          <button
            type="button"
            disabled={!selectedSessions.length || deletePending || importing}
            onClick={() => {
              for (const session of selectedSessions) {
                setSessionPinned(session.id, !allPinned)
              }
            }}
          >
            <PinIcon />
            {t(allPinned ? 'unpinChat' : 'pinChat')}
          </button>
          <button
            type="button"
            className={styles.danger}
            disabled={!selectedSessions.length || deletePending || importing}
            onClick={() => setDeleting(selectedSessions)}
          >
            <IconTrashOutline16 />
            {t('delete')}
          </button>
        </div>
      ) : (
        <div className={styles.bottom}>
          <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
            <span className={styles.settingsIcon}>
              <IconSettingsOutline16 />
            </span>
            <span className={styles.settingsLabel}>{t('settings')}</span>
          </button>
        </div>
      )}
      {deleting ? (
        <Modal
          title={
            deleting.length > 1
              ? t('deleteSelectedChats', { count: deleting.length })
              : t('deleteSessionModalContentTitle')
          }
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    const failed: SessionSummary[] = []
                    for (const session of deleting) {
                      if (!(await removeSession(session.id))) {
                        failed.push(session)
                      }
                    }
                    if (!failed.length) {
                      setDeleting(null)
                      if (multi) {
                        exitMulti()
                      }
                    } else {
                      setDeleting(failed)
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
          <ul className={styles.deleteList}>
            {deleting.map((session) => (
              <li key={session.id}>{session.title || t('untitledChat')}</li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) {
      return
    }
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('dialog[open]')) {
        return
      }
      if (event.key === 'Escape') {
        closeMobileSider()
      }
      if (event.key === 'Tab') {
        const buttons = [
          ...(ref.current?.querySelectorAll<HTMLButtonElement>(
            'button:not(:disabled), input:not(:disabled)'
          ) ?? []),
        ]
        const first = buttons[0],
          last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (previous?.isConnected) {
        previous.focus()
      }
    }
  }, [open])
  return (
    <div
      ref={ref}
      className={clsx(styles.drawerLayer, open && styles.drawerOpen)}
      aria-hidden={!open}
      {...({ inert: open ? undefined : '' } as Record<string, string | undefined>)}
    >
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={styles.drawer}>
        <Sider mobile />
      </div>
    </div>
  )
}
