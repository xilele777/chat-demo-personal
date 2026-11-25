import { chromium, expect } from '@playwright/test'
const origin = process.env.UI_ORIGIN
if (!origin || !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) {
  throw new Error('Use the isolated cloud UI server')
}
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
})
const context = await browser.newContext({
  viewport: { width: 1366, height: 844 },
  locale: 'zh-CN',
})
const page = await context.newPage()
const id = `generation-recovery-${Date.now()}`
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const outboxes = (page) =>
  page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const values = await new Promise((resolve, reject) => {
      const request = db.transaction('cloudOutbox').objectStore('cloudOutbox').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return values
  })
const failWrites = async (route) =>
  route.request().method() === 'PUT'
    ? route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":{"message":"Injected save failure"}}',
      })
    : route.continue()
try {
  await page.goto(origin)
  await page.getByLabel('访问密码', { exact: true }).fill('local-smoke-password-only')
  await page.getByRole('button', { name: '进入个人空间', exact: true }).click()
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  const index = await (await context.request.get(`${origin}/api/sessions`)).json()
  expect(
    (
      await context.request.put(`${origin}/api/mcp/servers/generation-journal`, {
        data: {
          name: 'Recovery Notes',
          url: `http://127.0.0.1:${process.env.UI_MODEL_PORT}/mcp`,
          enabled: true,
          token: 'smoke-mcp',
          disabledTools: [],
        },
      })
    ).ok()
  ).toBe(true)
  expect(
    (
      await context.request.put(`${origin}/api/sessions/${id}`, {
        data: {
          revision: null,
          generation: index.generation,
          session: {
            id,
            title: id,
            createdAt: 1,
            updatedAt: 2,
            rootMessageId: 'old-q',
            messages: [
              {
                id: 'old-q',
                parentId: null,
                selectedChildId: 'old-a',
                role: 'user',
                content: 'Old constraint '.repeat(8000),
                files: [],
                createdAt: 1,
              },
              {
                id: 'old-a',
                parentId: 'old-q',
                role: 'assistant',
                status: 'done',
                model: 'second-model',
                prefix: true,
                createdAt: 2,
                blocks: [{ type: 'text', text: 'Old answer' }],
              },
            ],
          },
        },
      })
    ).ok()
  ).toBe(true)
  await page.reload()
  await page
    .locator(`[data-session-item="${id}"]`)
    .getByRole('button', { name: id, exact: true })
    .click()
  await expect(page.getByText('Old answer', { exact: true })).toBeVisible()
  // Keep all post-tool snapshots durable locally without updating the original server conversation.
  await context.route('**/api/sessions/*', failWrites)
  await page.getByRole('button', { name: '模型', exact: true }).click()
  await page.getByRole('option', { name: 'second-model', exact: true }).click()
  await page.getByPlaceholder('请输入消息').fill('mcp-write-hang')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('button', { name: '允许这次调用', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '允许这次调用', exact: true }).click()
  await expect(page.getByText('调用完成', { exact: true })).toBeVisible()
  await expect(page.locator('[data-context-details]').last()).toContainText('省略 1 轮')
  const memoryDetails = page.locator('[data-branch-memory]').last()
  await expect(memoryDetails).toBeVisible()
  await memoryDetails.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(memoryDetails).toContainText('覆盖 2 条消息')
  await expect(memoryDetails).toContainText('额外模型请求：0')
  await expect(memoryDetails).toContainText('Old constraint')
  await expect
    .poll(async () => {
      const saved = (await outboxes(page)).find((entry) => entry.session.id === id)
      return saved?.session.messages.at(-1)?.mcpTools?.at(-1)?.status
    })
    .toBe('done')
  const saved = (await outboxes(page)).find((entry) => entry.session.id === id).session
  expect(saved.messages.at(-1).branchMemory.sourceIds).toEqual(['old-q', 'old-a'])
  expect(saved.messages.at(-1).branchMemory.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
  const requestId = saved.messages.at(-1).operationRequestId
  const operations = await (
    await context.request.post(`${origin}/api/mcp/operations/query`, {
      data: { requestIds: [requestId] },
    })
  ).json()
  expect(operations.operations.at(-1).state).toBe('done')
  expect(operations.operations.at(-1).resultSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(operations)).not.toContain('MCP write_note result')
  await page.setViewportSize({ width: 390, height: 844 })
  const details = page.locator('[data-context-details]').last()
  await details.locator('summary').click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.close()

  const recovering = await context.newPage()
  recovering.on('pageerror', (error) => errors.push(error.message))
  await recovering.goto(origin)
  await recovering.getByRole('button', { name: id, exact: true }).click()
  await expect(recovering.getByText('调用完成', { exact: true })).toBeVisible()
  await expect(recovering.locator('[data-context-details]').last()).toContainText('省略 1 轮')
  await recovering.locator('[data-branch-memory]').last().locator('summary').click()
  await expect(recovering.locator('[data-branch-memory]').last()).toContainText('覆盖 2 条消息')
  // An independent storage context isolates journal recovery from closing-page outbox versions.
  const remote = await (await context.request.get(`${origin}/api/sessions`)).json()
  const journalId = `${id}-journal`
  const journalSession = structuredClone(saved)
  journalSession.id = journalId
  journalSession.title = journalId
  delete journalSession.cloud
  journalSession.messages.at(-1).mcpTools = []
  journalSession.messages.at(-1).status = 'stopped'
  expect(
    (
      await context.request.put(`${origin}/api/sessions/${journalId}`, {
        data: {
          session: journalSession,
          revision: null,
          generation: remote.generation,
        },
      })
    ).ok()
  ).toBe(true)
  const journalContext = await browser.newContext({
    storageState: await context.storageState(),
    locale: 'zh-CN',
  })
  const checking = await journalContext.newPage()
  checking.on('pageerror', (error) => errors.push(error.message))
  await checking.goto(origin)
  await checking.getByRole('button', { name: journalId, exact: true }).click()
  await expect(checking.getByText('调用完成', { exact: true })).toBeVisible()
  await checking.getByText('参数与结果', { exact: true }).click()
  await expect(checking.getByText(/The server recorded completion/)).toBeVisible()
  await expect.poll(async () => (await outboxes(checking)).length).toBe(0)
  // If the recovery key cannot be committed, no model or tool request may start.
  let modelRequests = 0
  await checking.route('**/api/anthropic/v1/messages', async (route) => {
    modelRequests++
    await route.continue()
  })
  await checking.getByRole('button', { name: '开启新对话', exact: true }).click()
  await checking.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (
        this.name === 'cloudOutbox' &&
        value.session.messages.some((message) => message.operationRequestId)
      ) {
        throw new DOMException('Injected recovery checkpoint failure', 'DataCloneError')
      }
      return put.call(this, value, ...args)
    }
  })
  await checking.getByPlaceholder('请输入消息').fill('mcp-write')
  await checking.getByRole('button', { name: '发送', exact: true }).click()
  await expect(checking.getByText(/本地恢复记录未能保存/)).toBeVisible()
  expect(modelRequests).toBe(0)
  await expect(checking.getByRole('button', { name: '发送', exact: true })).toBeVisible()
  expect(errors).toEqual([])
  console.log(
    'PASS: cropped branch context on desktop/mobile, tool checkpoint before a hung model, page-close/D1 recovery without replay, and failed IndexedDB checkpoint prevents generation'
  )
} finally {
  await context.unroute('**/api/sessions/*', failWrites)
  await context.request.delete(`${origin}/api/mcp/servers/generation-journal`)
  await browser.close()
}
