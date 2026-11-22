<!--
标题格式：type(scope): 一句话（≤ 72 字）
  type  ∈ feat | fix | docs | test | chore | refactor | perf | ci
  scope ∈ api | chat | ui | memory | search | speech | build | ci | docs | db
⚠ 标题会成为 squash 之后的 commit message 首行，永久留在 main 上。
正文只写读者从 diff 里看不出来的：为什么这么改、放弃了哪些方案、怎么验证的。
-->

## 为什么

<!-- 现象 / 痛点 / 复现路径，别写"优化一下"。 -->

## 改了什么

<!-- 与 diff 对应的分点。动了请求构造 / 鉴权 / 数据层的必须单独点名。 -->

## 怎么验证的

<!-- 贴命令与结果。CI 会重跑，但 reviewer 要先看到你自己的判断。 -->

```bash
pnpm type && pnpm lint && pnpm test && pnpm test:server && pnpm build
# →
```

## 类型

- [ ] 用户可见功能 / UI
- [ ] 后端 / API / 服务端安全
- [ ] 数据层 / 静态模式 / 浏览器存储
- [ ] 测试 / CI / 工具
- [ ] 文档
- [ ] 安全修复

## 自检（缺一不可）

- [ ] `node scripts/review-gate.mjs` 通过
- [ ] 本地 pre-push 全绿（若已 `git config core.hooksPath .githooks`）
- [ ] CI 的 `check` 和 `audit` 都通过（分支保护会强制）
- [ ] 没有提交任何密钥：API Key / token / 私钥 / 带密码的连接串
- [ ] 改请求构造的，跑过 `prefixStability.test.ts` 且是绿灯
- [ ] 改行为的，README（中英）/ NOTICE 已同步
- [ ] 静态模式相关改动，验证过 `pnpm build:static` 与 ZIP 备份

## 风险与回滚

- 影响范围：
- 回滚方式：<!-- revert 这个 commit 够不够？有没有已执行、退不回的迁移？ -->
- 需要人工验证的点：

## 关联

<!-- Closes #NN / Refs #NN -->
