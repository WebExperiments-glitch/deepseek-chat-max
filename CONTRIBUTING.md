# 贡献与合并规则 · deepseek-chat-max

> 这个仓库是公开的，有真实用户在使用。合并门槛按「一点纰漏都不能有」设。
> 总纲：**能让下一个人独立验证你的判断**。做不到这一点，改动再漂亮也会被打回。

## 1. 分支与合并

- `main` **只接受 PR**，必需检查 `check` / `audit` / CodeQL，管理员也不可绕过，历史保持线性。
- 一人一分支，从最新 `main` 切：`git checkout -b fix/短横线描述 main`。
- **一律 squash 合并**：一个 PR = 一件事 = 一个 commit，`git log` 读起来就是变更史。
- 合并前必须与 `main` 同步（strict 分支保护），冲突自己解。

## 2. 提交信息

```
type(scope): 一句话（≤ 72 字，祈使句，不加句号）

正文：为什么这么改（现象 → 根因 → 取舍）。没有"为什么"的正文等于没写。
```

- `type`：`feat` `fix` `docs` `test` `chore` `refactor` `perf` `ci`
- `scope`：`api` `chat` `ui` `memory` `search` `speech` `build` `ci` `docs` `db`
- 首行会成为 squash 后的 commit message，永久留在 main 上。

## 3. 本地闸门（pre-push）

```bash
git config core.hooksPath .githooks   # 仓库根执行一次
```

之后每次 `git push` 自动跑 `.githooks/pre-push`：

1. **review-gate**：密钥/私钥扫描、核心层平台依赖、错误脱敏、大文件、CI 权限。
2. **全质量门**：`pnpm type` / `pnpm lint` / `pnpm test` / `pnpm test:server` / `pnpm build`。

失败即拒绝推送。`--no-verify` 可绕过本地钩子，但绕不过 CI 与分支保护。

## 4. PR 必须包含四块

**为什么 / 改了什么 / 怎么验证的 / 风险与回滚**。模板见 `.github/pull_request_template.md`。
「怎么验证的」一栏**贴命令与输出**，不要写「已测试」——CI 会重跑，但 reviewer 要先看到你的判断过程。

### 会被直接打回的情形

| 情形 | 为什么 |
|---|---|
| 正文没有验证证据 | reviewer 只能信你，那就不是 review 了 |
| 提交任何密钥 / token / 私钥 | 公开仓库一旦推送即视为泄露，必须轮换 |
| 核心层直接 import DOM / 裸 fetch | 破坏 ports/adapters 边界与 iOS / 静态模式移植 |
| 改请求构造却没跑 `prefixStability.test.ts` | 前缀缓存正确性是硬约束，红灯必须修代码而非改断言 |
| 加依赖 / 改 CI 不说明理由 | 供应链与流水线是公共资产 |
| 一个 PR 混了多件不相关的事 | squash 之后无法单独回滚 |

## 5. 按改动类型加跑

| 改动 | 加跑 |
|---|---|
| 请求构造 / 压缩 / 记忆 / 时间注入 | `pnpm test`（含 `prefixStability.test.ts`，红灯即修） |
| 服务端入口 / 错误处理 / 鉴权 | `pnpm test:server`（DB + 安全测试，含对外暴露 fail-closed） |
| 静态模式 / 浏览器存储 | `pnpm build:static` 并人工验证 IndexedDB 与 ZIP 备份 |
| UI 风格 | ds-demo 校验器 + 浏览器暗色模式实测 |

## 6. 文档

改行为就要改文档，而且**要改到每一处**。README（中英）、NOTICE 的版本/能力说明保持一致。
写文档两条硬规矩：

1. 改结论要说明「旧结论错在哪」，而不是删掉旧文换成新的。
2. 数字必须能复现：给出复现命令，或说明它由哪个脚本产生。

## 7. 发布

```bash
# 版本号由维护者决定（README/NOTICE/package.json 保持一致）
pnpm build          # 本机模式产物
pnpm build:static   # 静态模式产物（如需公网部署）
git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z
```
