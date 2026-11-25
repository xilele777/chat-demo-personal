// Exercise the actual download/import UI, IndexedDB staging and local D1/R2.
import { chromium, expect } from '@playwright/test'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { rspack } from '@rspack/core'
import { readArchive, readEntry } from '../src/services/chat/history/zipReader.ts'
import { writeArchive } from '../src/services/chat/history/zipWriter.ts'

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
const id = `backup-${Date.now()}`
const fileId = `${id}-text`
const original = '跨设备备份的文本附件 original text'
const detail = async () => (await context.request.get(`${origin}/api/sessions/${id}`)).json()
// Bundle the production IndexedDB adapter for fault injection in a real browser.
const output = await mkdtemp(path.join(tmpdir(), 'personal-chat-idb-'))
await new Promise((resolve, reject) => {
  const compiler = rspack({
    mode: 'production',
    target: 'web',
    entry: path.resolve('src/services/chat/localDb.ts'),
    output: { path: output, filename: 'idb.js', library: { type: 'window', name: 'backupTestDb' } },
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
    compiler.close((closeError) => {
      if (error || closeError || stats.hasErrors())
        reject(error ?? closeError ?? new Error(stats.toString()))
      else resolve()
    })
  )
})
try {
  await page.goto(origin)
  await page.getByLabel('访问密码', { exact: true }).fill('local-smoke-password-only')
  await page.getByRole('button', { name: '进入个人空间', exact: true }).click()
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  const index = await (await context.request.get(`${origin}/api/sessions`)).json()
  expect(
    (
      await context.request.put(`${origin}/api/files/${fileId}`, {
        data: Buffer.from(original),
        headers: { 'Content-Type': 'text/plain' },
      })
    ).ok()
  ).toBe(true)
  const session = {
    id,
    title: id,
    titleSource: 'manual',
    pinned: true,
    createdAt: 1,
    updatedAt: Date.now(),
    rootMessageId: 'q',
    messages: [
      {
        id: 'q',
        role: 'user',
        parentId: null,
        selectedChildId: 'a',
        createdAt: 1,
        content: '备份原件问题',
        files: [
          {
            id: fileId,
            name: 'original.txt',
            serverId: 'stale-handle',
            isImage: false,
            size: Buffer.byteLength(original),
            mimeType: 'text/plain',
          },
        ],
      },
      {
        id: 'a',
        role: 'assistant',
        parentId: 'q',
        createdAt: 2,
        status: 'done',
        prefix: true,
        model: 'test-model',
        processingSeconds: 12.5,
        blocks: [{ type: 'text', text: '备份原件回答' }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 40,
          reasoning_tokens: 10,
          cache_reported: true,
        },
        mcpTools: [
          {
            type: 'mcp_tool',
            id: 'created',
            name: 'create_note',
            server: 'Notes',
            input: { title: '保存过的笔记' },
            status: 'done',
            output: 'note-123',
          },
        ],
      },
      {
        id: 'alternative',
        role: 'assistant',
        parentId: 'q',
        createdAt: 3,
        status: 'done',
        prefix: true,
        model: 'test-model',
        blocks: [{ type: 'text', text: '隐藏的回答分支' }],
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
  await page.addScriptTag({ content: await readFile(path.join(output, 'idb.js'), 'utf8') })
  const atomic = await page.evaluate(
    async ({ session, fileId }) => {
      const db = window.backupTestDb
      const pending = { ...session, id: `${session.id}-atomic` }
      const localFile = `${fileId}-atomic`
      await db.putOutbox(pending, 'old', [{ id: localFile, blob: new Blob(['old original']) }])
      let rejected = false
      try {
        await db.putOutbox({ ...pending, title: 'new' }, 'new', [
          { id: localFile, blob: new Blob(['new original']) },
          { id: 'invalid', blob: () => {} }, // Real structured-clone failure after the first put.
        ])
      } catch {
        rejected = true
      }
      const oldVersion = (await db.loadOutbox()).find((item) => item.id === pending.id).version
      const oldOriginal = await (await db.loadFile(localFile)).text()
      await db.putOutbox({ ...pending, title: 'new' }, 'new', [
        { id: localFile, blob: new Blob(['new original']) },
      ])
      const newVersion = (await db.loadOutbox()).find((item) => item.id === pending.id).version
      const newOriginal = await (await db.loadFile(localFile)).text()
      await db.removeOutboxSnapshot(pending.id, undefined)
      const legacyProtected = (await db.loadOutbox()).some(
        (item) => item.id === pending.id && item.version === 'new'
      )
      await db.putOutbox(pending, 'a-old', [], 'writer-a')
      await db.putOutbox(pending, 'b-new', [], 'writer-b')
      await db.putOutbox(pending, 'a-new', [], 'writer-a')
      await db.removeOutbox(pending.id, 'a-old', 'writer-a')
      const writerVersions = (await db.loadOutbox())
        .filter((item) => item.session.id === pending.id && item.writer)
        .map((item) => [item.writer, item.version])
        .sort()
      await db.removeOutbox(pending.id, undefined, 'writer-a')
      const otherWriterProtected = (await db.loadOutbox()).some(
        (item) => item.writer === 'writer-b' && item.session.id === pending.id
      )
      await db.removeOutbox(pending.id, 'b-new', 'writer-b')
      await db.removeOutbox(pending.id)
      return {
        rejected,
        oldVersion,
        oldOriginal,
        newVersion,
        newOriginal,
        legacyProtected,
        writerVersions,
        otherWriterProtected,
      }
    },
    { session, fileId }
  )
  expect(atomic).toEqual({
    rejected: true,
    oldVersion: 'old',
    oldOriginal: 'old original',
    newVersion: 'new',
    newOriginal: 'new original',
    legacyProtected: true,
    writerVersions: [
      ['writer-a', 'a-new'],
      ['writer-b', 'b-new'],
    ],
    otherWriterProtected: true,
  })
  console.log(
    'PASS: actual IndexedDB clone failure atomically rolls back outbox and attachment writes'
  )
  await page.reload()
  await expect(page.locator(`[data-session-item="${id}"]`)).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '数据管理', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  const downloading = page.waitForEvent('download')
  await settings.getByRole('button', { name: '下载', exact: true }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^personal-chat-.*\.zip$/)
  const bytes = await readFile(await download.path())
  const entries = []
  for await (const entry of readArchive(new File([bytes], 'snapshot.zip'))) {
    entries.push({ name: entry.path, blob: await readEntry(entry) })
  }
  const manifest = JSON.parse(await entries[0].blob.text())
  expect(manifest).toEqual({ format: 'chat-demo-personal', version: 1 })
  const exported = JSON.parse(
    await entries.find((entry) => entry.name.endsWith(`/${id}.json`)).blob.text()
  )
  expect(exported.messages[0].files[0].serverId).toBe(null)
  expect(exported.messages[1].mcpTools[0].output).toBe('note-123')
  const fileIndex = JSON.parse(
    await entries.find((entry) => entry.name === 'snapshot/index.json').blob.text()
  )
  const originalEntry = fileIndex.files.find((file) => file.id === fileId)
  expect(await entries.find((entry) => entry.name === originalEntry.path).blob.text()).toBe(
    original
  )

  // An absent declared original must fail without committing any staged sessions.
  const invalid = await writeArchive(entries.filter((entry) => entry.name !== originalEntry.path))
  const before = await detail()
  await settings.locator('input[accept*=".zip"]').setInputFiles({
    name: 'incomplete.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await invalid.arrayBuffer()),
  })
  await page
    .getByRole('dialog', { name: '确认导入历史对话？', exact: true })
    .getByRole('button', { name: '确认导入', exact: true })
    .click()
  await expect(settings).toContainText('文件导入失败')
  expect(await detail()).toEqual(before)
  expect((await (await context.request.get(`${origin}/api/sessions`)).json()).generation).toBe(
    index.generation
  )

  await settings.locator('input[accept*=".zip"]').setInputFiles({
    name: 'snapshot.zip',
    mimeType: 'application/zip',
    buffer: bytes,
  })
  let lostCommitId
  await page.route(
    '**/api/history/imports/*/commit',
    async (route) => {
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      lostCommitId = route.request().url().split('/').at(-2)
      await route.abort('connectionreset')
    },
    { times: 1 }
  )
  await page
    .getByRole('dialog', { name: '确认导入历史对话？', exact: true })
    .getByRole('button', { name: '确认导入', exact: true })
    .click()
  await expect(settings).toContainText(/已导入 \d+ 个?对话/)
  const after = await detail()
  expect(after.session).toEqual(exported)
  expect(after.generation).not.toBe(before.generation)
  expect(after.generation).toBe(lostCommitId)
  expect(await (await context.request.get(`${origin}/api/files/${fileId}`)).text()).toBe(original)
  await page.reload()
  await page
    .locator(`[data-session-item="${id}"]`)
    .getByRole('button', { name: id, exact: true })
    .click()
  await expect(page.getByText('备份原件回答', { exact: true })).toBeVisible()
  await expect(page.getByText('隐藏的回答分支', { exact: true })).toHaveCount(0)
  expect((await detail()).session.messages[2].blocks[0].text).toBe('隐藏的回答分支')
  expect(errors).toEqual([])
  console.log(
    'PASS: actual snapshot download, R2 text originals, strict import rollback, D1 replacement and persisted hidden branches/MCP/usage'
  )
} finally {
  await browser.close()
}
