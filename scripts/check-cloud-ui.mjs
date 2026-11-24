// Start isolated D1/R2 and deterministic providers, then run all browser checks.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'

const freePort = async () => {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
const workerPort = await freePort(),
  modelPort = await freePort()
const env = {
  ...process.env,
  SMOKE_WORKER_PORT: String(workerPort),
  SMOKE_MODEL_PORT: String(modelPort),
  UI_ORIGIN: `http://127.0.0.1:${workerPort}`,
  UI_MODEL_PORT: String(modelPort),
  WRANGLER_SEND_METRICS: 'false',
}
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/smoke-cloud.mjs', '--serve'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  windowsHide: true,
})
const exited = new Promise((resolve) => server.once('exit', (code) => resolve(code)))
let logs = ''
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Cloud UI server startup timed out.\n${logs}`)),
      60_000
    )
    server.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    server.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Cloud UI server exited (${code}).\n${logs}`))
    })
    server.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      process.stdout.write(text)
      logs = (logs + text).slice(-12000)
      if (logs.includes('Browser preview ready')) {
        clearTimeout(timer)
        resolve()
      }
    })
    server.stderr.on('data', (chunk) => {
      logs = (logs + chunk).slice(-12000)
      process.stderr.write(chunk)
    })
  })
  for (const name of [
    'check-ui',
    'check-interactions',
    'check-streaming-ui',
    'check-reliability-ui',
  ]) {
    const check = spawn(process.execPath, [`scripts/${name}.mjs`], {
      env,
      stdio: 'inherit',
      windowsHide: true,
    })
    const [code] = await once(check, 'exit')
    if (code !== 0) throw new Error(`${name} failed (${code})`)
  }
} finally {
  if (server.connected) server.send({ type: 'shutdown' })
  const timer = setTimeout(() => server.kill(), 10_000)
  await exited
  clearTimeout(timer)
}
