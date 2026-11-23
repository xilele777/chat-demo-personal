/** Consume only reasoning text explicitly exposed by the provider; encrypted data stays private. */
const text = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(text).join('')
  }
  if (!value || typeof value !== 'object') {
    return ''
  }
  const block = value as Record<string, unknown>
  if (typeof block.type === 'string' && block.type.includes('encrypted')) {
    return ''
  }
  return text(block.text) || text(block.summary) || text(block.thinking) || text(block.content)
}
export const reasoningText = (delta: Record<string, unknown> | undefined): string => {
  if (!delta) {
    return ''
  }
  return (
    text(delta.reasoning_content) ||
    text(delta.reasoning) ||
    text(delta.thinking) ||
    text(delta.reasoning_details)
  )
}

type Part = readonly ['thinking' | 'text', string]
/** Handle exposed reasoning fields, typed content blocks, and leading <think> tags split across SSE chunks. */
export class OpenAIContent {
  private pending = ''
  private phase: 'start' | 'thinking' | 'text' = 'start'

  push(delta: Record<string, unknown> | undefined): Part[] {
    if (!delta) {
      return []
    }
    const parts: Part[] = []
    const reasoning = reasoningText(delta)
    if (reasoning) {
      parts.push(['thinking', reasoning])
    }
    const content = delta.content
    if (typeof content === 'string') {
      parts.push(...this.content(content))
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') {
          continue
        }
        if (['thinking', 'reasoning', 'reasoning.text', 'reasoning.summary'].includes(block.type)) {
          const value = text(block)
          if (value) {
            parts.push(['thinking', value])
          }
        } else if (['text', 'output_text'].includes(block.type) && typeof block.text === 'string') {
          parts.push(...this.content(block.text))
        }
      }
    }
    return parts
  }

  finish(): Part[] {
    const value = this.pending
    this.pending = ''
    return value ? [[this.phase === 'thinking' ? 'thinking' : 'text', value]] : []
  }

  private content(value: string): Part[] {
    this.pending += value
    if (this.phase === 'start') {
      const start = this.pending.trimStart()
      if (!start) {
        return []
      }
      if ('<think>'.startsWith(start.toLowerCase())) {
        return []
      }
      if (start.toLowerCase().startsWith('<think>')) {
        this.phase = 'thinking'
        this.pending = start.slice(7)
      } else {
        this.phase = 'text'
      }
    }
    if (this.phase === 'text') {
      return this.finish()
    }
    const end = this.pending.toLowerCase().indexOf('</think>')
    if (end >= 0) {
      const reasoning = this.pending.slice(0, end)
      this.pending = this.pending.slice(end + 8)
      this.phase = 'text'
      return [...(reasoning ? [['thinking', reasoning] as const] : []), ...this.finish()]
    }
    // Retain only a possible closing-tag prefix; stream the rest immediately.
    let keep = Math.min(7, this.pending.length)
    while (keep && !'</think>'.startsWith(this.pending.slice(-keep).toLowerCase())) {
      keep--
    }
    const chunk = this.pending.slice(0, this.pending.length - keep)
    this.pending = this.pending.slice(this.pending.length - keep)
    return chunk ? [['thinking', chunk]] : []
  }
}
