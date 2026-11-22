/**
 * 重新编译 Rust CRC32 → WASM 并复制到 src，让普通 pnpm build 无需 Rust 工具链。
 *
 * 需要：Rust 工具链 + wasm32-unknown-unknown target。
 * 若本机 stable 工具链缺 cargo/target，可用环境变量指定：
 *   $env:CARGO_TOOLCHAIN='+1.95.0'; node scripts/build-wasm.mjs
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const toolchain = process.env.CARGO_TOOLCHAIN ?? ''
const manifest = resolve(root, 'crates/crc32-wasm/Cargo.toml')
const built = resolve(
  root,
  'crates/crc32-wasm/target/wasm32-unknown-unknown/release/crc32_wasm.wasm'
)
const dest = resolve(root, 'src/services/chat/history/wasm/crc32_wasm.wasm')

const args = ['build', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest]
if (toolchain) {
  args.unshift(toolchain)
}
console.log('building wasm:', 'cargo', args.join(' '))
execFileSync('cargo', args, { cwd: root, stdio: 'inherit' })
mkdirSync(dirname(dest), { recursive: true })
copyFileSync(built, dest)
console.log('copied ->', dest)
