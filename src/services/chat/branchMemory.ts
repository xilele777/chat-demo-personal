/** A bounded extractive summary. Quotes are evidence, never execution authority. */
export type BranchMemory = {
  version: 1
  sourceIds: string[]
  sourceDigest: string
  excerpts: { id: string; role: 'user' | 'assistant'; text: string; truncated: boolean }[]
  omittedSources: number
  estimatedTokens: number
  extraModelRequests: 0
}
export type MemorySource = { contextId?: string; role: string; content: unknown }
export const memoryDigest = async (sources: MemorySource[]) => {
  const bytes = new TextEncoder().encode(
    JSON.stringify(sources.map(({ contextId, role, content }) => [contextId, role, content]))
  )
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
export const validBranchMemory = (value: unknown): value is BranchMemory => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const memory = value as BranchMemory
  return (
    memory.version === 1 &&
    memory.extraModelRequests === 0 &&
    typeof memory.sourceDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(memory.sourceDigest) &&
    Array.isArray(memory.sourceIds) &&
    memory.sourceIds.length > 0 &&
    memory.sourceIds.length <= 2000 &&
    new Set(memory.sourceIds).size === memory.sourceIds.length &&
    memory.sourceIds.every((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id)) &&
    Number.isSafeInteger(memory.omittedSources) &&
    memory.omittedSources >= 0 &&
    memory.omittedSources <= memory.sourceIds.length &&
    Number.isSafeInteger(memory.estimatedTokens) &&
    memory.estimatedTokens >= 0 &&
    memory.estimatedTokens <= 2048 &&
    Array.isArray(memory.excerpts) &&
    memory.excerpts.length <= 16 &&
    memory.excerpts.every(
      (item) =>
        item &&
        memory.sourceIds.includes(item.id) &&
        ['user', 'assistant'].includes(item.role) &&
        typeof item.text === 'string' &&
        item.text.length <= 1600 &&
        typeof item.truncated === 'boolean'
    ) &&
    memory.excerpts.reduce((sum, item) => sum + item.text.length, 0) <= 4000
  )
}
