import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { toMemorySource } from '../../services/chat/reply.js'
import { memoryDigest, type BranchMemory } from '../../services/chat/branchMemory.js'
import styles from './ContextDetails.module.css'

export const BranchMemoryDetails = ({
  memory,
  sessionId,
}: {
  memory: BranchMemory
  sessionId: string
}) => {
  const t = useTranslate()
  const session = useChatStore((state) => state.sessionCache[sessionId])
  const [verified, setVerified] = useState<BranchMemory | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) {
      return
    }
    let active = true
    setVerified(null)
    const path = session ? getVisibleMessages(session) : []
    const sources = path.filter((message) => memory.sourceIds.includes(message.id))
    if (
      sources.length === memory.sourceIds.length &&
      sources.every((source, index) => source.id === memory.sourceIds[index])
    ) {
      void memoryDigest(sources.map(toMemorySource))
        .then((digest) => {
          if (active && digest === memory.sourceDigest) {
            setVerified(memory)
          }
        })
        .catch(() => {})
    }
    return () => {
      active = false
    }
  }, [session, memory, open])
  return (
    <details
      className={styles.details}
      data-branch-memory
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t('branchMemoryTitle')}</summary>
      <p>{t(verified === memory ? 'branchMemoryHelp' : 'branchMemoryInvalid')}</p>
      {verified === memory ? (
        <>
          <p>
            {t('branchMemoryBudget', {
              sources: memory.sourceIds.length,
              missing: memory.omittedSources,
              tokens: memory.estimatedTokens,
            })}
          </p>
          <ol>
            {memory.excerpts.map((excerpt) => (
              <li key={excerpt.id}>
                <p>
                  {t(excerpt.role === 'user' ? 'branchMemoryUser' : 'branchMemoryAssistant', {
                    id: excerpt.id,
                  })}
                </p>
                <p>
                  {excerpt.text}
                  {excerpt.truncated ? t('branchMemoryTruncated') : ''}
                </p>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </details>
  )
}
