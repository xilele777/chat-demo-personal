import { spawnSync } from 'node:child_process'

const cloud = process.argv.includes('--cloud')
const result = spawnSync(
  process.execPath,
  ['node_modules/@rspack/cli/bin/rspack.js', 'build', '-c', 'rspack.config.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production', CHAT_CLOUD: String(cloud) },
  }
)
process.exit(result.status ?? 1)
