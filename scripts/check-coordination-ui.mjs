import { chromium, expect } from '@playwright/test'
import { rspack } from '@rspack/core'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { exportSnapshot } from '../src/services/chat/history/snapshot.ts'

const origin = process.env.UI_ORIGIN
if (!origin || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname))
  throw new Error('Use the isolated cloud runner')
const output = await mkdtemp(path.join(tmpdir(), 'chat-coordination-test-'))
await new Promise((resolve, reject) => {
  const compiler = rspack({
    mode: 'production',
    target: 'web',
    entry: path.resolve('src/services/chat/coordination.ts'),
    output: {
      path: output,
      filename: 'coordination.js',
      library: { type: 'window', name: 'coordinationTest' },
    },
    resolve: { extensionAlias: { '.js': ['.ts', '.js'] } },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: 'builtin:swc-loader',
            options: { jsc: { parser: { syntax: 'typescript' } } },
          },
        },
      ],
    },
  })
  compiler.run((error, stats) =>
    compiler.close((closeError) =>
      error || closeError || stats.hasErrors()
        ? reject(error ?? closeError ?? new Error(stats.toString()))
        : resolve()
    )
  )
})
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
})
const context = await browser.newContext({ locale: 'zh-CN' })
const errors = []
context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)))
const id = `coordination-${Date.now()}`
const session = {
  id,
  title: id,
  createdAt: 1,
  updatedAt: 2,
  rootMessageId: 'q',
  messages: [
    { id: 'q', role: 'user', content: 'old', files: [], parentId: null, selectedChildId: 'a' },
    {
      id: 'a',
      role: 'assistant',
      status: 'done',
      blocks: [{ type: 'text', text: 'old answer' }],
      parentId: 'q',
    },
  ],
}
try {
  const a = await context.newPage()
  await a.goto(origin)
  await a.getByLabel('访问密码', { exact: true }).fill('local-smoke-password-only')
  await a.getByRole('button', { name: '进入个人空间', exact: true }).click()
  await expect(a.getByPlaceholder('请输入消息')).toBeVisible()
  const index = await (await context.request.get(`${origin}/api/sessions`)).json()
  expect(
    (
      await context.request.put(`${origin}/api/sessions/${id}`, {
        data: { session, revision: null, generation: index.generation },
      })
    ).ok()
  ).toBe(true)
  expect(
    (
      await context.request.put(`${origin}/api/mcp/servers/coordination-tools`, {
        data: {
          name: 'Coordination',
          url: `http://127.0.0.1:${process.env.UI_MODEL_PORT}/mcp`,
          token: 'smoke-mcp',
          enabled: true,
          disabledTools: [],
        },
      })
    ).ok()
  ).toBe(true)
  const b = await context.newPage()
  for (const page of [a, b]) {
    await page.goto(origin)
    await page
      .locator(`[data-session-item="${id}"]`)
      .getByRole('button', { name: id, exact: true })
      .click()
    await expect(page.getByText('old answer', { exact: true })).toBeVisible()
  }
  await a.getByPlaceholder('请输入消息').fill('mcp-write-hang')
  await a.getByRole('button', { name: '发送', exact: true }).click()
  await expect(a.getByRole('button', { name: '允许这次调用', exact: true })).toBeVisible()
  let bModelRequests = 0
  b.on('request', (r) => {
    if (r.url().endsWith('/api/anthropic/v1/messages')) bModelRequests++
  })
  await b.getByPlaceholder('请输入消息').fill('second page')
  await b.getByRole('button', { name: '发送', exact: true }).click()
  await expect(b.getByText(/Another page is generating or importing history/)).toBeVisible()
  expect(bModelRequests).toBe(0)
  // Actual import UI must fail before clearing the shared staging stores.
  const backup = await exportSnapshot([session], async () => undefined)
  await b.getByRole('button', { name: '设置', exact: true }).click()
  await b.getByRole('button', { name: '数据管理', exact: true }).click()
  const settings = b.getByRole('dialog', { name: '设置', exact: true })
  await settings.locator('input[accept*=".zip"]').setInputFiles({
    name: 'coordination.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await backup.arrayBuffer()),
  })
  await b
    .getByRole('dialog', { name: '确认导入历史对话？', exact: true })
    .getByRole('button', { name: '确认导入', exact: true })
    .click()
  await expect(settings).toContainText('文件导入失败')
  const before = await (await context.request.get(`${origin}/api/sessions`)).json()
  expect(before.generation).toBe(index.generation)
  // Closing a real lock holder releases its locks immediately. Approval is never replayed.
  await a.close()
  await b.addScriptTag({ content: await readFile(path.join(output, 'coordination.js'), 'utf8') })
  const takeover = await b.evaluate(async () => {
    const release = await window.coordinationTest.acquireChatWork()
    release()
    return true
  })
  expect(takeover).toBe(true)
  // Native locks unavailable: actual IndexedDB fallback serializes pages and releases by token.
  const c = await context.newPage()
  await c.goto(origin)
  for (const page of [b, c]) {
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true })
    )
    await page.addScriptTag({
      content: await readFile(path.join(output, 'coordination.js'), 'utf8'),
    })
  }
  await b.evaluate(async () => {
    window.releaseCoordination = await window.coordinationTest.acquireChatWork('fallback')
  })
  expect(
    await c.evaluate(async () => {
      try {
        await window.coordinationTest.acquireChatWork('fallback')
        return false
      } catch {
        return true
      }
    })
  ).toBe(true)
  // An expired lease does not authorize stealing from a suspended page.
  await b.evaluate(async () => {
    const request = indexedDB.open('personal-chat-coordination')
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction('leases', 'readwrite')
    const get = tx.objectStore('leases').get('work')
    get.onsuccess = () => tx.objectStore('leases').put({ ...get.result, expires: 1 }, 'work')
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
  expect(
    await c.evaluate(async () => {
      try {
        await window.coordinationTest.acquireChatWork('fallback')
        return false
      } catch (error) {
        return error.message.includes('previous page')
      }
    })
  ).toBe(true)
  await b.evaluate(() => window.releaseCoordination())
  await expect
    .poll(() =>
      c.evaluate(async () => {
        try {
          const release = await window.coordinationTest.acquireChatWork('fallback')
          release()
          return true
        } catch {
          return false
        }
      })
    )
    .toBe(true)
  expect(errors).toEqual([])
  console.log(
    'PASS: same-conversation generation blocked before model request, approval/import exclusion, real page-close takeover and IndexedDB fallback fencing'
  )
} finally {
  await context.request.delete(`${origin}/api/mcp/servers/coordination-tools`)
  await browser.close()
  await rm(output, { recursive: true, force: true })
}
