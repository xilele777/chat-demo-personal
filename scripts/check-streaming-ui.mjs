import { chromium, expect } from '@playwright/test'
const origin = process.env.UI_ORIGIN ?? 'http://127.0.0.1:18889'
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
  throw new Error('Use the isolated local mock server')
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
})
const context = await browser.newContext({
  viewport: { width: 1366, height: 844 },
  locale: 'zh-CN',
})
const page = await context.newPage()
const id = `continuation-ui-${Date.now()}`
let gate = Promise.withResolvers()
let requested = Promise.withResolvers()
const sse = [
  { type: 'message_start', message: { id: 'continued', model: 'test-model' } },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '公开推理摘要' },
  },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '续写回答' } },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'message_delta',
    delta: {},
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
  {
    type: 'message_delta',
    delta: { stop_reason: 'max_tokens' },
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
  { type: 'message_stop' },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join('')
const waitRequested = async () => {
  let timer
  try {
    await Promise.race([
      requested.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          void page
            .locator('body')
            .innerText()
            .then((body) =>
              reject(new Error(`Model request was not dispatched within 20 seconds: ${body}`))
            )
            .catch(reject)
        }, 20_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
try {
  await page.goto(origin)
  await page.getByLabel('访问密码', { exact: true }).fill('local-smoke-password-only')
  await page.getByRole('button', { name: '进入个人空间', exact: true }).click()
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  await page.route('**/api/anthropic/v1/messages', async (route) => {
    requested.resolve()
    await gate.promise
    await route
      .fulfill({ status: 200, contentType: 'text/event-stream', body: sse })
      .catch(() => {})
  })
  await page.getByPlaceholder('请输入消息').fill('首次回复等待用量')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await waitRequested()
  const usage = page.locator('[data-session-usage]')
  await expect(usage).toContainText('用量待返回')
  await expect(usage.locator('strong').first()).toHaveText('— tokens')
  const composerBottom = async () =>
    usage.evaluate((element) => {
      const row = element.parentElement
      const composer = row.previousElementSibling
      const rect = composer.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        gap: innerHeight - rect.bottom,
        height: row.getBoundingClientRect().height,
      }
    })
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(usage).toBeVisible()
    await expect.poll(async () => (await composerBottom()).gap).toBeGreaterThanOrEqual(48)
    expect((await composerBottom()).height).toBeGreaterThanOrEqual(48)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const screenshot = `tmp/token-footer-${id}-${width}.png`
    await page.screenshot({ path: screenshot })
    console.log(`Pending token layout: ${screenshot}`)
  }
  const pendingBottom = (await composerBottom()).bottom
  gate.resolve()
  await expect(usage.locator('strong').first()).toHaveText('120 tokens')
  await expect(usage).not.toContainText('用量待返回')
  expect(Math.abs((await composerBottom()).bottom - pendingBottom)).toBeLessThan(2)
  await page.setViewportSize({ width: 1366, height: 844 })
  gate = Promise.withResolvers()
  requested = Promise.withResolvers()
  console.log(
    'PASS: first request keeps the token footer visible before any provider event, with stable composer spacing on desktop and mobile'
  )
  const generation = (await (await context.request.get(`${origin}/api/sessions`)).json()).generation
  expect(
    (
      await context.request.put(`${origin}/api/sessions/${id}`, {
        data: {
          revision: null,
          generation,
          session: {
            id,
            title: '续写累计验收',
            titleSource: 'manual',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            rootMessageId: 'q',
            messages: [
              {
                id: 'q',
                role: 'user',
                content: '问题',
                files: [],
                parentId: null,
                selectedChildId: 'a',
              },
              {
                id: 'a',
                role: 'assistant',
                parentId: 'q',
                model: 'test-model',
                status: 'done',
                prefix: true,
                stopReason: 'max_tokens',
                blocks: [{ type: 'text', text: '已有回答' }],
                contextReports: [
                  {
                    model: 'test-model',
                    round: 1,
                    totalRounds: 1,
                    retainedRounds: 1,
                    omittedRounds: 0,
                    firstRetainedRound: 1,
                    estimatedInputTokens: 100,
                    inputBudget: 8192,
                    outputBudget: 2048,
                    contextWindow: null,
                    retainedQuestionIds: ['q'],
                  },
                ],
                usage: {
                  input_tokens: 100,
                  output_tokens: 50,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              },
            ],
          },
        },
      })
    ).ok()
  ).toBe(true)
  await page.evaluate((id) => localStorage.setItem('chat-demo:active-session:cloud', id), id)
  await page.reload()
  const total = page.locator('[data-session-usage] strong').first()
  await expect(total).toHaveText('150 tokens')
  await expect(page.locator('[data-context-details]')).toHaveCount(0)
  await page.getByRole('button', { name: '继续生成', exact: true }).click()
  await waitRequested()
  await page.waitForTimeout(2100)
  await expect(total).toHaveText('150 tokens')
  gate.resolve()
  await expect(total).toHaveText('270 tokens')
  await expect(page.locator('.ds-think-content').filter({ hasText: '公开推理摘要' })).toBeVisible()
  await expect(page.getByRole('button', { name: '继续生成', exact: true })).toBeVisible()
  const duration = page.getByRole('button', { name: /^处理用时 \d+ 秒$/ })
  await expect(duration).toBeVisible()
  const seconds = Number((await duration.textContent()).match(/\d+/)[0])
  expect(seconds).toBeGreaterThanOrEqual(2)
  const title = await duration.textContent()
  await page.reload()
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible()
  gate = Promise.withResolvers()
  requested = Promise.withResolvers()
  await page.getByRole('button', { name: '继续生成', exact: true }).click()
  await waitRequested()
  await page.waitForTimeout(400)
  await expect(total).toHaveText('270 tokens')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(total).toHaveText('270 tokens')
  gate.resolve()
  console.log(
    'PASS: continuation keeps prior totals while pending, adds new usage once, displays public summaries and retains totals after cancellation'
  )
  await page.unroute('**/api/anthropic/v1/messages')
  const interruptedEvents = [
    { type: 'message_start', message: { id: 'partial', model: 'returned-model-version' } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '断流前收到的文字' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: {
        input_tokens: 100,
        output_tokens: 30,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_reported: true,
        reasoning_tokens: 10,
      },
    },
    // EOF after a stop reason must not be mistaken for message_stop.
  ]
  await page.route('**/api/anthropic/v1/messages', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: interruptedEvents
        .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join(''),
    })
  )
  await page.getByPlaceholder('请输入消息').fill('断流状态验收')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('连接在回答确认完成前中断', { exact: false })).toBeVisible()
  await expect(page.getByText('断流前收到的文字', { exact: true })).toBeVisible()
  await expect
    .poll(async () => {
      const value = await (await context.request.get(`${origin}/api/sessions/${id}`)).json()
      return value.session.messages.at(-1).status
    })
    .toBe('error')
  const modelDetails = page.locator('[data-model-details]').last()
  await modelDetails.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(modelDetails).toContainText('接口返回模型：returned-model-version')
  await expect(modelDetails).toContainText('请求模型：test-model')
  await usage.locator('summary').click()
  await expect(usage).toContainText('20（部分请求已返回）')
  await expect(usage).toContainText('10（部分请求已返回）')
  await expect(usage).toContainText('不代表当前分支占用的上下文')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `tmp/stream-boundaries-${id}-mobile.png` })
  await page.reload()
  await expect(page.getByText('断流前收到的文字', { exact: true })).toBeVisible()
  await expect(page.getByText('连接在回答确认完成前中断', { exact: false })).toBeVisible()
  await page.locator('[data-model-details]').last().locator('summary').click()
  await expect(page.locator('[data-model-details]').last()).toContainText('returned-model-version')
  console.log(
    'PASS: interrupted answer persists as error, model aliases remain distinct, partial metrics are labelled and keyboard/mobile details survive reload'
  )
} finally {
  gate.resolve()
  await context.request.delete(`${origin}/api/sessions/${id}`).catch(() => {})
  await browser.close()
}
