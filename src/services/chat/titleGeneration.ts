import { cloudFetch, cloudJson } from '../cloud.js'
import { getReplyText } from './reply.js'
import type { Session, UserMessage, AssistantMessage } from './types.js'

export function createTitleGenerator(host: {
  enabled: boolean
  getSession(id: string): Session | undefined
  epoch(): number
  blocked(id: string): boolean
  updateSession(id: string, update: (session: Session) => Session): void
  persist(id: string): void
}) {
  const generatingTitles = new Set<string>()
  return async (
    sessionId: string,
    question: UserMessage,
    reply: AssistantMessage,
    signal: AbortSignal
  ) => {
    const session = host.getSession(sessionId)
    const epoch = host.epoch()
    if (
      !host.enabled ||
      signal.aborted ||
      session?.titleSource !== 'pending' ||
      generatingTitles.has(sessionId) ||
      host.blocked(sessionId) ||
      reply.status !== 'done' ||
      reply.stopReason === 'refusal' ||
      !getReplyText(reply).trim()
    ) {
      return
    }
    generatingTitles.add(sessionId)
    try {
      const result = (await (
        await cloudFetch('/title', {
          ...cloudJson('POST', {
            model: reply.model,
            question: question.content || question.files.map((file) => file.name).join(', '),
            answer: getReplyText(reply),
          }),
          signal,
        })
      ).json()) as { title: string }
      if (
        epoch !== host.epoch() ||
        signal.aborted ||
        host.blocked(sessionId) ||
        host.getSession(sessionId)?.titleSource !== 'pending' ||
        host.getSession(sessionId)?.title !== session.title ||
        typeof result.title !== 'string' ||
        !result.title.trim()
      ) {
        return
      }
      host.updateSession(sessionId, (current) => ({
        ...current,
        title: result.title.trim().slice(0, 60),
        titleSource: 'generated',
      }))
      host.persist(sessionId)
    } catch {
      // Keep the provisional title. A later successful reply can retry without interrupting the answer.
    } finally {
      generatingTitles.delete(sessionId)
    }
  }
}
