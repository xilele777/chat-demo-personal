import { chromium, expect } from '@playwright/test'
const origin = process.env.UI_ORIGIN ?? 'http://127.0.0.1:18889'
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
  throw new Error('Use the isolated local mock server')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
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
try {
  await page.goto(origin)
  await page.getByLabel('访问密码', { exact: true }).fill('local-smoke-password-only')
  await page.getByRole('button', { name: '进入个人空间', exact: true }).click()
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
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
  await page.route('**/api/anthropic/v1/messages', async (route) => {
    requested.resolve()
    await gate.promise
    await route
      .fulfill({ status: 200, contentType: 'text/event-stream', body: sse })
      .catch(() => {})
  })
  await page.getByRole('button', { name: '继续生成', exact: true }).click()
  await requested.promise
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
  await requested.promise
  await page.waitForTimeout(400)
  await expect(total).toHaveText('270 tokens')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(total).toHaveText('270 tokens')
  gate.resolve()
  console.log(
    'PASS: continuation keeps prior totals while pending, adds new usage once, displays public summaries and retains totals after cancellation'
  )
} finally {
  gate.resolve()
  await context.request.delete(`${origin}/api/sessions/${id}`).catch(() => {})
  await browser.close()
}
