// Independent live pages, failed network saves and durable recovery using actual D1/IndexedDB.
import { chromium, expect } from '@playwright/test'
const origin = process.env.UI_ORIGIN ?? 'http://127.0.0.1:8788'
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
  throw new Error('Use the isolated local mock server')
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
})
const context = await browser.newContext({
  viewport: { width: 1366, height: 900 },
  locale: 'zh-CN',
})
const errors = []
context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)))
const id = `two-pages-${Date.now()}`
const aTitle = `${id} A 未同步`,
  bTitle = `${id} B 未同步`
const failWrites = async (route) => {
  if (route.request().method() === 'PUT')
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":{"message":"Test network save failure"}}',
    })
  else await route.continue()
}
const snapshots = async (page) =>
  page.evaluate(async (id) => {
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
      .filter((item) => item.session.id === id)
      .map((item) => ({
        id: item.id,
        writer: item.writer,
        version: item.version,
        title: item.session.title,
      }))
  }, id)
try {
  const a = await context.newPage()
  await a.goto(origin)
  await a.getByLabel('访问密码', { exact: true }).fill('local-smoke-password-only')
  await a.getByRole('button', { name: '进入个人空间', exact: true }).click()
  await expect(a.getByPlaceholder('请输入消息')).toBeVisible()
  const index = await (await context.request.get(`${origin}/api/sessions`)).json()
  const session = {
    id,
    title: id,
    createdAt: 1,
    updatedAt: Date.now(),
    rootMessageId: 'q',
    messages: [
      {
        id: 'q',
        parentId: null,
        selectedChildId: 'answer',
        role: 'user',
        content: 'Original question',
        files: [],
        createdAt: 1,
      },
      {
        id: 'answer',
        parentId: 'q',
        role: 'assistant',
        status: 'done',
        model: 'test-model',
        prefix: true,
        createdAt: 2,
        blocks: [{ type: 'text', text: 'Original answer' }],
      },
    ],
  }
  expect(
    (
      await context.request.put(`${origin}/api/sessions/${id}`, {
        data: { session, revision: null, generation: index.generation },
      })
    ).ok()
  ).toBe(true)
  await a.reload()
  const b = await context.newPage()
  await b.goto(origin)
  // Context interception survives closing a page, including pagehide-triggered saves.
  await context.route(`**/api/sessions/${id}`, failWrites)
  for (const page of [a, b]) {
    await page
      .locator(`[data-session-item="${id}"]`)
      .getByRole('button', { name: id, exact: true })
      .click()
    await expect(page.getByText('Original answer', { exact: true })).toBeVisible()
    await page.route('**/api/sessions/*', failWrites)
  }
  const rename = async (page, title) => {
    await page
      .locator(`[data-session-item="${id}"]`)
      .getByRole('button', { name: `更多 · ${id}`, exact: true })
      .click()
    await page.getByRole('button', { name: '重命名', exact: true }).click()
    await page.locator('input[class*="renameInput"]').fill(title)
    await page.locator('input[class*="renameInput"]').press('Enter')
  }
  await Promise.all([rename(a, aTitle), rename(b, bTitle)])
  await expect
    .poll(async () => (await snapshots(b)).map((item) => item.title).sort())
    .toEqual([aTitle, bTitle].sort())
  const durable = await snapshots(b)
  expect(new Set(durable.map((item) => item.writer)).size).toBe(2)
  expect(new Set(durable.map((item) => item.id)).size).toBe(2)
  expect(
    (await (await context.request.get(`${origin}/api/sessions/${id}`)).json()).session.title
  ).toBe(id)
  await expect(a.getByText('1 个对话尚未保存', { exact: true })).toBeVisible()
  await expect(b.getByText('1 个对话尚未保存', { exact: true })).toBeVisible()
  await context.setOffline(true)
  await a.close()
  await expect
    .poll(async () => (await snapshots(b)).map((item) => item.title).sort())
    .toEqual([aTitle, bTitle].sort())
  await context.setOffline(false)
  const afterClose = await (await context.request.get(`${origin}/api/sessions/${id}`)).json()
  const recovering = await context.newPage()
  await recovering.route('**/api/sessions/*', failWrites)
  await recovering.goto(origin)
  for (const title of [aTitle, bTitle])
    await expect(
      recovering.getByRole('button', { name: `${title} (本机副本)`, exact: true })
    ).toBeVisible()
  await recovering.getByRole('button', { name: `${aTitle} (本机副本)`, exact: true }).click()
  await expect(recovering.getByText('Original answer', { exact: true })).toBeVisible()
  await expect(recovering.getByText(/个对话尚未保存/)).toBeVisible()
  await recovering.unroute('**/api/sessions/*', failWrites)
  await recovering.getByRole('button', { name: '重试', exact: true }).first().click()
  await expect
    .poll(async () => {
      const remote = await (await context.request.get(`${origin}/api/sessions`)).json()
      return remote.sessions.filter(
        (s) => s.title === `${aTitle} (本机副本)` || s.title === `${bTitle} (本机副本)`
      ).length
    })
    .toBe(2)
  const remote = await (await context.request.get(`${origin}/api/sessions`)).json()
  const copies = remote.sessions.filter(
    (s) => s.title === `${aTitle} (本机副本)` || s.title === `${bTitle} (本机副本)`
  )
  expect(copies.every((s) => s.id !== id)).toBe(true)
  await expect.poll(async () => (await snapshots(recovering)).length).toBe(0)
  const finalOriginal = await (await context.request.get(`${origin}/api/sessions/${id}`)).json()
  // Closing can dispatch a last save whose response the page never sees. Recovery
  // must preserve that remote state as well, rather than assuming closure failed.
  expect(finalOriginal).toEqual(afterClose)
  await recovering.reload()
  for (const title of [aTitle, bTitle])
    await expect(
      recovering.getByRole('button', { name: `${title} (本机副本)`, exact: true })
    ).toBeVisible()
  expect(errors).toEqual([])
  console.log(
    'PASS: independent page snapshots survive save failures and closing one page, both recover as durable copies without overwriting the original'
  )
} finally {
  await browser.close()
}
