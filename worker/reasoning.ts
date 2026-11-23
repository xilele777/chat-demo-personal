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
  return text(block.text) || text(block.summary) || text(block.content)
}
export const reasoningText = (delta: Record<string, unknown> | undefined): string => {
  if (!delta) {
    return ''
  }
  return text(delta.reasoning_content) || text(delta.reasoning) || text(delta.reasoning_details)
}
