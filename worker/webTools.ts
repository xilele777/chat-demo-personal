import { searchCall, searchResult, searchWeb } from './search.js'
import { webPageEvents, webPageTool } from './webPage.js'
import { researchInstructions, researchPolicy } from './policy.js'
import { contextCost } from './context.js'
import { evidenceExcerpt, normalizedQuery, sourceUrl } from './evidence.js'
import type { Env } from './types.js'

export const webSearchTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search external facts with a targeted query. Default quick mode suits dates, names and a few facts: batch independent queries and make at most one verification pass. Choose research on the FIRST web call only for a substantive investigation, comparison or report. Stop once supported; never repeat a query.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 800 },
        mode: { type: 'string', enum: ['quick', 'research'] },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
}

export class WebTools {
  readonly instructions: string
  private searches = 0
  private pages = 0
  private policy
  private rounds = 0
  private startedAt = 0
  private evidenceTokens = 0
  private novelty = 0
  private batchNovelty = 0
  private stagnantRounds = 0
  private readonly queries = new Set<string>()
  private readonly urls = new Set<string>()
  private readonly evidence = new Set<string>()
  constructor(
    private readonly env: Env,
    readonly enabled: boolean,
    private readonly state: { index: number },
    private readonly sources: Map<string, number>
  ) {
    this.policy = researchPolicy(env)
    this.instructions = enabled ? '\n' + researchInstructions : ''
  }
  definitions(protocol: 'openai' | 'anthropic'): Record<string, unknown>[] {
    // Keep schemas stable throughout the request; execution enforces the limits.
    const tools = this.enabled ? [webSearchTool, webPageTool] : []
    return protocol === 'openai'
      ? tools
      : tools.map(({ function: tool }) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        }))
  }
  handles(name: string): boolean {
    return this.enabled && ['web_search', 'read_web_page'].includes(name)
  }
  get started() {
    return this.rounds > 0
  }
  get stopReason(): string | undefined {
    if (!this.started) {
      return undefined
    }
    if (Date.now() - this.startedAt >= this.policy.durationMs) {
      return 'Research time budget reached'
    }
    if (this.rounds >= this.policy.maxRounds) {
      return 'Research turn limit reached'
    }
    if (this.evidenceTokens >= this.policy.evidenceTokens - 256) {
      return 'Research evidence budget reached'
    }
    if (this.stagnantRounds >= 2) {
      return 'Two consecutive research turns produced no new evidence'
    }
    if (this.searches >= this.policy.maxSearches && this.pages >= this.policy.maxPages) {
      return 'Search and page-reading limits reached'
    }
    return undefined
  }
  get exhausted() {
    return Boolean(this.stopReason)
  }
  get canExecute() {
    return (
      this.rounds <= this.policy.maxRounds &&
      Date.now() - this.startedAt < this.policy.durationMs &&
      this.stagnantRounds < 2 &&
      this.evidenceTokens < this.policy.evidenceTokens - 256
    )
  }
  beginBatch(calls: { name: string; input: Record<string, unknown> }[]) {
    if (!this.started && calls.some((call) => call.input.mode === 'research')) {
      this.policy = researchPolicy(this.env, 'research')
    }
    if (!this.started) {
      this.startedAt = Date.now()
    }
    this.batchNovelty = this.novelty
    this.rounds++
  }
  endBatch() {
    this.stagnantRounds = this.novelty === this.batchNovelty ? this.stagnantRounds + 1 : 0
  }
  private get remaining() {
    return {
      mode: this.policy.mode,
      turns: Math.max(0, this.policy.maxRounds - this.rounds),
      searches: Math.max(0, this.policy.maxSearches - this.searches),
      pages: Math.max(0, this.policy.maxPages - this.pages),
      evidence_tokens: Math.max(0, this.policy.evidenceTokens - this.evidenceTokens),
      ...(this.stopReason ? { stop_reason: this.stopReason } : {}),
    }
  }
  /** Only compact, verbatim evidence enters model history; full results stay in ToolResults. */
  preview(text: string, focus = ''): string {
    const value = JSON.parse(text)
    const limit = Math.max(
      0,
      Math.min(this.policy.resultTokens, this.policy.evidenceTokens - this.evidenceTokens) - 100
    )
    if (Array.isArray(value.sources)) {
      for (const item of value.sources) {
        if (item.previously_seen) {
          delete item.excerpt
        } else if (typeof item.excerpt === 'string') {
          const full = item.excerpt
          item.excerpt = evidenceExcerpt(
            full,
            focus || value.query || '',
            this.policy.mode === 'quick' ? 700 : 1400
          )
          if (item.excerpt !== full) {
            item.truncated = true
          }
        }
      }
    }
    if (typeof value.text === 'string') {
      const full = value.text
      // Cache reads have exact offsets, so shorten a contiguous slice instead of reordering it.
      value.text =
        value.type === 'tool_result_excerpt'
          ? full.slice(0, this.policy.mode === 'quick' ? 2400 : 4500)
          : evidenceExcerpt(full, focus, this.policy.mode === 'quick' ? 2400 : 4500)
      if (value.text !== full) {
        value.truncated = true
      }
    }
    value.research_budget = this.remaining
    let encoded = JSON.stringify(value)
    while (contextCost(encoded) > limit) {
      let shortened = false
      const excerpt = [...(value.sources ?? [])]
        .reverse()
        .find((item) => typeof item.excerpt === 'string')
      if (excerpt) {
        delete excerpt.excerpt
        excerpt.truncated = true
        shortened = true
      }
      if (typeof value.text === 'string' && value.text.length > 80) {
        value.text = value.text.slice(0, Math.floor(value.text.length / 2))
        value.truncated = true
        shortened = true
      }
      if (!shortened) {
        if (value.sources?.length) {
          value.sources.pop()
        } else {
          return JSON.stringify({
            message:
              'Research evidence budget reached. Answer from the evidence already available.',
            research_budget: this.remaining,
          })
        }
      }
      encoded = JSON.stringify(value)
    }
    if (value.type === 'tool_result_excerpt' && value.truncated && typeof value.text === 'string') {
      value.next_offset = (value.offset ?? 0) + value.text.length
    }
    this.evidenceTokens += contextCost(JSON.stringify(value)) + 100
    value.research_budget = this.remaining
    return JSON.stringify(value)
  }
  noteCachedRead(text: string) {
    const value = JSON.parse(text)
    if (!value.error && value.text) {
      this.novelty++
    }
  }
  async *run(
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal
  ): AsyncGenerator<Record<string, unknown>, { text: string; isError: boolean }> {
    if (!this.canExecute) {
      return {
        text: JSON.stringify({
          error: 'Research budget exhausted. Answer using verified evidence and disclose gaps.',
        }),
        isError: true,
      }
    }
    if (name === 'read_web_page') {
      if (this.pages >= this.policy.maxPages) {
        return {
          text: JSON.stringify({
            error:
              'Page-reading budget exhausted. Answer using verified evidence and disclose gaps.',
          }),
          isError: true,
        }
      }
      let url = String(input.url ?? '')
      try {
        url = sourceUrl(url)
      } catch {
        /* Page events report invalid URLs as failures. */
      }
      if (this.urls.has(url)) {
        return {
          text: JSON.stringify({
            url,
            previously_requested: true,
            message: 'This page was already requested. Use its cached result; do not fetch again.',
          }),
          isError: false,
        }
      }
      this.urls.add(url)
      this.pages++
      const result = yield* webPageEvents(
        input.url,
        this.env,
        signal,
        this.state,
        this.sources,
        this.policy.mode === 'quick' ? 12000 : 20000
      )
      if (!result.isError) {
        this.novelty++
      }
      return result
    }
    if (this.searches >= this.policy.maxSearches) {
      return {
        text: JSON.stringify({
          error: 'Search budget exhausted. Answer using verified evidence and disclose gaps.',
        }),
        isError: true,
      }
    }
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 800) : ''
    if (!query) {
      return {
        text: JSON.stringify({ error: 'Supply a non-empty, targeted query.' }),
        isError: true,
      }
    }
    const key = normalizedQuery(query)
    if (this.queries.has(key)) {
      return {
        text: JSON.stringify({
          query,
          previously_requested: true,
          message: 'This query was already requested. Use its earlier results.',
        }),
        isError: false,
      }
    }
    this.queries.add(key)
    this.searches++
    const call = { ...searchCall(query), kind: 'deep_search' as const }
    const callIndex = ++this.state.index
    yield { type: 'content_block_start', index: callIndex, content_block: call }
    yield { type: 'content_block_stop', index: callIndex }
    let results: Awaited<ReturnType<typeof searchWeb>> = []
    let error: string | undefined
    try {
      results = await searchWeb(
        query,
        {
          ...this.env,
          SEARCH_DEPTH: this.env.SEARCH_DEPTH ?? this.policy.depth,
          SEARCH_MAX_RESULTS: this.env.SEARCH_MAX_RESULTS ?? String(this.policy.maxResults),
        },
        signal
      )
    } catch (failure) {
      signal.throwIfAborted()
      error = failure instanceof Error ? failure.message : 'Web search unavailable'
    }
    const sources = results.map((item) => {
      if (!this.sources.has(item.url)) {
        this.sources.set(item.url, this.sources.size + 1)
      }
      const identity = item.url + '\n' + normalizedQuery(item.snippet)
      const seen = this.evidence.has(identity)
      this.evidence.add(identity)
      if (!seen) {
        this.novelty++
      }
      return {
        citation: `[citation:${this.sources.get(item.url)}]`,
        url: item.url,
        title: item.title,
        excerpt: item.snippet,
        ...(seen ? { previously_seen: true } : {}),
      }
    })
    const index = ++this.state.index
    yield {
      type: 'content_block_start',
      index,
      content_block: {
        ...searchResult(
          call,
          error
            ? [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }]
            : results.map((item) => ({
                ...item,
                snippet: evidenceExcerpt(
                  item.snippet,
                  query,
                  this.policy.mode === 'quick' ? 1000 : 1500
                ),
              }))
        ),
        kind: 'deep_search',
      },
    }
    yield { type: 'content_block_stop', index }
    return {
      text: JSON.stringify({
        query,
        sources,
        ...(error ? { error } : {}),
        ...(!error && !sources.length
          ? {
              message:
                'No usable sources. Make one targeted verification attempt if it may resolve the question; otherwise disclose the gap.',
            }
          : {}),
      }),
      isError: Boolean(error),
    }
  }
}
