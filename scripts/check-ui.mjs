// Run against scripts/smoke-cloud.mjs --serve, which uses temporary D1/R2 and mock APIs.
import { chromium, expect } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const origin = process.env.UI_ORIGIN ?? 'http://127.0.0.1:8788'
const mockOrigin = `http://127.0.0.1:${process.env.UI_MODEL_PORT ?? 9899}`
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) {
  throw new Error('UI checks must run against the temporary local mock server')
}
const output = await mkdtemp(path.join(tmpdir(), 'personal-chat-ui-'))
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
})
const context = await browser.newContext({
  viewport: { width: 1366, height: 900 },
  locale: 'zh-CN',
})
const errors = []
const failedRequests = []
context.on('response', async (response) => {
  if (response.status() >= 400 && response.url().includes('/api/sessions/')) {
    failedRequests.push({
      method: response.request().method(),
      status: response.status(),
      body: await response.text().catch(() => ''),
    })
  }
})
context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)))
let page = await context.newPage()
try {
  await page.goto(origin)
  await page.getByLabel('访问密码', { exact: true }).fill('local-smoke-password-only')
  await page.getByRole('button', { name: '进入个人空间', exact: true }).click()
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  expect((await (await context.request.get(`${origin}/api/config`)).json()).model).toBe(
    'test-model'
  )
  const oldConnections = (await (await context.request.get(`${origin}/api/mcp/servers`)).json())
    .servers
  for (const connection of oldConnections.filter((connection) =>
    connection.name.startsWith('UI 测试')
  )) {
    await context.request.delete(`${origin}/api/mcp/servers/${connection.id}`)
  }
  await page.getByPlaceholder('请输入消息').fill('中文未发送草稿')
  await page.reload()
  await expect(page.getByPlaceholder('请输入消息')).toHaveValue('中文未发送草稿')
  await page.close()
  page = await context.newPage()
  await page.goto(origin)
  await expect(page.getByPlaceholder('请输入消息')).toHaveValue('中文未发送草稿')
  console.log('PASS: text draft survives reload and closing/reopening the page')

  const composerModel = () =>
    page.locator('main button[aria-haspopup="listbox"][aria-label="模型"]:visible')
  // Token events can precede the final save and async title. Verify durable recovery after both settle.
  const waitForSaved = () =>
    expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const open = indexedDB.open('chat-demo')
              open.onerror = () => reject(open.error)
              open.onsuccess = () => {
                const db = open.result
                const tx = db.transaction(['cloudOutbox', 'cloudSessionCache'])
                const pending = tx.objectStore('cloudOutbox').count()
                const cached = tx
                  .objectStore('cloudSessionCache')
                  .get(localStorage.getItem('chat-demo:active-session:cloud'))
                tx.oncomplete = () => {
                  resolve(
                    pending.result === 0 && cached.result?.session.titleSource === 'generated'
                  )
                  db.close()
                }
                tx.onerror = () => {
                  reject(tx.error)
                  db.close()
                }
              }
            })
        )
      )
      .toBe(true)
  await composerModel().click()
  await page.getByRole('option', { name: 'second-model', exact: true }).click()
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('[data-session-usage]').filter({ hasText: '140 tokens' })).toBeVisible()
  await expect(page.getByText('已保存到云端', { exact: true })).toHaveCount(0)
  await expect(page.getByPlaceholder('请输入消息')).toHaveValue('')
  await waitForSaved()
  await page.reload()
  await expect(page.locator('[data-session-usage]').filter({ hasText: '140 tokens' })).toBeVisible()
  await expect(page.getByPlaceholder('请输入消息')).toHaveValue('')
  await expect(composerModel()).toHaveText('second-model')
  const checkComposer = async () => {
    const model = await composerModel().boundingBox()
    const search = await page.getByRole('button', { name: '联网搜索', exact: true }).boundingBox()
    expect(model.x).toBeGreaterThanOrEqual(search.x + search.width)
    expect(Math.abs(model.y - search.y)).toBeLessThan(2)
    const overlaps = await composerModel().evaluate((model) => {
      const row = model.parentElement.parentElement
      const boxes = [...row.querySelectorAll('button')].map((el) => el.getBoundingClientRect())
      const bound = row.getBoundingClientRect()
      return boxes.some(
        (box, index) => box.right > bound.right || (index > 0 && box.left < boxes[index - 1].right)
      )
    })
    expect(overlaps).toBe(false)
  }
  await checkComposer()
  const totals = page.locator('[data-session-usage]')
  const metric = (root, label) =>
    root
      .locator('dl > div')
      .filter({ has: page.locator('dt').filter({ hasText: new RegExp(`^${label}$`) }) })
      .locator('dd')
  await totals.locator('summary').click()
  await expect(metric(totals, '输入')).toHaveText('100')
  await expect(metric(totals, '其中缓存命中')).toHaveText('30')
  await expect(metric(totals, '输出')).toHaveText('40')
  await expect(metric(totals, '其中思考')).toHaveText('20')
  await expect(metric(totals, '缓存命中率')).toHaveText('30%')
  await expect(metric(totals, '正文与其他输出')).toHaveText('20')
  const totalBox = await totals.boundingBox()
  const composerBox = await totals.locator('..').boundingBox()
  expect(
    Math.abs(totalBox.x + totalBox.width / 2 - composerBox.x - composerBox.width / 2)
  ).toBeLessThan(2)
  expect(totalBox.y).toBeGreaterThan((await composerModel().boundingBox()).y)
  const statsBoxes = await totals
    .locator('dl > div')
    .evaluateAll((items) => items.map((el) => el.getBoundingClientRect().y))
  expect(new Set(statsBoxes).size).toBe(4)
  await page.screenshot({ path: path.join(output, 'conversation-tokens.png') })
  await page.keyboard.press('Escape')
  await expect(totals).not.toHaveAttribute('open')
  await expect(page.locator('.ds-think-content')).toContainText('先检查内容')
  console.log('PASS: model selection persists, token totals display, and sent drafts stay cleared')

  let failSaves = true
  await page.route('**/api/sessions/*', async (route) => {
    if (failSaves && route.request().method() === 'PUT')
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '模拟保存失败' } }),
      })
    else await route.continue()
  })
  await page.getByPlaceholder('请输入消息').fill('测试保存重试')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('1 个对话尚未保存', { exact: true })).toBeVisible()
  await expect(page.locator('[data-session-usage]').filter({ hasText: '280 tokens' })).toHaveCount(
    1
  )
  await expect(page.locator('[data-message-id] [data-session-usage]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重试', exact: true }).first()).toBeEnabled()
  failSaves = false
  await page.getByRole('button', { name: '重试', exact: true }).first().click()
  await expect(page.getByText('1 个对话尚未保存', { exact: true })).toHaveCount(0)
  await expect(page.getByText('已保存到云端', { exact: true })).toHaveCount(0)
  console.log('PASS: failed saves are visible and retry returns to the saved state')

  await page.getByRole('button', { name: '搜索历史' }).click()
  await page.getByLabel('搜索标题和消息内容').fill('TOKEN')
  await expect(page.getByRole('button', { name: /Hidden TOKEN/ }).first()).toBeVisible()
  await page.screenshot({ path: path.join(output, 'search-desktop.png') })
  await page.getByLabel('搜索标题和消息内容').press('ArrowDown')
  await expect(page.getByRole('button', { name: /Hidden TOKEN/ }).first()).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(page.getByLabel('搜索标题和消息内容')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-message-id="reply"]')).toBeFocused()
  await expect(page.locator('[data-message-id="reply"]')).toContainText('Hidden TOKEN')
  expect(
    await page
      .locator('[data-message-id="reply"]')
      .evaluate((el) => getComputedStyle(el).outlineStyle)
  ).toBe('none')
  console.log('PASS: history results navigate to and focus the matching message')

  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page
    .getByRole('navigation', { name: '设置' })
    .getByRole('button', { name: '模型', exact: true })
    .click()
  const modelDialog = page.getByRole('dialog', { name: '设置' })
  const modelDetails = modelDialog.locator('[data-model-details]')
  await expect(modelDetails).not.toHaveAttribute('open')
  await expect(modelDetails.locator('p').first()).not.toBeVisible()
  await modelDetails.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(modelDetails.locator('p').first()).toBeVisible()
  await expect(modelDialog).toContainText('输入预算 29,696 Token · 单次输出上限 2,048 Token')
  await expect(modelDialog).toContainText('配置的上下文窗口：32,768 Token')
  await page.getByRole('textbox', { name: '添加模型 ID', exact: true }).fill('manual-model')
  await page.getByRole('button', { name: '添加并使用', exact: true }).click()
  await expect(modelDetails).not.toHaveAttribute('open')
  await expect(modelDialog).toContainText('输入预算 8,192 Token · 单次输出上限 2,048 Token')
  await expect(modelDialog).toContainText('此模型尚未配置能力，暂用较小预算的文本模式。')
  await expect(
    page
      .getByRole('dialog', { name: '设置' })
      .locator('button[aria-haspopup="listbox"][aria-label="模型"]:visible')
  ).toHaveText('manual-model')
  const settingsModel = page
    .getByRole('dialog', { name: '设置' })
    .locator('button[aria-haspopup="listbox"][aria-label="模型"]:visible')
  await settingsModel.click()
  const modelMenu = page.getByRole('listbox', { name: '模型', exact: true })
  await expect(modelMenu).toBeVisible()
  const triggerBox = await settingsModel.boundingBox()
  const menuBox = await modelMenu.boundingBox()
  expect(Math.abs(menuBox.x + menuBox.width - triggerBox.x - triggerBox.width)).toBeLessThan(2)
  expect(Math.abs(menuBox.y - triggerBox.y - triggerBox.height)).toBeLessThan(8)
  await page.keyboard.press('Escape')
  await expect(modelMenu).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()
  await expect(settingsModel).toBeFocused()
  const longModel = `vendor/${'long-model-name-'.repeat(10)}2026`
  await page.getByRole('textbox', { name: '添加模型 ID', exact: true }).fill(longModel)
  await page.getByRole('button', { name: '添加并使用', exact: true }).click()
  await expect(settingsModel).toHaveText(longModel)
  await settingsModel.click()
  await expect(page.getByRole('option', { name: longModel, exact: true })).toBeVisible()
  expect(await modelMenu.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: path.join(output, 'models-desktop.png') })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '通用设置', exact: true }).click()
  await page.getByRole('button', { name: '语言', exact: true }).click()
  await page.getByRole('option', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: 'Language', exact: true }).click()
  await page.getByRole('option', { name: 'Simplified Chinese', exact: true }).click()
  await page.getByRole('button', { name: 'MCP', exact: true }).click()
  await page.getByRole('button', { name: '添加 MCP 连接', exact: true }).click()
  await page.getByLabel('连接名称', { exact: true }).fill('UI 测试 MCP')
  await page.getByLabel('远程服务地址', { exact: true }).fill(`${mockOrigin}/mcp`)
  await page.getByLabel('Bearer Token（可选）', { exact: true }).fill('smoke-mcp')
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await expect(
    page.getByText('连接成功，发现 2 个工具。保存后生效。', { exact: true })
  ).toBeVisible()
  await page.screenshot({ path: path.join(output, 'mcp-desktop.png') })
  await page.getByRole('button', { name: '保存连接', exact: true }).click()
  await expect(page.getByText('2 个工具已启用', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '添加 MCP 连接', exact: true }).click()
  await page.getByLabel('连接名称', { exact: true }).fill('UI 测试 OAuth')
  await page.getByLabel('远程服务地址', { exact: true }).fill(`${mockOrigin}/oauth/mcp`)
  await page.getByRole('radio', { name: 'OAuth 浏览器登录', exact: true }).check()
  await page.getByRole('button', { name: '登录授权', exact: true }).click()
  await expect(page.getByText('OAuth 授权成功，连接已保存。', { exact: true })).toBeVisible()
  await expect(page.getByText('已通过 OAuth 登录', { exact: true })).toBeVisible()
  await expect(page).not.toHaveURL(/mcp_oauth|code=|state=/)
  await page.screenshot({ path: path.join(output, 'mcp-oauth-desktop.png') })
  await page
    .getByRole('region', { name: 'UI 测试 OAuth', exact: true })
    .getByRole('button', { name: '移除', exact: true })
    .click()
  await expect(page.getByRole('region', { name: 'UI 测试 OAuth', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(composerModel()).toHaveText(longModel)
  const checkHeader = async () => {
    await page.locator('[data-chat-header]').evaluate(async (header) => {
      await Promise.all(
        header
          .getAnimations({ subtree: true })
          .filter((animation) => animation instanceof CSSTransition)
          .map((animation) => animation.finished.catch(() => {}))
      )
    })
    const layout = await page.locator('[data-chat-header]').evaluate((header) => {
      const boxes = [...header.children]
        .filter((el) => el.getAttribute('aria-hidden') !== 'true')
        .map((el) => el.getBoundingClientRect())
      const bound = header.getBoundingClientRect()
      return {
        fits: boxes.every(
          (box) => box.width > 0 && box.left >= bound.left && box.right <= bound.right
        ),
        overlaps: boxes.some((box, index) => index > 0 && box.left < boxes[index - 1].right),
        overflow: document.documentElement.scrollWidth > innerWidth,
      }
    })
    expect(layout).toEqual({ fits: true, overlaps: false, overflow: false })
  }
  for (const width of [768, 820, 1024, 1366]) {
    await page.setViewportSize({ width, height: 900 })
    await checkHeader()
    await checkComposer()
    await page.getByRole('button', { name: '收起边栏', exact: true }).click()
    await checkHeader()
    await checkComposer()
    await composerModel().click()
    const menu = await page.getByRole('listbox', { name: '模型', exact: true }).boundingBox()
    expect(menu.x).toBeGreaterThanOrEqual(0)
    expect(menu.x + menu.width).toBeLessThanOrEqual(width)
    await page.keyboard.press('Escape')
    if (width === 768 || width === 1366)
      await page.screenshot({ path: path.join(output, `collapsed-header-${width}.png`) })
    await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  }
  console.log('PASS: headers and composer controls fit at 768–1366px with long model names')
  await composerModel().click()
  await page.getByRole('option', { name: 'second-model', exact: true }).click()
  await page.getByRole('button', { name: '开启新对话', exact: true }).click()
  await page.getByPlaceholder('请输入消息').fill('mcp-write')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('button', { name: '允许这次调用', exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(output, 'mcp-approval.png') })
  await page.getByRole('button', { name: '允许这次调用', exact: true }).click()
  await expect(page.getByText('调用完成', { exact: true })).toBeVisible()
  await expect(page.locator('[data-session-usage]').filter({ hasText: '360 tokens' })).toBeVisible()
  const sessionTotal = page.locator('[data-session-usage]')
  await sessionTotal.locator('summary').click()
  await expect(metric(sessionTotal, '输入')).toHaveText('300')
  await expect(metric(sessionTotal, '其中缓存命中')).toHaveText('30')
  await expect(metric(sessionTotal, '输出')).toHaveText('60')
  await expect(metric(sessionTotal, '其中思考')).toHaveText('20')
  await page.setViewportSize({ width: 390, height: 844 })
  await waitForSaved()
  await page.reload()
  await expect(sessionTotal).toContainText('360 tokens')
  await checkComposer()
  await sessionTotal.locator('summary').click()
  const panelBounds = await sessionTotal.locator('section').boundingBox()
  expect(panelBounds.x).toBeGreaterThanOrEqual(0)
  expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: path.join(output, 'conversation-tokens-mobile.png') })
  await page.setViewportSize({ width: 1366, height: 900 })
  console.log(
    'PASS: model settings, native dialog selects, MCP test/save and write approval work in the UI'
  )

  await page.getByRole('button', { name: '开启新对话', exact: true }).click()
  await page.getByRole('button', { name: '联网搜索', exact: true }).click()
  let failSearch = true
  await page.route('**/api/history/search?*', async (route) => {
    if (failSearch)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'temporary' } }),
      })
    else await route.continue()
  })
  await page.keyboard.press('Control+k')
  await page.getByLabel('搜索标题和消息内容').fill('TOKEN')
  await expect(page.getByRole('dialog', { name: '搜索历史' }).getByRole('status')).toContainText(
    '搜索失败，请重试'
  )
  failSearch = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('button', { name: /Hidden TOKEN/ }).first()).toBeVisible()
  const searchBox = await page.locator('dialog[open] > div').boundingBox()
  expect(searchBox.width).toBe(660)
  expect(searchBox.y).toBe(102)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.unroute('**/api/history/search?*')
  console.log(
    'PASS: search request failures retry without losing the query; desktop search matches the reference dimensions'
  )

  // Fresh old sessions avoid both the in-memory cache and recent-session prefetch.
  const searchTemplate = (
    await (await context.request.get(`${origin}/api/sessions/search-check`)).json()
  ).session
  const generation = (await (await context.request.get(`${origin}/api/sessions`)).json()).generation
  const jumpIds = [`ui-retry-${Date.now()}`, `ui-cancel-${Date.now()}`]
  for (const id of jumpIds) {
    const response = await context.request.put(`${origin}/api/sessions/${id}`, {
      data: {
        session: { ...searchTemplate, id, title: id, updatedAt: 1 },
        revision: null,
        generation,
      },
    })
    expect(response.ok()).toBe(true)
  }
  await page.reload()
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  let failJump = true
  await page.route(`**/api/sessions/${jumpIds[0]}`, async (route) => {
    if (failJump && route.request().method() === 'GET') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'temporary' } }),
      })
    } else await route.continue()
  })
  await page.keyboard.press('Control+k')
  await page.getByLabel('搜索标题和消息内容').fill(jumpIds[0])
  await page
    .getByRole('dialog', { name: '搜索历史' })
    .getByRole('button', { name: new RegExp(jumpIds[0]) })
    .click()
  await expect(page.getByRole('dialog', { name: '搜索历史' }).getByRole('status')).toContainText(
    '无法定位消息'
  )
  failJump = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '搜索历史' })).toHaveCount(0)
  await expect(page.locator('main')).toContainText(jumpIds[0])
  await page.unroute(`**/api/sessions/${jumpIds[0]}`)

  let releaseJump
  await page.route(`**/api/sessions/${jumpIds[1]}`, async (route) => {
    await new Promise((resolve) => {
      releaseJump = resolve
    })
    await route.continue()
  })
  await page.keyboard.press('Control+k')
  await page.getByLabel('搜索标题和消息内容').fill(jumpIds[1])
  await page
    .getByRole('dialog', { name: '搜索历史' })
    .getByRole('button', { name: new RegExp(jumpIds[1]) })
    .click()
  await expect.poll(() => Boolean(releaseJump)).toBe(true)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  const lateResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/sessions/${jumpIds[1]}`)
  )
  releaseJump()
  await lateResponse
  await expect(page.locator('main')).toContainText(jumpIds[0])
  expect(
    await page.evaluate(() => localStorage.getItem('chat-demo:active-session:cloud'))
  ).not.toBe(jumpIds[1])
  await page.unroute(`**/api/sessions/${jumpIds[1]}`)
  console.log(
    'PASS: failed result jumps retry the original target; closing search cancels delayed navigation'
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'MCP', exact: true }).click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.getByLabel('连接名称', { exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(output, 'mcp-mobile.png') })
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth > innerWidth,
    dialog: [...document.querySelectorAll('dialog[open]')].some(
      (dialog) => dialog.scrollWidth > dialog.clientWidth
    ),
  }))
  expect(overflow).toEqual({ page: false, dialog: false })
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '收起边栏', exact: true }).click()
  await page.screenshot({ path: path.join(output, 'chat-mobile.png') })
  await checkComposer()
  await composerModel().click()
  await page.getByRole('option', { name: longModel, exact: true }).click()
  for (const width of [320, 360, 390, 439, 767]) {
    await page.setViewportSize({ width, height: 844 })
    await checkComposer()
    await composerModel().click()
    const menu = await page.getByRole('listbox', { name: '模型', exact: true }).boundingBox()
    expect(menu.x).toBeGreaterThanOrEqual(0)
    expect(menu.x + menu.width).toBeLessThanOrEqual(width)
    await page.keyboard.press('Escape')
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByPlaceholder('请输入消息').click()
  await page.screenshot({ path: path.join(output, 'long-model-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: '搜索历史', exact: true }).click()
  await page.getByLabel('搜索标题和消息内容').fill('TOKEN')
  await expect(page.getByRole('button', { name: /Hidden TOKEN/ }).first()).toBeVisible()
  await page.screenshot({ path: path.join(output, 'search-mobile.png') })
  expect((await page.locator('dialog[open] > div').boundingBox()).y).toBe(68)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: path.join(output, 'search-dark-mobile.png') })
  expect(
    await page.locator('dialog[open] > div').evaluate((el) => getComputedStyle(el).backgroundColor)
  ).not.toBe('rgba(0, 0, 0, 0)')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  expect(errors).toEqual([])
  console.log(
    `PASS: mobile settings and chat fit without horizontal overflow; screenshots: ${output}`
  )
} catch (error) {
  console.error('Failed session requests:', failedRequests)
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  console.error(`Screenshots: ${output}`)
  throw error
} finally {
  await browser.close()
}
