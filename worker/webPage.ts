import { searchCall } from './search.js'
import { validateMcpUrl } from './mcpNet.js'
import { limitContext, type ContextMessage } from './context.js'
import { HttpError, type Env } from './types.js'
import type { WebFetchResult, WebFetchToolResultBlock } from '../src/services/api/types.js'
import { sourceUrl } from './evidence.js'

export const webPageTool = {
  type: 'function',
  function: {
    name: 'read_web_page',
    description:
      'Read a public page only for a specific missing fact or disputed evidence. Supply focus terms to select relevant verbatim excerpts. Batch independent reads; never re-fetch the same page. Use read_tool_result to inspect omitted text.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', maxLength: 2048 },
        focus: { type: 'string', maxLength: 400 },
        mode: {
          type: 'string',
          enum: ['quick', 'research'],
          description:
            'Select on the first web call only. Use research only for a substantive investigation, comparison or report.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
}

export const publicPageUrl = (value: unknown, env: Env): string => {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new HttpError(422, 'Invalid web page URL')
  }
  const url = new URL(value)
  url.hash = ''
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(422, 'Use a public HTTP or HTTPS page')
  }
  const checked = new URL(url)
  checked.protocol = 'https:'
  validateMcpUrl(checked.href, { ...env, DEV_AUTH: undefined })
  return sourceUrl(url.href)
}

