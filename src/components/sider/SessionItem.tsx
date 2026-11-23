import clsx from 'clsx'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconEditOutline16,
  IconEllipsisOutline16,
  IconTrashOutline16,
  IconCheckOutline16,
} from '../base/icons.js'
import {
  prefetchSession,
  renameSession,
  selectSession,
  setSessionPinned,
} from '../../services/chat/store.js'
import { PinIcon } from '../base/PinIcon.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
  multi = false,
  selected = false,
  disabled = false,
  onToggle,
  onMultiSelect,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
  multi?: boolean
  selected?: boolean
  disabled?: boolean
  onToggle?: () => void
  onMultiSelect?: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const prefetchTimer = useRef(0)
  const cancelPrefetch = useCallback(() => window.clearTimeout(prefetchTimer.current), [])
  useEffect(() => cancelPrefetch, [cancelPrefetch])
  const displayTitle = session.title || t('untitledChat')

  if (editing && !multi) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      data-session-item={session.id}
      className={clsx(styles.item, (multi ? selected : active) && styles.active)}
      onPointerEnter={() => {
        cancelPrefetch()
        if (!multi) {
          prefetchTimer.current = window.setTimeout(() => prefetchSession(session.id), 100)
        }
      }}
      onPointerLeave={cancelPrefetch}
      onFocus={() => {
        if (!multi) {
          prefetchSession(session.id)
        }
      }}
      onClick={() => {
        if (disabled) {
          return
        }
        if (multi) {
          onToggle?.()
          return
        }
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      {multi ? (
        <span className={clsx(styles.check, selected && styles.checked)} aria-hidden="true">
          {selected ? '✓' : ''}
        </span>
      ) : null}
      <button
        type="button"
        className={styles.title}
        disabled={disabled}
        aria-current={!multi && active ? 'page' : undefined}
        role={multi ? 'checkbox' : undefined}
        aria-checked={multi ? selected : undefined}
      >
        {displayTitle}
      </button>
      {session.pinned ? (
        <span className={styles.pin} title={t('pinnedChats')}>
          <PinIcon />
        </span>
      ) : null}
      {multi ? null : (
        <div className={styles.action} onClick={(event) => event.stopPropagation()}>
          <Menu
            options={[
              {
                key: 'multi',
                label: t('multiSelect'),
                icon: <IconCheckOutline16 />,
                onSelect: () => onMultiSelect?.(),
              },
              {
                key: 'pin',
                label: t(session.pinned ? 'unpinChat' : 'pinChat'),
                icon: <PinIcon />,
                onSelect: () => setSessionPinned(session.id, !session.pinned),
              },
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => setEditing(true),
              },
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: onDelete,
              },
            ]}
          >
            {({ toggle }) => (
              <IconButton
                icon={<IconEllipsisOutline16 />}
                aria-label={`${t('more')} · ${displayTitle}`}
                onClick={toggle}
              />
            )}
          </Menu>
        </div>
      )}
    </div>
  )
})
