import { useEffect, useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import type { MessageUsage } from '../../services/api/types.js'
import { addUsage, inputTokens, totalTokens } from '../../services/chat/usage.js'
import styles from './TokenUsage.module.css'
import { IconChevronDownOutline14 } from '../base/icons.js'

/** One aggregate for the whole conversation, including alternate answers and continuations. */
export const SessionTokenUsage = ({
  session,
  streaming,
}: {
  session: Session
  streaming: boolean
}) => {
  const t = useTranslate()
  const ref = useRef<HTMLDetailsElement>(null)
  const answers = session.messages.filter((message) => message.role === 'assistant')
  const reported = answers.filter((message) => message.usage)
  const usage = session.messages.reduce<MessageUsage | undefined>(
    (sum, message) => (message.role === 'assistant' ? addUsage(sum, message.usage) : sum),
    undefined
  )
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) {
        ref.current.open = false
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && ref.current?.open) {
        ref.current.open = false
        ref.current.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [])
  useEffect(() => {
    if (ref.current) {
      ref.current.open = false
    }
  }, [session.id])
  if (!usage) {
    return (
      <span className={styles.usage} data-session-usage>
        <span className={styles.summary}>
          <span className={styles.total}>
            <span>{t('tokenSession')}</span>
            <strong>— tokens</strong>
          </span>
          <span className={styles.quick}>
            {t('tokenInput')} <b>—</b>
            <span>·</span>
            {t('tokenOutput')} <b>—</b>
          </span>
          <span role="status">{t(streaming ? 'tokenPending' : 'tokenUnavailable')}</span>
        </span>
      </span>
    )
  }
  const input = inputTokens(usage),
    output = usage.output_tokens,
    total = totalTokens(usage)
  const cache = usage.cache_read_input_tokens
  const cacheKnown = usage.cache_reported ?? cache > 0
  const reasoningComplete = reported.every(
    (message) => message.usage?.reasoning_tokens !== undefined
  )
  const rate = input > 0 && cacheKnown ? (cache / input) * 100 : undefined
  const format = (value: number) => value.toLocaleString()
  const rateText =
    rate === undefined ? '—' : `${rate.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
  const stat = (label: string, value: string, className?: string) => (
    <div className={className}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
  return (
    <details ref={ref} className={styles.usage} data-session-usage>
      <summary className={styles.summary} title={t('tokenDetails')}>
        <span className={styles.total}>
          <span>{t('tokenSession')}</span>
          <strong>{format(total)} tokens</strong>
        </span>
        <span className={styles.quick}>
          {t('tokenInput')} <b>{format(input)}</b>
          <span>·</span>
          {t('tokenOutput')} <b>{format(output)}</b>
        </span>
        <span className={styles.cacheBadge}>
          {t('tokenCacheRate')} <b>{rateText}</b>
        </span>
        {streaming ? <span role="status">{t('tokenUpdating')}</span> : null}
        <IconChevronDownOutline14 />
      </summary>
      <section className={styles.panel} aria-label={t('tokenUsage')}>
        <div className={styles.panelHeading}>
          <strong>{t('tokenUsage')}</strong>
          <span>
            {t('tokenReplies')} {reported.length} / {answers.length}
          </span>
        </div>
        <dl className={styles.metrics}>
          {stat(t('tokenInput'), format(input), styles.input)}
          {stat(t('tokenOutput'), format(output), styles.output)}
          {stat(t('tokenUncached'), format(usage.input_tokens))}
          {stat(
            t('tokenReasoning'),
            usage.reasoning_tokens === undefined
              ? t('tokenNotReported')
              : format(usage.reasoning_tokens)
          )}
          {stat(
            t('tokenCacheRead'),
            cacheKnown || cache > 0 ? format(cache) : t('tokenNotReported')
          )}
          {stat(
            t('tokenVisibleOutput'),
            !reasoningComplete
              ? t('tokenNotReported')
              : format(Math.max(0, output - (usage.reasoning_tokens ?? 0)))
          )}
          {stat(
            t('tokenCacheWrite'),
            cacheKnown ? format(usage.cache_creation_input_tokens) : t('tokenNotReported')
          )}
          {stat(t('tokenCacheRate'), rateText)}
        </dl>
        <div
          className={styles.bar}
          role="img"
          aria-label={`${t('tokenComposition')}: ${t('tokenInput')} ${format(input)}, ${t('tokenOutput')} ${format(output)}`}
        >
          <span
            className={styles.inputBar}
            style={{ width: `${total ? (input / total) * 100 : 0}%` }}
          />
          <span
            className={styles.outputBar}
            style={{ width: `${total ? (output / total) * 100 : 0}%` }}
          />
        </div>
      </section>
    </details>
  )
}
