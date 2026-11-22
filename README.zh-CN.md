# deepseek-chat-max

[English](README.md) | 简体中文

> 本地优先、极致可插拔的 DeepSeek 聊天客户端 —— 官方 `deepseek-ai/chat-demo` 的社区增强衍生版。
> 会话、附件、长期记忆全部存本机 SQLite；API Key 只存浏览器；服务只绑定 `127.0.0.1`，你的数据不出本机。

一个把「功能当插件」来做的聊天客户端：模型供应商、模型选择、联网搜索、语音、OCR 各自独立可选；核心层用纯 TypeScript + 端口/适配器架构，与 UI、平台、框架彻底解耦，为将来移植到 iOS / 原生容器留好了接缝。

---

## 目录

- [和官方 demo 的区别](#和官方-demo-的区别)
- [快速开始](#快速开始)
- [功能一览](#功能一览)
- [可插拔架构](#可插拔架构)
- [错误码与人话提示](#错误码与人话提示)
- [数据、隐私与安全](#数据隐私与安全)
- [项目结构](#项目结构)
- [开发指南](#开发指南)
- [质量门禁](#质量门禁)
- [许可与致谢](#许可与致谢)

---

## 和官方 demo 的区别

本项目源自 `deepseek-ai/chat-demo`（MIT），在其上做了大量增强，是一个**超集**而非替代品：

| 维度 | 官方 demo | 本项目 |
| --- | --- | --- |
| 供应商 | DeepSeek 单一 | 84 个供应商（清单由 models.dev 生成），每项独立下拉可选 |
| 数据存储 | 浏览器本地 | 本机 SQLite（loopback 服务），支持历史 ZIP 导入导出、627MB 级归档加速导入 |
| 模型选择 | 固定/简单 | 独立「模型」设置页，电商式筛选（价格/上下文/能力/模态），复制 OpenCode 的选择交互 |
| 联网搜索 | 仅 DeepSeek 服务端工具 | 5 家可插拔（DeepSeek 工具/API、Tavily、Serper、Brave），第三方走本地代理 |
| 语音 | DeepSeek 内置 | 引擎注册表（ASR/TTS 可插拔），动态音色与采样率 |
| 图片/文档 | 上传即发 | 能力检测：模型不支持图片时自动 OCR 转文字再喂给模型；不支持视频则拒绝发送 |
| OCR | 无 | 可插拔 OCR 引擎（内置 DeepSeek OCR，可接第三方） |
| 错误处理 | 原始英文报错 | 机器码归机器、人话归 UI：稳定 code + 中文安抚文案 + 自动重试闸门 |
| 架构 | 常规前端 | ports/adapters 分层，核心纯 TS，可移植 |
| 开源 | MIT | MIT（保留上游版权声明与 NOTICE） |

风格层严格对齐官方：品牌蓝 `#3964fe`、微蓝灰中性色、发丝边框、三层 token、胶囊形状、状态机文案。详见 [_research/DS风格审查报告.md](_research/DS风格审查报告.md)（如该目录未随仓库分发，以 `NOTICE` 与源码为准）。

## 快速开始

需要 **Node.js 22.12+** 与 **pnpm**。

```sh
pnpm install
```

**开发模式**（两个终端）：

```sh
pnpm dev:server   # 终端 1：SQLite 服务，监听 127.0.0.1:8787
pnpm dev          # 终端 2：Rspack 页面，http://localhost:8090
```

打开 <http://localhost:8090>。

**生产模式**（同一个本地服务同时托管页面与 API）：

```sh
pnpm build
pnpm start
```

打开 <http://127.0.0.1:8787>。数据库自动创建于 `data/chat-demo.db`，`data/` 已加入 `.gitignore`，不会进版本库。

首次启动会检测旧的 IndexedDB / sql.js 数据并自动迁移到 SQLite，旧库保留作为回滚点。

## 功能一览

**对话**
- 多会话、自动标题、重命名、文件夹归档、置顶；编辑提问、重新生成、消息分支切换
- 流式输出、深度思考（可折叠过程时间线）、继续生成、停止生成
- 联网搜索与来源引用、链接阅读、`latest_reminder`
- Markdown + 语法高亮 + KaTeX 公式 + Mermaid 图表；HTML 代码块「运行/实时预览」沙箱

**附件与多模态**
- 上传、粘贴、拖拽附件；图片、文档、音频、视频（视频需模型声明支持）
- 能力驱动投递：模型支持 → 原生多模态块；不支持图片/文档 → 自动 OCR 转文字；不支持视频 → 拒绝发送并给中文提示
- 语音输入（实时频谱）与回复朗读，各自可换引擎

**可插拔**
- 84 个供应商独立可选；OpenCode 免费网关（协议级实现，无 agent 框架）
- 模型选择器：价格/上下文/模态/能力筛选，最近使用，收藏与对比
- 搜索、语音、OCR 均为注册表 + 下拉选择；第三方搜索/OCR 经本地代理转发绕开 CORS

**体验**
- 简体中文 / English，浅色 / 深色主题（同一套 token，无闪色）
- 桌面与移动端独立布局，移动端输入框吸底 + safe-area
- 完整的无障碍：aria-pressed / role=alert|status / focus-visible / prefers-reduced-motion
- 错误提示按归因给中文安抚文案与修复动作（整理历史 / 换模型 / 检查 Key / 充值 / 减小文件）

## 可插拔架构

核心设计目标：**每个能力像插件一样独立可选，核心层与 UI / 平台 / 框架完全解耦**。

```
src/
  ports/      纯接口层（零依赖）：Http / Platform / KeyValueStore / Clock / Notify / PageLifecycle
  services/   领域逻辑（算法、协议、编排，不 import UI/平台实现）
  stores/     所有 zustand store（物理归位，统一状态层）
  adapters/   平台实现（Web 端 notify 桥接等；iOS 只需换这一层）
  app/        组装根（composition root）：注入适配器、同步主题与语言
  components/ React UI（唯一允许保留 DOM/框架依赖的层）
  i18n/       中英文案
```

**端口与适配器**
- `ports/http.ts`：可注入的 fetch（默认浏览器 fetch），iOS 侧 `setHttp(URLSession 实现)` 即可，服务层零改动
- `ports/platform.ts`：DOM/window/navigator/Blob URL/base64/AudioContext/麦克风/动画帧/生命周期的唯一边界
- `NotifyPort` / `setMemoryNotifier`：核心层不再反向依赖 UI 的 toast 组件

**能力注册表 `services/capabilities.ts`**
借鉴 DSH 的「可逆注册」，但用轻量纯 TS 实现（不引入 agent 框架）：
- 定义（端口）→ 实现（provider）→ 消费者（只经注册表按 id 取）三角色分离
- 每次注册返回 disposer，切换时先释放旧实现、逆序回滚、幂等
- 用户偏好只存 id + 最小 override

**模型能力数据化**
- `Provider.capabilities`（deepseekTools / files / voice / title）替代 `id === 'deepseek'` 硬编码
- `modelCapabilities.ts`：`createCapabilities` / `attachmentModality` / `planDelivery` 纯函数决定附件 native / OCR / reject

## 错误码与人话提示

遵循 Microsoft Graph / RFC 9457 的约定：**机器码归机器、人话归 UI**。

- `services/api/problem.ts`：14 个稳定机器码 + 5 类归因（content / account / crowded / ours / connection），穷尽映射，原始服务端报错只作诊断，**绝不展示给用户**
- `services/chat/describe.ts`：按 code 投影中文安抚文案 + 修复动作，`Record<ApiProblemCode, …>` 保证每个码都有文案（新增码漏配会编译失败）
- 闸门：限流/繁忙/超时/连接抖动 → 后台指数退避自动重试 2 次；账户/内容/参数类绝不重试
- 31 个专项测试锁定「不泄露原始英文 / 每个码有归因 / 动作正确 / 重试闸门」

例如那条让人困惑的超长报错，现在显示：

> 这段对话有点长了，我先帮您收一下。您写的内容和历史都还在，没有丢。
> `[整理历史] [换个模型] [新开对话]`

## 数据、隐私与安全

- **API Key / 设置**：浏览器 localStorage，不上传、不随代码分发
- **会话 / 附件原件 / 长期记忆 / 分享**：本机 SQLite（`data/chat-demo.db`）
- **服务只绑定 127.0.0.1**，无鉴权入口；第三方搜索 / OCR 经本地代理转发，Key 单独存
- **历史导入导出**：ZIP 格式；导入在确认并校验成功后替换全部本地会话与附件；导出含会话与本地可用图片原件，不含 Key、设置与非图片附件原件（格式见 `src/services/chat/history/README.md`）
- **删除所有对话**：确认后清空会话、附件原件与草稿，Key 与设置保留，已上传到 API 服务的文件不受影响
- 项目不内置任何用户数据或 Key

## 项目结构

```
.
├── src/
│   ├── app/           布局、主题（theme.css）、组装根、全局样式
│   ├── adapters/web/  Web 平台适配器
│   ├── ports/         纯接口 + 可注入实现（http / platform 等）
│   ├── stores/        zustand 状态层（13 个 store + 门面）
│   ├── services/      领域逻辑
│   │   ├── api/       API 客户端、SSE、协议类型、problem 机器码层、供应商目录
│   │   ├── chat/      会话、分支、压缩、附件、历史归档、分享、错误文案投影
│   │   ├── memory/    长期记忆
│   │   ├── speech/    录音与朗读
│   │   └── ...        模型目录/元数据、搜索/OCR/语音注册表等
│   ├── components/    React UI（chat / settings / markdown / sider / messages ...）
│   ├── i18n/          中英文案
│   ├── pwa/           PWA 相关
│   └── utils/         工具
├── server/            本机 SQLite API 服务 + 通用供应商代理
├── crates/
│   └── crc32-wasm/    Rust/WASM CRC32 + DEFLATE 加速（可选，失败降级纯 JS）
├── scripts/           构建、WASM 构建/校验、归档导入校验等
├── _research/         设计与逆向调研报告（如随仓库分发）
├── rspack.config.ts   构建配置（默认 api.deepseek.com）
└── vitest.config.ts
```

## 开发指南

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动 Rspack 页面开发服务器（8090） |
| `pnpm dev:server` | 启动 127.0.0.1:8787 SQLite 服务（watch） |
| `pnpm build` | 构建到 `dist/`（含 LICENSE / NOTICE） |
| `pnpm start` | 托管 `dist/` 与 API（8787） |
| `pnpm type` | TypeScript 类型检查 |
| `pnpm lint` | oxlint 静态检查 |
| `pnpm test` | Vitest 单元测试（**35 文件 / 561 测试**，无需 API Key） |
| `pnpm test:watch` | 监听模式 |
| `pnpm test:server` | SQLite 数据层测试 |
| `pnpm format` | oxfmt 格式化 |
| `pnpm build:wasm` / `pnpm verify:wasm` | 构建 / 校验 Rust-WASM 加速模块 |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`，`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址与开发代理。

聊天默认 `deepseek-flash`，走 Anthropic 兼容的 Messages / Files API；接入其他供应商时，请求会携带搜索、链接阅读、标题与 `latest_reminder` 等扩展，服务需支持相应能力；不支持的能力由 `Provider.capabilities` 数据位关闭。

**关键开发纪律**
- 任何请求构造改动前后都要跑 `src/services/chat/prefixStability.test.ts`；红灯就修代码，绝不改断言让它通过
- 核心逻辑保持纯 TS：不要在新代码里直接 import UI 组件、`document`/`window` 或裸 `fetch`
- 新增错误码时同步补 `problem.ts` 的码与 `describe.ts` 的文案（类型系统会强制）

## 质量门禁

每次交付前全绿：

```
pnpm type    ✓
pnpm lint    ✓
pnpm test    ✓  35 files / 561 tests
pnpm build   ✓  Rspack compiled successfully
```

风格层另有 ds-demo 机械校验器与浏览器实测（暗色 token 重映射、0 控制台错误），详见 `_research/DS风格审查报告.md`。

## 许可与致谢

- 本项目以 [MIT](LICENSE) 开源，是 `deepseek-ai/chat-demo` 的衍生作品，保留上游 MIT 版权声明；完整第三方与数据来源见 [NOTICE](NOTICE)。
- 模型/供应商清单数据来自 [models.dev](https://github.com/anomalyco/models.dev)（MIT）。
- 本项目为社区衍生作品，与 DeepSeek 官方无关联，不代表官方立场。「DeepSeek」及相关标识归深度求索公司所有。
