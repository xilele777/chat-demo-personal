import { useTranslate } from '../../i18n/index.js'
import type { ContextReport } from '../../services/chat/contextReport.js'
import styles from './ContextDetails.module.css'
import { useChatStore } from '../../services/chat/store.js'

export const ContextDetails = ({
  reports,
  sessionId,
}: {
  reports: ContextReport[]
  sessionId: string
}) => {
  const t = useTranslate()
  const messages = useChatStore((state) => state.sessionCache[sessionId]?.messages)
  const latest = reports[reports.length - 1]
  return (
    <details className={styles.details} data-context-details>
      <summary>
        {t('contextSummary', { retained: latest.retainedRounds, omitted: latest.omittedRounds })}
      </summary>
      <p>{t('contextExplanation')}</p>
      {latest.retainedQuestionIds[0] ? (
        <p>
          {t('contextStartQuestion', {
            question: (() => {
              const question = messages?.find(
                (message) => message.id === latest.retainedQuestionIds[0]
              )
              return question?.role === 'user'
                ? (question.content || question.files.map((file) => file.name).join(', ')).slice(
                    0,
                    100
                  )
                : latest.retainedQuestionIds[0]
            })(),
          })}
        </p>
      ) : null}
      <ol>
        {reports.map((report, index) => (
          <li key={index}>
            {t('contextRange', {
              first: report.firstRetainedRound,
              last: report.totalRounds,
              estimated: report.estimatedInputTokens,
              input: report.inputBudget,
              output: report.outputBudget,
              window: report.contextWindow ?? t('contextUnknown'),
            })}
          </li>
        ))}
      </ol>
    </details>
  )
}
