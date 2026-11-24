import type {
  WebSearchResult,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
} from '../src/services/api/types.js'
import { HttpError, type Env } from './types.js'
import { sourceUrl } from './evidence.js'

export const searchAvailable = (env: Env) =>
  env.UPSTREAM_PROTOCOL === 'deepseek' || Boolean(env.TAVILY_API_KEY)

export const searchRequested = (tools: unknown) =>
  Array.isArray(tools) && tools.some((tool) => tool?.type === 'deepseek_web_search')

export const searchQuery = (messages: { role: string; content: unknown }[]) => {
  const content = [...messages].reverse().find((message) => message.role === 'user')?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => block?.type === 'text')
            .map((block) => block.text ?? '')
            .join('\n')
        : ''
  return text.trim().slice(0, 400)
}

export const searchCall = (query: string): ServerToolUseBlock => ({
  type: 'server_tool_use',
  id: `srvtoolu_s_${crypto.randomUUID().replaceAll('-', '')}`,
  name: 'deepseek_web_search',
  kind: 'search',
  caller: { type: 'direct' },
  input: { action: 'search', query, queries: [query] },
})

export const searchResult = (
  call: ServerToolUseBlock,
  content: WebSearchToolResultBlock['content']
): WebSearchToolResultBlock => ({
  type: 'web_search_tool_result',
  tool_use_id: call.id,
  kind: 'search',
  content,
})

export async function searchWeb(
  query: string,
  env: Env,
  signal: AbortSignal
): Promise<WebSearchResult[]> {
  if (!env.TAVILY_API_KEY) {
    throw new HttpError(422, 'Configure the TAVILY_API_KEY secret to enable web search')
  }
  const maxResults = Number(env.SEARCH_MAX_RESULTS ?? 10)
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
    throw new HttpError(503, 'Invalid SEARCH_MAX_RESULTS (use 1–20)')
  }
  const depth = env.SEARCH_DEPTH ?? 'advanced'
  if (!['basic', 'advanced'].includes(depth)) {
    throw new HttpError(503, 'Invalid SEARCH_DEPTH')
  }
  let endpoint = 'https://api.tavily.com/search'
  if (env.DEV_SEARCH_URL) {
    const url = new URL(env.DEV_SEARCH_URL)
    if (env.DEV_AUTH !== 'true' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new HttpError(503, 'DEV_SEARCH_URL is only allowed on local development servers')
    }
    endpoint = url.href
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.TAVILY_API_KEY}` },
    body: JSON.stringify({
      query,
      search_depth: depth,
      max_results: maxResults,
      include_answer: false,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(depth === 'basic' ? 12_000 : 25_000)]),
    redirect: 'manual',
  })
  if (!response.ok) {
    // Do not expose search-service payloads, which may echo request credentials.
    throw new HttpError(
      502,
      `Web search failed (HTTP ${response.status}). Check the search key and quota.`
    )
  }
  const data = (await response.json()) as {
    results?: { url?: unknown; title?: unknown; content?: unknown }[]
  }
  if (!Array.isArray(data.results)) {
    throw new HttpError(502, 'The search provider returned invalid results')
  }
  const seen = new Set<string>()
  return data.results
    .flatMap((item) => {
      if (
        typeof item?.url !== 'string' ||
        typeof item.title !== 'string' ||
        typeof item.content !== 'string'
      ) {
        return []
      }
      let url: URL
      try {
        url = new URL(item.url)
      } catch {
        return []
      }
      if (!['http:', 'https:'].includes(url.protocol)) {
        return []
      }
      const canonical = sourceUrl(url.href)
      if (seen.has(canonical)) {
        return []
      }
      seen.add(canonical)
      return [
        {
          type: 'web_search_result' as const,
          url: canonical,
          title: item.title.slice(0, 300),
          // Keep returned text for request-local lookup; WebTools supplies a small model/UI preview.
          snippet: item.content.slice(0, 48000),
          site_name: url.hostname.replace(/^www\./, ''),
          site_icon: null,
          page_age: null,
          encrypted_content: '',
        },
      ]
    })
    .slice(0, maxResults)
}

export const searchContext = (results: WebSearchResult[]) =>
  JSON.stringify(
    results.map((item, index) => ({
      citation: `[citation:${index + 1}]`,
      title: item.title,
      url: item.url,
      excerpt: item.snippet,
    }))
  )
