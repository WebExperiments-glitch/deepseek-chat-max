# chat-demo

[English](README.md) | 简体中文

本地优先的 DeepSeek 聊天应用。仅监听本机的 Node 服务把会话、附件和长期记忆存进 SQLite；浏览器仍直接请求配置的 API 服务。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
pnpm install
pnpm dev:server   # 终端 1：SQLite 服务，127.0.0.1:8787
pnpm dev          # 终端 2：页面，http://localhost:8090
```

打开 http://localhost:8090 。

生产模式由同一个本地服务托管页面与 API：

```sh
pnpm build
pnpm start
```

打开 http://127.0.0.1:8787 。数据库会自动创建在 `data/chat-demo.db`，`data/` 已加入 `.gitignore`。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据

API Key 和设置保存在浏览器 localStorage；会话、附件原件和长期记忆由本机 Node 服务写入 SQLite。服务只绑定 `127.0.0.1`，不暴露鉴权入口。首次启动会把旧的 IndexedDB / sql.js 数据迁移进 SQLite，旧库保留作为回滚点。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令              | 用途                          |
| ----------------- | ----------------------------- |
| `pnpm dev`        | 启动 Rspack 页面开发服务器    |
| `pnpm dev:server` | 启动 127.0.0.1:8787 SQLite 服务 |
| `pnpm build`      | 构建到 `dist/`                |
| `pnpm start`      | 托管 `dist/` 与 API（8787）   |
| `pnpm type`       | TypeScript 类型检查           |
| `pnpm lint`       | oxlint 检查                   |
| `pnpm test`       | Vitest 单元测试（纯逻辑与协议解析，无需 API Key） |
| `pnpm test:watch` | 监听模式运行单元测试          |
| `pnpm test:server`| 运行 SQLite 数据层测试        |
| `pnpm format`     | oxfmt 格式化                  |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
