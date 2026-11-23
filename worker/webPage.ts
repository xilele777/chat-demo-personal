import { searchCall } from './search.js'
import { validateMcpUrl } from './mcpNet.js'
import { limitContext, type ContextMessage } from './context.js'
import { HttpError, type Env } from './types.js'
import type { WebFetchResult, WebFetchToolResultBlock } from '../src/services/api/types.js'

export const webPageTool = {
  type: 'function',
  function: {
    name: 'read_web_page',
    description:
      'Open a public web page and extract its article text when search snippets are insufficient, or when the user asks to read a URL. Use exact source citations from the result. Extraction can fail; do not claim a page was read on failure.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', maxLength: 2048 } },
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
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(422, 'Use a public HTTP or HTTPS page')
  }
  const checked = new URL(url)
  checked.protocol = 'https:'
  validateMcpUrl(checked.href, { ...env, DEV_AUTH: undefined })
  url.hash = ''
  return url.href
}

export async function readWebPage(
  value: unknown,
  env: Env,
  signal: AbortSignal
): Promise<WebFetchResult> {
  const url = publicPageUrl(value, env)
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
      extract_depth: 'basic',
      format: 'markdown',
      include_images: false,
      timeout: 15,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
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
      source: { type: 'text', media_type: 'text/plain', data: result.raw_content.slice(0, 12000) },
    },
    published_at: null,
  }
}

export async function* webPageEvents(
  value: unknown,
  env: Env,
  signal: AbortSignal,
  state: { index: number },
  sources: Map<string, number>
): AsyncGenerator<Record<string, unknown>, { text: string; isError: boolean }> {
  const url = typeof value === 'string' ? value.slice(0, 2048) : ''
  const call = {
    ...searchCall(''),
    kind: 'deep_search' as const,
    input: { action: 'open_page' as const, url },
  }
  yield { type: 'content_block_start', index: ++state.index, content_block: call }
  yield { type: 'content_block_stop', index: state.index }
  let content: WebFetchToolResultBlock['content']
  let result: { text: string; isError: boolean }
  try {
    content = await readWebPage(value, env, signal)
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
  yield {
    type: 'content_block_start',
    index: ++state.index,
    content_block: {
      type: 'web_fetch_tool_result',
      tool_use_id: call.id,
      kind: 'deep_search',
      content,
    },
  }
  yield { type: 'content_block_stop', index: state.index }
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
        }
        try {
          content = JSON.parse(message.content)
        } catch {
          continue
        }
        if (content?.type === 'web_page' && content.text) {
          content.text = content.text.slice(0, Math.floor(content.text.length / 2))
          shortened = true
        } else if (typeof content?.query === 'string' && Array.isArray(content.sources)) {
          for (const source of content.sources) {
            if (source.excerpt) {
              source.excerpt = source.excerpt.slice(0, Math.floor(source.excerpt.length / 2))
              shortened = true
            }
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
