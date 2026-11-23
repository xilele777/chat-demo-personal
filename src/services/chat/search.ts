export type SearchableSession = {
  id: string
  title: string
  updatedAt: number
  messages: {
    id: string
    role: string
    content?: unknown
    blocks?: { type: string; text?: string }[]
  }[]
}

export type HistorySearchResult = {
  sessionId: string
  title: string
  messageId: string | null
  role: 'user' | 'assistant' | 'title'
  excerpt: string
  updatedAt: number
}

export const searchSession = (
  session: SearchableSession,
  query: string,
  limit = 50
): HistorySearchResult[] => {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return []
  }
  const results: HistorySearchResult[] = []
  for (const message of session.messages) {
    const text =
      message.role === 'user'
        ? typeof message.content === 'string'
          ? message.content
          : ''
        : (Array.isArray(message.blocks) ? message.blocks : [])
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
    const at = text.toLowerCase().indexOf(needle)
    if (at < 0) {
      continue
    }
    const start = Math.max(0, at - 45)
    const end = Math.min(text.length, at + needle.length + 110)
    results.push({
      sessionId: session.id,
      title: session.title,
      messageId: message.id,
      role: message.role === 'user' ? 'user' : 'assistant',
      updatedAt: session.updatedAt,
      excerpt: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    })
    if (results.length >= limit) {
      break
    }
  }
  if (!results.length && session.title.toLowerCase().includes(needle)) {
    results.push({
      sessionId: session.id,
      title: session.title,
      messageId: null,
      role: 'title',
      excerpt: session.title,
      updatedAt: session.updatedAt,
    })
  }
  return results
}
