import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import type { MessageUsage } from '../../services/api/types.js'
import { addUsage, inputTokens, totalTokens } from '../../services/chat/usage.js'
import styles from './TokenUsage.module.css'

/** One aggregate for the whole conversation, including alternate answers and continuations. */
export const SessionTokenUsage = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const usage = session.messages.reduce<MessageUsage | undefined>(
    (sum, message) => (message.role === 'assistant' ? addUsage(sum, message.usage) : sum),
    undefined
  )
  if (!usage) {
    return null
  }
  return (
    <dl className={styles.usage} title={t('tokenSessionHelp')} data-session-usage>
      <div>
        <dt>{t('tokenSession')}：</dt>
        <dd>{totalTokens(usage).toLocaleString()} tokens</dd>
      </div>
      <div>
        <dt>{t('tokenInput')}</dt>
        <dd>{inputTokens(usage).toLocaleString()}</dd>
      </div>
      {usage.cache_read_input_tokens > 0 ? (
        <div>
          <dt>{t('tokenCacheRead')}</dt>
          <dd>{usage.cache_read_input_tokens.toLocaleString()}</dd>
        </div>
      ) : null}
      {usage.cache_creation_input_tokens > 0 ? (
        <div>
          <dt>{t('tokenCacheWrite')}</dt>
          <dd>{usage.cache_creation_input_tokens.toLocaleString()}</dd>
        </div>
      ) : null}
      <div>
        <dt>{t('tokenOutput')}</dt>
        <dd>{usage.output_tokens.toLocaleString()}</dd>
      </div>
      {(usage.reasoning_tokens ?? 0) > 0 ? (
        <div>
          <dt>{t('tokenReasoning')}</dt>
          <dd>{usage.reasoning_tokens?.toLocaleString()}</dd>
        </div>
      ) : null}
    </dl>
  )
}