export async function readWebPage(
  value: unknown,
  env: Env,
  signal: AbortSignal,
  timeoutMs = 20000
): Promise<WebFetchResult> {
  const url = publicPageUrl(value, env)
  const maxCharacters = Number(env.PAGE_MAX_CHARACTERS ?? 48000)
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1000 || maxCharacters > 200000) {
    throw new HttpError(503, 'Invalid PAGE_MAX_CHARACTERS')
  }
  if (!env.TAVILY_API_KEY) {
    throw new HttpError(422, 'Configure TAVILY_API_KEY to read web pages')
  }
  let endpoint = 'https://api.tavily.com/extract'
  if (env.DEV_SEARCH_URL) {
    const local = new URL(env.DEV_SEARCH_URL)
    if (env.DEV_AUTH !== 'true' || !['127.0.0.1', 'localhost'].includes(local.hostname)) {
      throw new HttpError(503, 'Invalid local extraction endpoint')
    }
    local.pathname = local.pathname.replace(/search\/?$/, 'extract')
    endpoint = local.href
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.TAVILY_API_KEY}` },
    body: JSON.stringify({
      urls: [url],
      extract_depth: 'advanced',
      format: 'markdown',
      include_images: false,
      timeout: 15,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    redirect: 'manual',
  })
  if (!response.ok) {
    throw new HttpError(502, `Web page extraction failed (HTTP ${response.status})`)
  }
  const data = (await response.json()) as {
    results?: { url?: unknown; raw_content?: unknown }[]
    failed_results?: unknown[]
  }
  const result = data.results?.find(
    (item) => typeof item.raw_content === 'string' && item.raw_content.trim()
  )
  if (!result || typeof result.raw_content !== 'string') {
    throw new HttpError(502, 'The page could not be read. No article text was returned.')
  }
  const finalUrl = typeof result.url === 'string' ? publicPageUrl(result.url, env) : url
  const title =
    result.raw_content.match(/^#{1,2}\s+(.+)$/m)?.[1]?.slice(0, 300) ?? new URL(finalUrl).hostname
  return {
    type: 'web_fetch_result',
    url: finalUrl,
    content: {
      type: 'document',
      title,
      source: {
        type: 'text',
        media_type: 'text/plain',
        data:
          result.raw_content.length > maxCharacters
            ? result.raw_content.slice(0, maxCharacters) +
              '\n[Page truncated at the configured extraction limit.]'
            : result.raw_content,
      },
    },
    published_at: null,
  }
}

export async function* webPageEvents(
  value: unknown,
  env: Env,
  signal: AbortSignal,
  state: { index: number },
  sources: Map<string, number>,
  timeoutMs = 20000
): AsyncGenerator<Record<string, unknown>, { text: string; isError: boolean }> {
  const url = typeof value === 'string' ? value.slice(0, 2048) : ''
  const call = {
    ...searchCall(''),
    kind: 'deep_search' as const,
    input: { action: 'open_page' as const, url },
  }
  const callIndex = ++state.index
  yield { type: 'content_block_start', index: callIndex, content_block: call }
  yield { type: 'content_block_stop', index: callIndex }
  let content: WebFetchToolResultBlock['content']
  let result: { text: string; isError: boolean }
  try {
    content = await readWebPage(value, env, signal, timeoutMs)
    if (!sources.has(content.url)) {
      sources.set(content.url, sources.size + 1)
    }
    result = {
      text: JSON.stringify({
        type: 'web_page',
        url: content.url,
        title: content.content.title,
        citation: `[citation:${sources.get(content.url)}]`,
        text: content.content.source.data,
      }),
      isError: false,
    }
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    content = { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' }
    result = {
      text: JSON.stringify({
        url,
        error: 'This page could not be read. Use other sources or explain the limitation.',
      }),
      isError: true,
    }
  }
  const resultIndex = ++state.index
  yield {
    type: 'content_block_start',
    index: resultIndex,
    content_block: {
      type: 'web_fetch_tool_result',
      tool_use_id: call.id,
      kind: 'deep_search',
      content,
    },
  }
  yield { type: 'content_block_stop', index: resultIndex }
  return result
}

/** Preserve tool exchanges and source identities while shortening article text if the budget fills. */
export const limitWebContext = <T extends ContextMessage>(
  system: string,
  messages: T[],
  env: Env
): T[] => {
  const bounded = messages.map((message) => ({ ...message }))
  for (;;) {
    try {
      return limitContext(system, bounded, env)
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 422) {
        throw error
      }
      let shortened = false
      const holders: { content: unknown }[] = []
      for (const message of bounded) {
        if (message.role === 'tool') {
          holders.push(message)
        } else if (Array.isArray(message.content)) {
          message.content = message.content.map((block) => ({ ...block }))
          holders.push(
            ...(message.content as { type: string; content: unknown }[]).filter(
              (block) => block.type === 'tool_result'
            )
          )
        }
      }
      for (const message of holders) {
        if (typeof message.content !== 'string') {
          continue
        }
        let content: {
          type?: string
          text?: string
          query?: string
          sources?: { excerpt?: string }[]
          result_id?: string
          content?: { type?: string; text?: string }[]
          truncated?: boolean
          offset?: number
          next_offset?: number
        }
        try {
          content = JSON.parse(message.content)
        } catch {
          continue
        }
        if (
          content?.text &&
          (content.type === 'web_page' || content.type === 'tool_result_excerpt')
        ) {
          content.text = content.text.slice(0, Math.floor(content.text.length / 2))
          content.truncated = true
          if (content.type === 'tool_result_excerpt') {
            content.next_offset = (content.offset ?? 0) + content.text.length
          }
          shortened = true
        } else if (typeof content?.query === 'string' && Array.isArray(content.sources)) {
          for (const source of content.sources) {
            if (source.excerpt) {
              source.excerpt = source.excerpt.slice(0, Math.floor(source.excerpt.length / 2))
              shortened = true
              content.truncated = true
            }
          }
        } else if (content?.result_id && Array.isArray(content.content)) {
          // Cached MCP text can be reduced without cutting JSON syntax or losing the full result.
          for (const block of content.content) {
            if (typeof block.text === 'string' && block.text.length) {
              block.text = block.text.slice(0, Math.floor(block.text.length / 2))
              content.truncated = true
              shortened = true
            }
          }
          // Structured content can dominate even when text blocks are small; read it from the cache.
          if ('structuredContent' in content) {
            delete content.structuredContent
            content.truncated = true
            shortened = true
          }
        }
        message.content = JSON.stringify(content)
      }
      if (!shortened) {
        throw error
      }
    }
  }
}
