# 安全策略

## 报告漏洞

请**不要**公开开 Issue。用 GitHub Security Advisories 的私密报告，或直接联系仓库所有者。
请给出：受影响版本/路径、复现步骤、影响面、建议修复。收到后会尽快确认。

## 支持范围

只维护最新发布版本。旧版本不单独回补安全修复。

## 本仓库的安全模型

- **本机模式默认只绑 127.0.0.1**，无鉴权入口，浏览器与数据库在同一台机器。
- **对外暴露时 fail-closed**：`HOST=0.0.0.0`/非回环地址必须设置 `AUTH_TOKEN` 才能启动，
  否则服务拒绝启动。鉴权用恒定时间比较（`timingSafeEqual`）。
- **附件下载强制 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`
  + sandbox CSP**，防止上传的 `text/html` 在同源上下文里执行（XSS 读 API Key）。
- **全局 CSP**：`default-src 'self'` 等；`connect-src` 放行 API 端点（浏览器直连模型服务需要）。
- **错误脱敏**：对外暴露时不回传原始 `error.message`（可能含端点/密钥片段）。
- **任何密钥都不进 git**：API Key 存浏览器 localStorage，不上传、不随代码分发。
- 代码预览 iframe 不开 `allow-same-origin`；Mermaid 用 `securityLevel: 'strict'`。

## 静态模式特别注意

静态构建（`pnpm build:static`）把数据存浏览器 IndexedDB，无本机服务：

- 第三方 provider 与搜索依赖本机 `/provider` 代理绕开 CORS，静态托管没有代理，这些不可用；
  只有 DeepSeek（CORS 完整）与支持 CORS 的自定义端点可用。
- 浏览器存储不是安全边界——不要在同一浏览器存敏感数据后把它当共享设备用。

## 自动化防线

- GitHub secret scanning + push protection（公开仓库免费）
- Dependabot alerts / security updates
- CodeQL（JS/TS）
- `review-gate` + pre-push + CI `audit` + 分支保护
