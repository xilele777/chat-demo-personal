// Run against the isolated server from smoke-cloud.mjs --serve.
import { chromium, expect } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const origin = process.env.UI_ORIGIN ?? 'http://127.0.0.1:8788'
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname))
  throw new Error('Use the isolated local mock server')
const output = await mkdtemp(path.join(tmpdir(), 'personal-chat-interactions-'))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({
  viewport: { width: 1366, height: 900 },
  locale: 'zh-CN',
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const ids = ['first', 'second', 'survivor'].map((name) => `ui-batch-${name}-${Date.now()}`)
try {
  await page.goto(origin)
  await page.getByLabel('访问密码', { exact: true }).fill('local-smoke-password-only')
  await page.getByRole('button', { name: '进入个人空间', exact: true }).click()
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  const generation = (await (await context.request.get(`${origin}/api/sessions`)).json()).generation
  for (const id of ids) {
    const response = await context.request.put(`${origin}/api/sessions/${id}`, {
      data: {
        revision: null,
        generation,
        session: {
          id,
          title: id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          rootMessageId: 'q',
          messages: [
            {
              id: 'q',
              role: 'user',
              content: '验收问题',
              files: [],
              parentId: null,
              selectedChildId: 'a',
            },
            {
              id: 'a',
              role: 'assistant',
              parentId: 'q',
              status: 'done',
              blocks: [
                { type: 'thinking', thinking: '思考显示验收' },
                { type: 'text', text: '验收回答' },
              ],
            },
          ],
        },
      },
    })
    expect(response.ok()).toBe(true)
  }
  await page.reload()
  const row = (id) => page.locator(`[data-session-item="${id}"]`)
  await row(ids[0]).getByRole('button', { name: ids[0], exact: true }).click()
  await expect(page.locator('.ds-think-content')).toContainText('思考显示验收')
  await page.getByRole('button', { name: '返回新对话', exact: true }).click()
  await expect(page.getByRole('heading')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('chat-demo:active-session:cloud'))).toBe('')
  await page.screenshot({ path: path.join(output, 'welcome-desktop.png') })
  const checkWelcome = async (width) => {
    await page.setViewportSize({ width, height: 844 })
    const dimensions = await page.getByRole('heading').evaluate((heading) => {
      const group = heading.parentElement,
        welcome = group.parentElement
      const composer = welcome.querySelector('textarea').closest('[class*="wrapper-"]')
      const title = group.getBoundingClientRect(),
        box = composer.getBoundingClientRect(),
        container = welcome.getBoundingClientRect()
      return {
        gap: box.top - title.bottom,
        inset: box.left - container.left,
        titleSize: getComputedStyle(group).fontSize,
        bottom: box.bottom,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }
    })
    expect(dimensions.gap).toBe(27)
    expect(dimensions.inset).toBe(32)
    expect(dimensions.titleSize).toBe(width < 440 ? '20px' : '24px')
    expect(dimensions.bottom).toBeLessThan(780)
    expect(dimensions.overflow).toBe(false)
  }
  for (const width of [320, 390, 767, 768, 1024, 1366]) await checkWelcome(width)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(output, 'welcome-mobile.png') })
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '多选对话', exact: true }).click()
  await page.getByRole('checkbox', { name: ids[2], exact: true }).click()
  await page.getByRole('button', { name: '收起边栏', exact: true }).click()
  await page.getByRole('button', { name: '返回新对话', exact: true }).click()
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await page.getByRole('button', { name: '多选对话', exact: true }).click()
  await page.getByRole('checkbox', { name: ids[0], exact: true }).click()
  await expect(page.getByRole('checkbox', { name: ids[0], exact: true })).toBeChecked()
  await page.getByRole('button', { name: '退出多选', exact: true }).click()
  await page.getByRole('button', { name: '返回新对话', exact: true }).click()
  await expect(page.getByRole('heading')).toBeVisible()
  await page.setViewportSize({ width: 1366, height: 900 })
  await page.getByRole('button', { name: '多选对话', exact: true }).click()
  await page.getByRole('button', { name: '全选对话', exact: true }).click()
  expect(await page.getByRole('checkbox', { checked: true }).count()).toBeGreaterThanOrEqual(3)
  await page.getByRole('button', { name: '取消全选', exact: true }).click()
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(0)
  for (const id of ids.slice(0, 2))
    await page.getByRole('checkbox', { name: id, exact: true }).click()
  await expect(page.getByRole('heading')).toBeVisible()
  await page.getByRole('button', { name: '收起边栏', exact: true }).click()
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: ids[0], exact: true })).toBeChecked()
  await page.getByRole('button', { name: '置顶', exact: true }).click()
  await expect
    .poll(async () => {
      const data = (await (await context.request.get(`${origin}/api/sessions`)).json()).sessions
      return ids.slice(0, 2).every((id) => data.find((session) => session.id === id)?.pinned)
    })
    .toBe(true)
  await expect(page.getByRole('button', { name: '取消置顶', exact: true })).toBeEnabled()
  await page.screenshot({ path: path.join(output, 'batch-desktop.png') })
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('2 个对话')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(row(ids[0])).toBeVisible()
  let failSecond = true
  await page.route(`**/api/sessions/${ids[1]}`, async (route) => {
    if (failSecond && route.request().method() === 'DELETE')
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '模拟删除失败' } }),
      })
    else await route.continue()
  })
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText(ids[1])
  await expect(page.getByRole('dialog')).not.toContainText(ids[0])
  expect((await context.request.get(`${origin}/api/sessions/${ids[0]}`)).status()).toBe(404)
  failSecond = false
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(row(ids[1])).toHaveCount(0)
  await expect(row(ids[2])).toBeVisible()
  await row(ids[2]).getByRole('button', { name: ids[2], exact: true }).click()
  await page.getByRole('button', { name: '收起边栏', exact: true }).click()
  await page.getByRole('button', { name: '返回新对话', exact: true }).click()
  await expect(page.getByRole('heading')).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  expect(
    await page
      .locator('[data-chat-sidebar]')
      .evaluate(
        (sidebar) =>
          sidebar.parentElement
            .getAnimations({ subtree: true })
            .filter((animation) => animation instanceof CSSTransition).length
      )
  ).toBe(0)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: path.join(output, 'welcome-dark.png') })
  expect(errors).toEqual([])
  console.log(
    `PASS: brand navigation, reference welcome spacing, mobile selection, select all, persistent collapse state, batch pin/delete, partial-failure retry and reduced motion; screenshots: ${output}`
  )
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  console.error(`Screenshots: ${output}`)
  throw error
} finally {
  for (const id of ids) await context.request.delete(`${origin}/api/sessions/${id}`).catch(() => {})
  await browser.close()
}
