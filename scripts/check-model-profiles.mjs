import assert from 'node:assert/strict'
import { selectModel, modelCatalog } from '../worker/modelConfig.ts'
import { capabilitiesForModel } from '../src/services/modelCapabilities.ts'
import { reasoningEfforts, publicConfig } from '../worker/config.ts'
import { tokenBudgets } from '../worker/policy.ts'
import { upstream } from '../worker/upstream.ts'

const profiles = {
  small: {
    contextTokens: 8192,
    maxOutputTokens: 1024,
    images: false,
    tools: false,
    apiStyle: 'chat_completions',
  },
  large: {
    contextTokens: 131072,
    maxInputTokens: 100000,
    maxOutputTokens: 8192,
    images: true,
    tools: true,
    reasoningEfforts: ['high'],
    apiStyle: 'responses',
  },
}
const env = {
  UPSTREAM_PROTOCOL: 'openai',
  UPSTREAM_MODEL: 'large',
  OPENAI_API_STYLE: 'responses',
  MODEL_PROFILES: JSON.stringify(profiles),
  UPSTREAM_BASE_URL: 'https://mock.example/v1',
  UPSTREAM_API_KEY: 'test-key',
  DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
}
assert.deepEqual(tokenBudgets(selectModel(env, 'small')), { input: 6144, output: 1024 })
assert.deepEqual(tokenBudgets(selectModel(env, 'large')), { input: 100000, output: 8192 })
assert.deepEqual(tokenBudgets(selectModel(env, 'unknown')), { input: 8192, output: 2048 })
assert.equal(selectModel(env, 'unknown').modelCapabilities.contextTokens, null)
assert.equal(selectModel(env, 'unknown').modelCapabilities.tools, false)
assert.deepEqual(reasoningEfforts(selectModel(env, 'gpt-9-anything')), [])
assert.deepEqual(reasoningEfforts(selectModel(env, 'large')), ['high'])
const catalog = publicConfig(env).modelCatalog
for (const model of ['small', 'large', 'unknown'])
  assert.deepEqual(capabilitiesForModel(catalog, model), selectModel(env, model).modelCapabilities)
for (const mutate of [
  (p) => {
    p.small.contextTokens = 1024
  },
  (p) => {
    p.small.maxOutputTokens = 8192
  },
  (p) => {
    p.small.images = 'false'
  },
  (p) => {
    p.small.reasoningEfforts = ['invented']
  },
  (p) => {
    p.small.maxInputTokens = 1.5
  },
  (p) => {
    p.small.extra = true
  },
]) {
  const bad = structuredClone(profiles)
  mutate(bad)
  assert.throws(
    () => modelCatalog({ ...env, MODEL_PROFILES: JSON.stringify(bad) }),
    (e) => e.status === 503
  )
}
assert.throws(
  () => selectModel(env, 'invalid model'),
  (e) => e.status === 400
)
assert.equal(
  capabilitiesForModel(
    modelCatalog({
      ...env,
      MODEL_PROFILES: JSON.stringify({
        ...profiles,
        '*': { contextTokens: 32768, maxOutputTokens: 4096, tools: true, images: false },
      }),
    }),
    'another'
  ).tools,
  true
)

const originalFetch = globalThis.fetch
const sent = []
let gets = 0,
  heads = 0
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  sent.push({ url: String(url), body })
  if (!body.stream)
    return Response.json(
      body.input
        ? { output: [{ content: [{ type: 'output_text', text: 'A title' }] }] }
        : { choices: [{ message: { content: 'A title' } }] }
    )
  const events = body.input
    ? [
        { type: 'response.output_text.delta', delta: 'answer' },
        { type: 'response.completed', response: { status: 'completed', output: [] } },
      ]
    : [{ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }]
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}
const call = async (body, extra = {}, path = '/api/anthropic/v1/messages') => {
  const result = await upstream(
    new Request(`https://local.example${path}`, { method: 'POST', body: JSON.stringify(body) }),
    { ...env, ...extra },
    path
  )
  return result.text()
}
try {
  await call({ model: 'small', messages: [{ role: 'user', content: 'question' }] })
  assert.match(sent.at(-1).url, /chat\/completions$/)
  assert.equal(sent.at(-1).body.max_completion_tokens, 1024)
  assert.equal(sent.at(-1).body.tools, undefined)
  assert.equal(sent.at(-1).body.reasoning_effort, undefined)
  await call({
    model: 'large',
    reasoning_effort: 'high',
    messages: [{ role: 'user', content: 'question' }],
  })
  assert.match(sent.at(-1).url, /responses$/)
  assert.equal(sent.at(-1).body.max_output_tokens, 8192)
  assert.equal(sent.at(-1).body.reasoning.effort, 'high')
  await call({ model: 'unknown', messages: [{ role: 'user', content: 'question' }] })
  assert.equal(sent.at(-1).body.reasoning, undefined)
  assert.equal(sent.at(-1).body.include, undefined)
  assert.equal(sent.at(-1).body.max_output_tokens, 2048)
  await call({ model: 'small', question: 'question', answer: 'answer' }, {}, '/api/title')
  assert.equal(sent.at(-1).body.model, 'small')
  assert.match(sent.at(-1).url, /chat\/completions$/)
  await assert.rejects(
    call({
      model: 'small',
      tools: [{ type: 'deepseek_web_search' }],
      messages: [{ role: 'user', content: 'search' }],
    }),
    (e) => e.status === 422
  )
  const files = {
    async head() {
      heads++
      return { size: 8 * 1024 * 1024, httpMetadata: { contentType: 'image/png' } }
    },
    async get() {
      gets++
      throw new Error('attachment bytes must not be read')
    },
  }
  const image = { type: 'image', source: { file_id: 'local_image' } }
  const failed = await call(
    { model: 'small', messages: [{ role: 'user', content: [image] }] },
    { FILES: files }
  )
  assert.match(failed, /Images are not enabled/)
  assert.equal(gets, 0)
  await assert.rejects(call({ model: 'small', messages: [{ role: 'user', content: [image] }] }, { UPSTREAM_PROTOCOL: 'deepseek' }), (e) => e.status === 422)
  const disguised = await call(
    {
      model: 'small',
      messages: [
        { role: 'user', content: [{ type: 'document', source: { file_id: 'local_image' } }] },
      ],
    },
    {
      FILES: {
        ...files,
        async head() {
          return { size: 1, httpMetadata: { contentType: 'image/png' } }
        },
      },
    }
  )
  assert.match(disguised, /Images are not enabled/)
  assert.equal(gets, 0)
  await call(
    {
      model: 'small',
      messages: [
        { role: 'user', content: [image] },
        { role: 'assistant', content: 'x'.repeat(9000) },
        { role: 'user', content: 'latest' },
      ],
    },
    { FILES: files }
  )
  assert.equal(gets, 0)
  assert.ok(heads >= 1)
  assert.equal(JSON.stringify(sent.at(-1).body).includes('estimatedContentTokens'), false)
} finally {
  globalThis.fetch = originalFetch
}
console.log(
  'PASS: per-model budgets, API style and capabilities, unknown fallback, strict profiles, selected-model titles and attachment preflight before reads'
)
