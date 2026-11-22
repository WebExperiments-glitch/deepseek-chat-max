#!/usr/bin/env node
/**
 * 静态审计闸门（大厂化工程基建）—— 本地 pre-push 与 CI audit 共用的同一道门。
 *
 * 设计原则（抄自成熟实践）：
 * - 只做**可机械判定**的检查，审美判断交给人工 review 与 ds-demo 校验器。
 * - 每条规则都写清楚「为什么」，失败时给出文件:行与修复方向，而不是只报一个红。
 * - 白名单优先：新增文件默认受检，豁免必须写进本文件的显式清单并说明理由。
 * - 退出码 0 = 全部通过；1 = 存在阻断项。WARN 不阻断但会打印。
 *
 * 用法：node scripts/review-gate.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let errors = 0
let warnings = 0
const fail = (file, line, rule, why) => {
  errors += 1
  console.error(`ERROR [${rule}] ${file}${line ? ':' + line : ''}  ${why}`)
}
const warn = (file, line, rule, why) => {
  warnings += 1
  console.warn(`WARN  [${rule}] ${file}${line ? ':' + line : ''}  ${why}`)
}

/** 遍历受检文件，跳过依赖/产物/研究目录 */
const SKIP_DIR = /(node_modules|dist|build|\.git|coverage|data|_research|crates|tmp)/i
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|jsx|json|yml|yaml|md|html|css)$/i
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.test(name)) {
      continue
    }
    const full = path.join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      collect(full, out)
    } else if (TEXT_EXT.test(name)) {
      out.push(full)
    }
  }
  return out
}
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/')
const files = collect(ROOT)

// ── 规则 1：任何密钥/私钥不得进 git ──────────────────────────────
// 说明：公开仓库里密钥一旦推送就视为已泄露，必须轮换。这里做高置信度模式扫描，
// 真正的兜底是 GitHub secret scanning + push protection（在本仓库已开启）。
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9]{20,}/g, 'OpenAI/DeepSeek 风格的 API Key'],
  [/ghp_[A-Za-z0-9]{30,}/g, 'GitHub Personal Access Token'],
  [/gho_[A-Za-z0-9]{30,}/g, 'GitHub OAuth Token'],
  [/github_pat_[A-Za-z0-9_]{40,}/g, 'GitHub fine-grained PAT'],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, '私钥'],
  [/AKIA[0-9A-Z]{16}/g, 'AWS Access Key'],
]
// 这些路径允许出现上述模式：测试用例与文档里的占位/示例（明确标注为非真实值）
const SECRET_ALLOW = /(^|\/)([^/]*\.test\.[^/]+|\.env\.example|NOTICE|README[^/]*\.md|SECURITY\.md|docs\/)/i
for (const file of files) {
  const r = rel(file)
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (SECRET_ALLOW.test(r)) {
      return
    }
    for (const [re, label] of SECRET_PATTERNS) {
      re.lastIndex = 0
      if (re.test(line)) {
        fail(r, i + 1, 'secret', `疑似${label}——公开仓库禁止提交，如为真值请立即轮换并改用环境变量`)
      }
    }
  })
}

// ── 规则 2：核心层不得直接依赖 DOM / 平台全局 / 裸 fetch ──────────
// 说明：services/ 是领域层，必须经 ports/ 访问平台。直接 import document/window 或
// 裸 fetch 会破坏 iOS 移植与静态模式（我们刚建立的 ports/http.ts、ports/platform.ts）。
// 例外：adapters/ 是平台实现层，本就允许；browserBackend/browserBackup 是静态模式的
// 浏览器适配器，允许用 IndexedDB/Blob；测试允许 stub。
const CORE_DIRS = /(^|\/)services\/(?!api\/browser(Backup|Backend))/
const DOM_GLOBAL = /\b(document\.|window\.|navigator\.|new AudioContext|new FileReader|URL\.createObjectURL|URL\.revokeObjectURL|\bbtoa\()/
const BARE_FETCH = /(?<![\w.])fetch\s*\(/
for (const file of files) {
  const r = rel(file)
  if (!CORE_DIRS.test(r) || r.includes('.test.')) {
    continue
  }
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
    // codePreview.ts 的 READY_PROBE 是注入到 iframe 的 HTML 字符串（其中的 window.parent
    // 是沙箱页面里的代码，不是本模块访问 DOM），属于合法字面量，跳过含 HTML 标签的行。
    const isInjectedHtml = r.includes('codePreview') && /<script|<style|<meta/i.test(line)
    if (DOM_GLOBAL.test(code) && !isInjectedHtml) {
      fail(r, i + 1, 'core-platform', '核心层直接用了 DOM/平台全局，请经 ports/platform.ts 注入')
    }
    if (BARE_FETCH.test(code) && !r.includes('ports/http')) {
      fail(r, i + 1, 'core-fetch', '核心层存在裸 fetch，请改用 ports/http.ts 的 http()')
    }
  })
}

// ── 规则 3：错误脱敏——对外暴露的服务端不得回传原始 error.message ──
// 说明：本地服务一旦被 HOST=0.0.0.0 暴露，原始错误信息可能含端点/密钥片段。
// server/index.mjs 必须用 publicErrorMessage() 脱敏，不能裸 sendError(error.message)。
const serverFile = path.join(ROOT, 'server/index.mjs')
if (!files.includes(serverFile)) {
  // server 是 .mjs 会被收集
  warn('server/index.mjs', 0, 'gate-missing', '未找到 server/index.mjs，跳过错误脱敏检查')
} else {
  const text = readFileSync(serverFile, 'utf8')
  if (!text.includes('publicErrorMessage')) {
    fail('server/index.mjs', 0, 'error-redaction', '缺少 publicErrorMessage()——对外暴露时会回传原始错误详情')
  }
  if (!text.includes('AUTH_TOKEN')) {
    fail('server/index.mjs', 0, 'fail-closed-auth', '缺少 AUTH_TOKEN fail-closed 鉴权——对外暴露无保护')
  }
}

// ── 规则 4：大文件（>2MB 进 git 需显式说明理由）───────────────────
const BIG_FILE_MB = 2
for (const file of files) {
  const size = statSync(file).size
  if (size > BIG_FILE_MB * 1024 * 1024) {
    warn(rel(file), 0, 'big-file', `${(size / 1024 / 1024).toFixed(1)}MB，确认是否真需要进 git`)
  }
}

// ── 规则 5：CI workflow 权限最小化 ───────────────────────────────
// 说明：每个 workflow 必须显式声明 permissions，不给默认的 write-all。
const wfDir = path.join(ROOT, '.github/workflows')
if (readdirSync(wfDir).length) {
  for (const name of readdirSync(wfDir)) {
    if (!/\.ya?ml$/i.test(name)) {
      continue
    }
    const text = readFileSync(path.join(wfDir, name), 'utf8')
    if (!/^permissions:/m.test(text)) {
      fail(`.github/workflows/${name}`, 0, 'ci-permissions', 'workflow 未声明 permissions，可能默认 write-all')
    }
    // action 必须用 SHA 锁定（防止上游 tag 被劫持）——允许 actions/ 官方 action 用 @vN 形式也可接受
    const shortSha = /uses:\s*[^@\s]+@v\d+\b/.test(text)
    if (shortSha) {
      warn(`.github/workflows/${name}`, 0, 'ci-pin', '存在用 @vN 而非 SHA 锁定的 action，建议锁 SHA 防供应链攻击')
    }
  }
}

console.log(`\nreview-gate: 检查 ${files.length} 个文件 · ERROR ${errors} · WARN ${warnings}`)
process.exit(errors > 0 ? 1 : 0)
