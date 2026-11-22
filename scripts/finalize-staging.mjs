/**
 * 离线完成「暂存 → 正式」提交，绕过 HTTP 代理 30 秒超时（大归档 commit 会被 504 打断）。
 *
 * 用途：当 UI 导入已把数据写入暂存、但最终提交因超时/重启失败时，运行本脚本即可
 * 把暂存数据提交为正式数据。它只调用与 /api/staging/commit 相同的 commitStaging()，
 * 因此行为与正常路径完全一致，只是不经由网络。
 *
 *   node scripts/finalize-staging.mjs
 */
import { DatabaseSync } from 'node:sqlite'

const DB_FILE = process.env.DB_FILE ?? 'data/chat-demo.db'

// 先只读检查暂存数据是否完整，避免空提交清掉现有历史。
const check = new DatabaseSync(DB_FILE, { readOnly: true })
const staged = check.prepare('SELECT count(*) n FROM staging_sessions').get().n
const stagedFiles = check.prepare('SELECT count(*) n FROM staging_files').get().n
check.close()
console.log(`暂存数据：${staged} 个会话，${stagedFiles} 个附件`)
if (staged === 0) {
  console.log('暂存区为空，无需提交。')
  process.exit(0)
}

const { commitStaging } = await import('../server/db.mjs')
const started = Date.now()
const summaries = commitStaging()
console.log(`提交完成：${summaries.length} 个会话，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
