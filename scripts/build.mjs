#!/usr/bin/env node
/**
 * 跨平台生产构建。
 *
 * 原先 package.json 用 `rm -rf dist && NODE_ENV=production rspack build ...`，
 * 这两个 shell 语法在 Windows（cmd / PowerShell）下都不可用。这里用 Node 完成
 * 清理与环境变量注入，再调用本地 rspack，保持各平台行为一致。
 */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
rmSync(path.join(root, 'dist'), { recursive: true, force: true })

const isStatic = process.argv.includes('--static')
const bin = process.platform === 'win32' ? 'rspack.cmd' : 'rspack'
const result = spawnSync(bin, ['build', '-c', 'rspack.config.ts'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    ...(isStatic ? { STATIC_MODE: '1' } : {}),
  },
})

if (result.error) {
  console.error(result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)
