import { useEffect, useId, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { cloudFetch, cloudMode } from '../../services/cloud.js'
import { searchLocalHistory } from '../../services/chat/localDb.js'
import { searchSession, type HistorySearchResult } from '../../services/chat/search.js'
import { revealSessionMessage, useChatStore } from '../../services/chat/store.js'
import { closeHistorySearch, useHistorySearch } from '../../services/chat/historySearchState.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { HistorySearchIcon, IconCloseOutline16 } from '../base/icons.js'
import { useSettings } from '../../services/settings.js'
import styles from './HistorySearch.module.css'

export const HistorySearch = () =>
  useHistorySearch((state) => state.open) ? <SearchDialog /> : null

const Highlight = ({ text, query }: { text: string; query: string }) => {
  const at = text.toLowerCase().indexOf(query.trim().toLowerCase())
  return at < 0 || !query.trim() ? (
    text
  ) : (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.trim().length)}</mark>
      {text.slice(at + query.trim().length)}
    </>
  )
}

const SearchDialog = () => {
  const t = useTranslate()
  const id = useId()
  const locale = useSettings((state) => state.locale)
  const listRef = useRef<HTMLOListElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const openController = useRef<AbortController | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HistorySearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [limited, setLimited] = useState(false)
  const [retry, setRetry] = useState(0)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<HistorySearchResult | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  useEffect(() => () => openController.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    const needle = query.trim()
    setError('')
    setOpenError(null)
    setActiveIndex(-1)
    setResults([])
    setLimited(false)
    if (!needle) {
      setLoading(false)
      return
    }
    setLoading(true)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = cloudMode
            ? ((await (
                await cloudFetch(`/history/search?q=${encodeURIComponent(needle)}`, {
                  signal: controller.signal,
                })
              ).json()) as { results: HistorySearchResult[]; limited: boolean })
            : { results: await searchLocalHistory(needle, controller.signal), limited: false }
          if (controller.signal.aborted) {
            return
          }
          // Include current in-memory changes, replacing any stale saved hits for these sessions.
          const state = useChatStore.getState()
          const existing = new Set(state.sessions.map((session) => session.id))
          const cached = Object.values(state.sessionCache).filter((session) =>
            existing.has(session.id)
          )
          const ids = new Set(cached.map((session) => session.id))
          const matches = [
            ...response.results.filter(
              (result) => existing.has(result.sessionId) && !ids.has(result.sessionId)
            ),
            ...cached.flatMap((session) => searchSession(session, needle)),
          ].sort((a, b) => b.updatedAt - a.updatedAt)
          setResults(matches.slice(0, 50))
          setLimited(response.limited || matches.length > 50)
        } catch {
          if (!controller.signal.aborted) {
            setError(t('historySearchFailed'))
          }
        } finally {
          if (!controller.signal.aborted) {
            setLoading(false)
          }
        }
      })()
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, retry, t])
  const open = async (result: HistorySearchResult) => {
    if (openController.current) {
      return
    }
    const controller = new AbortController()
    openController.current = controller
    setOpening(true)
    setOpenError(null)
    try {
      if (!(await revealSessionMessage(result.sessionId, result.messageId, controller.signal))) {
        if (!controller.signal.aborted) {
          setOpenError(result)
        }
        return
      }
      if (controller.signal.aborted) {
        return
      }
      if (result.messageId) {
        useHistorySearch.setState({
          jump: { sessionId: result.sessionId, messageId: result.messageId, nonce: Date.now() },
        })
      }
      closeHistorySearch()
    } catch {
      if (!controller.signal.aborted) {
        setOpenError(result)
      }
    } finally {
      openController.current = null
      if (!controller.signal.aborted) {
        setOpening(false)
      }
    }
  }
  return (
    <Modal
      title={t('historySearch')}
      hideHeading
      className={styles.dialog}
      overlayClassName={styles.overlay}
      mainClassName={styles.main}
      onClose={closeHistorySearch}
    >
      <search className={styles.search}>
        <HistorySearchIcon />
        <label htmlFor={id} className={styles.hiddenLabel}>
          {t('historySearchHint')}
        </label>
        <input
          ref={inputRef}
          id={id}
          name="q"
          type="search"
          maxLength={200}
          value={query}
          disabled={opening}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder={t('historySearchHint')}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || opening || loading || !results.length) {
              return
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button')
              buttons?.[event.key === 'ArrowDown' ? 0 : results.length - 1]?.focus()
            } else if (event.key === 'Enter') {
              event.preventDefault()
              void open(results[activeIndex < 0 ? 0 : activeIndex])
            }
          }}
        />
        <IconButton
          icon={<IconCloseOutline16 />}
          aria-label={t('close')}
          onClick={closeHistorySearch}
        />
      </search>
      <div role="status" className={styles.status}>
        {loading
          ? t('historySearching')
          : (openError ? t('historySearchJumpFailed') : error) ||
            (!query.trim()
              ? ''
              : !results.length
                ? t('historySearchEmpty')
                : limited
                  ? t('historySearchLimited')
                  : '')}
        {error || openError ? (
          <Button
            size="s"
            variant="outlined"
            disabled={opening}
            onClick={() => {
              if (openError) {
                void open(openError)
              } else {
                setRetry((value) => value + 1)
              }
            }}
          >
            {t('retry')}
          </Button>
        ) : null}
      </div>
      <ol ref={listRef} className={styles.results}>
        {results.map((result, index) => (
          <li key={`${result.sessionId}:${result.messageId}`}>
            <button
              type="button"
              disabled={opening}
              onClick={() => void open(result)}
              className={`${styles.result} ${index === activeIndex ? styles.resultActive : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(-1)}
              onFocus={() => setActiveIndex(index)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  if (event.key === 'ArrowUp' && index === 0) {
                    inputRef.current?.focus()
                    return
                  }
                  const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button')
                  buttons?.[
                    (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length
                  ]?.focus()
                } else if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button')
                  buttons?.[event.key === 'Home' ? 0 : results.length - 1]?.focus()
                }
              }}
            >
              <span className={styles.resultIcon} aria-hidden="true">
                <HistorySearchIcon />
              </span>
              <span className={styles.resultBody}>
                <span className={styles.resultTitle}>
                  <Highlight text={result.title || t('untitledChat')} query={query} />
                </span>
                <span className={styles.excerpt}>
                  <Highlight text={result.excerpt} query={query} />
                </span>
              </span>
              <time className={styles.date} dateTime={new Date(result.updatedAt).toISOString()}>
                {new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(
                  result.updatedAt
                )}
              </time>
            </button>
          </li>
        ))}
      </ol>
    </Modal>
  )
}
