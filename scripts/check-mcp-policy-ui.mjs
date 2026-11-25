import { chromium, expect } from '@playwright/test'
const origin = process.env.UI_ORIGIN
if (!origin || !['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
  throw new Error('Use the isolated cloud UI server')
const model = `http://127.0.0.1:${process.env.UI_MODEL_PORT}`
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
})
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 1366, height: 900 },
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const config = {
  name: 'Policy Notes',
  url: `${model}/mcp`,
  token: 'smoke-mcp',
  enabled: true,
  disabledTools: [],
  trustedReadTools: [],
}
const counts = async () => (await context.request.get(`${model}/__mcp-counts`)).json()
try {
  await page.goto(origin)
  await page.getByLabel('访问密码', { exact: true }).fill('local-smoke-password-only')
  await page.getByRole('button', { name: '进入个人空间', exact: true }).click()
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  for (const server of (await (await context.request.get(`${origin}/api/mcp/servers`)).json())
    .servers)
    await context.request.delete(`${origin}/api/mcp/servers/${server.id}`)
  expect(
    (await context.request.put(`${origin}/api/mcp/servers/policy-notes`, { data: config })).ok()
  ).toBe(true)
  await page.getByRole('button', { name: '模型', exact: true }).click()
  await page.getByRole('option', { name: 'second-model', exact: true }).click()
  const before = await counts()
  await page.getByPlaceholder('请输入消息').fill('mcp-read')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const approval = page.getByRole('button', { name: '允许这次调用', exact: true })
  await expect(approval).toBeVisible()
  const current = (await (await context.request.get(`${origin}/api/mcp/servers`)).json()).servers[0]
  expect(
    (
      await context.request.put(`${origin}/api/mcp/servers/policy-notes`, {
        data: { ...current, disabledTools: ['read_note'] },
      })
    ).ok()
  ).toBe(true)
  await expect(page.getByText('调用失败', { exact: true })).toBeVisible()
  await page.getByText('参数与结果', { exact: true }).click()
  await expect(page.getByText(/MCP configuration changed or permission was revoked/)).toBeVisible()
  await expect(approval).toHaveCount(0)
  expect(await counts()).toEqual(before)
  // Configure explicit automatic reads in the actual form, then verify a fresh request.
  expect(
    (await context.request.put(`${origin}/api/mcp/servers/policy-notes`, { data: config })).ok()
  ).toBe(true)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'MCP', exact: true }).click()
  await page
    .getByRole('region', { name: 'Policy Notes', exact: true })
    .getByRole('button', { name: '编辑', exact: true })
    .click()
  const trust = page.getByRole('checkbox', { name: '信任 read_note，允许自动读取', exact: true })
  await expect(trust).not.toBeChecked()
  await trust.focus()
  await page.keyboard.press('Space')
  await expect(trust).toBeChecked()
  // Changing a checkbox alone must not persist authority.
  expect(
    (await (await context.request.get(`${origin}/api/mcp/servers`)).json()).servers[0]
      .trustedReadTools
  ).toEqual([])
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: '保存连接', exact: true }).click()
  expect(
    (await (await context.request.get(`${origin}/api/mcp/servers`)).json()).servers[0]
      .trustedReadTools
  ).toEqual(['read_note'])
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '开启新对话', exact: true }).click()
  await page.getByPlaceholder('请输入消息').fill('mcp-read')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('调用完成', { exact: true })).toBeVisible()
  await expect(approval).toHaveCount(0)
  expect((await counts()).reads).toBe(before.reads + 1)
  expect((await counts()).writes).toBe(before.writes)
  expect(errors).toEqual([])
  console.log(
    'PASS: real D1 read-hint confirmation, in-flight tool revocation without dispatch, explicit trust saved through keyboard/mobile form, and fresh automatic read'
  )
} finally {
  await context.request.delete(`${origin}/api/mcp/servers/policy-notes`)
  await browser.close()
}
