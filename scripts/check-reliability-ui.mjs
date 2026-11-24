// Real IndexedDB and UI checks against the temporary smoke server, never a deployed site.
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
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const prefix = `reliability-${Date.now()}`
const ids = ['recent-a', 'recent-b', 'remote', 'local', 'outbox'].map((name) => `${prefix}-${name}`)
const row = (id) => page.locator(`[data-session-item="${id}"]`)
const detail = async (id) =>
  await (await context.request.get(`${origin}/api/sessions/${id}`)).json()
const update = async (id, changes) => {
  const current = await detail(id)
  const response = await context.request.put(`${origin}/api/sessions/${id}`, {
    data: { ...current, session: { ...current.session, ...changes } },
  })
  expect(response.ok()).toBe(true)
}
const gate = () => Promise.withResolvers()
let release
try {
  await page.goto(origin)
  await page.getByLabel('访问密码', { exact: true }).fill('local-smoke-password-only')
  await page.getByRole('button', { name: '进入个人空间', exact: true }).click()
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  const generation = (await (await context.request.get(`${origin}/api/sessions`)).json()).generation
  for (const [index, id] of ids.entries()) {
    const response = await context.request.put(`${origin}/api/sessions/${id}`, {
      data: {
        revision: null,
        generation,
        session: {
          id,
          title: id,
          createdAt: 1,
          updatedAt: index < 2 ? Date.now() : 1,
          rootMessageId: 'q',
          messages: [
            {
              id: 'q',
              role: 'user',
              content: 'Question',
              files: [],
              createdAt: 1,
              parentId: null,
              selectedChildId: 'a',
            },
            {
              id: 'a',
              role: 'assistant',
              status: 'done',
              model: 'test-model',
              prefix: true,
              createdAt: 2,
              parentId: 'q',
              blocks: [{ type: 'text', text: 'Answer' }],
            },
          ],
        },
      },
    })
    expect(response.ok()).toBe(true)
  }
  await page.reload()
  await expect(row(ids[2])).toBeVisible()
  // The list is stale, but a detail GET must keep the newly saved remote metadata.
  await update(ids[2], { title: '另一台设备的新标题', pinned: true, updatedAt: 10 })
  await row(ids[2]).getByRole('button', { name: ids[2], exact: true }).click()
  await expect(row(ids[2])).toContainText('另一台设备的新标题')
  await expect(row(ids[2]).locator('[title="置顶"]')).toBeVisible()
  expect((await detail(ids[2])).session.title).toBe('另一台设备的新标题')
  expect((await detail(ids[2])).session.updatedAt).toBe(10)

  // Hold a fresh detail open while the owner pins and renames it locally.
  const loading = gate(),
    continueLoading = gate()
  release = continueLoading.resolve
  await page.route(`**/api/sessions/${ids[3]}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    loading.resolve()
    await continueLoading.promise
    await route.continue()
  })
  await row(ids[3]).getByRole('button', { name: ids[3], exact: true }).click()
  await loading.promise
  await update(ids[3], { title: '远端标题', pinned: false, updatedAt: 20 })
  await row(ids[3])
    .getByRole('button', { name: `更多 · ${ids[3]}`, exact: true })
    .click()
  await page.getByRole('button', { name: '置顶', exact: true }).click()
  await row(ids[3])
    .getByRole('button', { name: `更多 · ${ids[3]}`, exact: true })
    .click()
  await page.getByRole('button', { name: '重命名', exact: true }).click()
  await page.locator('input[class*="renameInput"]').fill('本机明确修改的标题')
  await page.locator('input[class*="renameInput"]').press('Enter')
  continueLoading.resolve()
  await expect.poll(async () => (await detail(ids[3])).session.title).toBe('本机明确修改的标题')
  expect((await detail(ids[3])).session.pinned).toBe(true)
  expect((await detail(ids[3])).session.updatedAt).toBe(20)
  await page.unroute(`**/api/sessions/${ids[3]}`)

  // Simulate a newer snapshot written by another tab during an in-flight network save.
  await row(ids[4]).getByRole('button', { name: ids[4], exact: true }).click()
  const saving = gate(),
    continueSaving = gate()
  release = continueSaving.resolve
  await page.route(`**/api/sessions/${ids[4]}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    saving.resolve()
    await continueSaving.promise
    await route.continue()
  })
  await row(ids[4])
    .getByRole('button', { name: `更多 · ${ids[4]}`, exact: true })
    .click()
  await page.getByRole('button', { name: '置顶', exact: true }).click()
  await saving.promise
  await page.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction('cloudOutbox', 'readwrite')
    const store = tx.objectStore('cloudOutbox')
    const request = store.get(id)
    request.onsuccess = () =>
      store.put({
        ...request.result,
        version: 'newer-other-tab',
        session: { ...request.result.session, title: '另一标签页尚未保存的修改' },
      })
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    window.outboxCleanups = 0
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args)
      if (args[0] === 'cloudOutbox' && args[1] === 'readwrite') {
        tx.addEventListener('complete', () => window.outboxCleanups++)
      }
      return tx
    }
  }, ids[4])
  continueSaving.resolve()
  await expect.poll(async () => (await detail(ids[4])).session.pinned).toBe(true)
  await expect.poll(() => page.evaluate(() => window.outboxCleanups)).toBeGreaterThan(0)
  // A read transaction created after the save cleanup sees its committed effect.
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const db = await new Promise((resolve) => {
          const request = indexedDB.open('chat-demo')
          request.onsuccess = () => resolve(request.result)
        })
        const value = await new Promise((resolve) => {
          const request = db.transaction('cloudOutbox').objectStore('cloudOutbox').get(id)
          request.onsuccess = () => resolve(request.result)
        })
        db.close()
        return value?.version
      }, ids[4])
    )
    .toBe('newer-other-tab')
  await page.unroute(`**/api/sessions/${ids[4]}`)
  await page.reload()
  await expect(row(ids[4])).toContainText('另一标签页尚未保存的修改')
  expect(errors).toEqual([])
  console.log(
    'PASS: fresh remote metadata, explicit edits during loading and newer IndexedDB outbox snapshots survive save completion and refresh'
  )
} finally {
  release?.()
  for (const id of ids) {
    try {
      const current = await detail(id)
      if (current.session)
        await context.request.delete(`${origin}/api/sessions/${id}`, {
          data: { revision: current.revision, generation: current.generation },
        })
    } catch {
      /* Temporary test records are removed with the isolated smoke database. */
    }
  }
  await browser.close()
}
