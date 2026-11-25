import { cloudFetch, cloudJson } from '../cloud.js'
import type { McpToolBlock } from '../mcpTypes.js'
import type { Session } from './types.js'

type Operation = {
  id: string
  requestId: string
  server: string
  name: string
  state: 'approval' | 'dispatched' | 'done' | 'unknown' | 'denied'
  resultSha256: string | null
}

/** Server evidence never resurrects an approval or replays an action. */
export const recoverToolOperations = async (session: Session): Promise<Session> => {
  const requestIds = session.messages.flatMap((message) =>
    message.role === 'assistant' && message.operationRequestId ? [message.operationRequestId] : []
  )
  if (!requestIds.length) {
    return session
  }
  const operations: Operation[] = []
  for (let index = 0; index < requestIds.length; index += 100) {
    const response = await cloudFetch(
      '/mcp/operations/query',
      cloudJson('POST', {
        requestIds: requestIds.slice(index, index + 100),
      })
    )
    operations.push(...((await response.json()) as { operations: Operation[] }).operations)
  }
  let changed = false
  const messages = session.messages.map((message) => {
    if (message.role !== 'assistant' || !message.operationRequestId) {
      return message
    }
    const tools = [...(message.mcpTools ?? [])]
    for (const operation of operations.filter(
      (entry) => entry.requestId === message.operationRequestId
    )) {
      const index = tools.findIndex((tool) => tool.id === operation.id)
      const existing = tools[index]
      if (existing && (existing.status === 'done' || existing.status === 'denied')) {
        continue
      }
      if (existing?.status === 'error' && operation.state !== 'done') {
        continue
      }
      const status: McpToolBlock['status'] =
        operation.state === 'done'
          ? 'done'
          : operation.state === 'denied' || operation.state === 'approval'
            ? 'denied'
            : 'unknown'
      const output =
        operation.state === 'done'
          ? `The server recorded completion. The full result was not saved here; verify with a read tool before relying on it. Result SHA-256: ${operation.resultSha256 ?? 'unavailable'}`
          : status === 'denied'
            ? 'No dispatch was recorded. Previous approvals cannot be reused.'
            : 'Dispatch was recorded but completion is unconfirmed. The outcome is unknown; do not replay automatically. Verify with a read tool.'
      const tool: McpToolBlock = {
        type: 'mcp_tool',
        id: operation.id,
        server: operation.server,
        name: operation.name,
        input: existing?.input ?? {},
        status,
        output,
      }
      if (
        existing &&
        existing.status === status &&
        existing.output === output &&
        !existing.approvalId
      ) {
        continue
      }
      if (index < 0) {
        tools.push(tool)
      } else {
        tools[index] = tool
      }
      changed = true
    }
    return { ...message, mcpTools: tools }
  })
  return changed ? { ...session, messages } : session
}
