import { readMessageEvent } from '../api/parseEvent.js'
import { validContextReport } from './contextReport.js'
import { validBranchMemory } from './branchMemory.js'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const optionalString = (value: unknown) => value === undefined || typeof value === 'string'
const optionalBoolean = (value: unknown) => value === undefined || typeof value === 'boolean'
const optionalNumber = (value: unknown) =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)

/** Validate the fields consumed by rendering, search, context construction and backups.
 * Older records may omit timestamps/configuration, and linear histories remain supported. */
export const validSessionStructure = (session: Record<string, unknown>): boolean => {
  if (
    !Array.isArray(session.messages) ||
    (session.titleSource !== undefined &&
      (typeof session.titleSource !== 'string' ||
        !['pending', 'generated', 'manual'].includes(session.titleSource)))
  ) {
    return false
  }
  const messages = new Map<string, Record<string, unknown>>()
  for (const message of session.messages) {
    if (
      !record(message) ||
      typeof message.id !== 'string' ||
      !message.id ||
      messages.has(message.id) ||
      !optionalNumber(message.createdAt) ||
      !(message.parentId == null || typeof message.parentId === 'string') ||
      !optionalString(message.selectedChildId)
    ) {
      return false
    }
    if (message.role === 'user') {
      if (typeof message.content !== 'string' || !Array.isArray(message.files)) {
        return false
      }
      for (const file of message.files) {
        if (
          !record(file) ||
          typeof file.id !== 'string' ||
          !file.id ||
          typeof file.name !== 'string' ||
          !Number.isSafeInteger(file.size) ||
          Number(file.size) < 0 ||
          typeof file.isImage !== 'boolean' ||
          typeof file.mimeType !== 'string' ||
          !(file.serverId === null || typeof file.serverId === 'string') ||
          !optionalBoolean(file.imageSizeChecked)
        ) {
          return false
        }
      }
    } else if (message.role === 'assistant') {
      if (
        !Array.isArray(message.blocks) ||
        typeof message.status !== 'string' ||
        !['pending', 'streaming', 'done', 'stopped', 'error'].includes(String(message.status)) ||
        !(message.model == null || typeof message.model === 'string') ||
        !optionalString(message.providerModel) ||
        (typeof message.providerModel === 'string' &&
          (!message.providerModel.trim() || message.providerModel.length > 200)) ||
        !optionalBoolean(message.prefix) ||
        !optionalBoolean(message.thinking) ||
        !optionalBoolean(message.search) ||
        !optionalString(message.reasoningEffort) ||
        !optionalString(message.stopReason) ||
        (message.reasoningEffort !== undefined &&
          !['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(
            String(message.reasoningEffort)
          )) ||
        (message.stopReason !== undefined &&
          !['end_turn', 'max_tokens', 'tool_use', 'refusal'].includes(
            String(message.stopReason)
          )) ||
        !optionalString(message.latestReminder) ||
        !optionalNumber(message.processingSeconds) ||
        !optionalNumber(message.processingStartedAt)
      ) {
        return false
      }
      for (const block of message.blocks) {
        if (
          !record(block) ||
          block.type === 'tool_use' ||
          !readMessageEvent({ type: 'content_block_start', index: 0, content_block: block })
        ) {
          return false
        }
        if (!optionalBoolean(block.isTemplate) || !optionalString(block.signature)) {
          return false
        }
        if (block.type === 'web_search_tool_result') {
          const parsed = readMessageEvent({
            type: 'content_block_start',
            index: 0,
            content_block: block,
          })
          if (
            parsed?.type !== 'content_block_start' ||
            parsed.content_block.type !== 'web_search_tool_result' ||
            !Array.isArray(block.content) ||
            parsed.content_block.content.length !== block.content.length
          ) {
            return false
          }
        }
        if (
          block.type === 'text' &&
          block.citations !== undefined &&
          (!Array.isArray(block.citations) ||
            !block.citations.every(
              (citation) =>
                record(citation) &&
                citation.type === 'web_search_result_location' &&
                typeof citation.url === 'string' &&
                (citation.title == null || typeof citation.title === 'string')
            ))
        ) {
          return false
        }
        if (
          block.type === 'thinking' &&
          (!optionalNumber(block.startedAt) ||
            !optionalNumber(block.endedAt) ||
            !optionalNumber(block.elapsedSeconds))
        ) {
          return false
        }
      }
      if (
        message.mcpTools !== undefined &&
        (!Array.isArray(message.mcpTools) ||
          !message.mcpTools.every((block) => readMessageEvent({ type: 'mcp_tool_status', block })))
      ) {
        return false
      }
      if (
        (message.branchMemory !== undefined && !validBranchMemory(message.branchMemory)) ||
        !optionalString(message.operationRequestId) ||
        (typeof message.operationRequestId === 'string' &&
          !/^[a-zA-Z0-9_-]{1,160}$/.test(message.operationRequestId)) ||
        (message.contextReports !== undefined &&
          (!Array.isArray(message.contextReports) ||
            message.contextReports.length > 100 ||
            !message.contextReports.every(validContextReport)))
      ) {
        return false
      }
      if (
        message.usage !== undefined &&
        (!record(message.usage) ||
          ![
            'input_tokens',
            'output_tokens',
            'cache_read_input_tokens',
            'cache_creation_input_tokens',
            'reasoning_tokens',
          ].every((key) => optionalNumber((message.usage as Record<string, unknown>)[key])) ||
          !optionalBoolean((message.usage as Record<string, unknown>).cache_reported))
      ) {
        return false
      }
      if (
        message.error !== undefined &&
        (!record(message.error) ||
          typeof message.error.kind !== 'string' ||
          typeof message.error.message !== 'string' ||
          !optionalNumber(message.error.status) ||
          !optionalBoolean(message.error.retryable) ||
          (message.error.localMessage !== undefined &&
            (!record(message.error.localMessage) ||
              typeof message.error.localMessage.key !== 'string' ||
              (message.error.localMessage.params !== undefined &&
                (!record(message.error.localMessage.params) ||
                  !Object.values(message.error.localMessage.params).every(
                    (value) =>
                      typeof value === 'string' ||
                      (typeof value === 'number' && Number.isFinite(value))
                  ))))))
      ) {
        return false
      }
    } else {
      return false
    }
    // Parents precede children in the persisted creation order; this also rules out cycles.
    if (session.rootMessageId !== undefined) {
      const parent = message.parentId == null ? undefined : messages.get(String(message.parentId))
      if (
        message.parentId == null ? message.role !== 'user' : !parent || parent.role === message.role
      ) {
        return false
      }
    }
    messages.set(message.id, message)
  }
  if (session.rootMessageId !== undefined) {
    if (session.rootMessageId === null) {
      return messages.size === 0
    }
    if (typeof session.rootMessageId !== 'string') {
      return false
    }
    const root = messages.get(session.rootMessageId)
    if (!root || root.parentId != null || root.role !== 'user') {
      return false
    }
    for (const message of messages.values()) {
      if (message.selectedChildId !== undefined) {
        const child = messages.get(String(message.selectedChildId))
        if (!child || child.parentId !== message.id) {
          return false
        }
      }
    }
  }
  return true
}
