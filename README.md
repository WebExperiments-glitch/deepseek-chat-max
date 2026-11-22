# deepseek-chat-max

English | [简体中文](README.zh-CN.md)

> A local-first, extremely pluggable DeepSeek chat client — a community-enhanced derivative of the official `deepseek-ai/chat-demo`.
> Conversations, attachments and long-term memory all live in a local SQLite database; your API keys stay in the browser; the service binds to `127.0.0.1` only. Your data never leaves the machine.

This is a chat client built around the idea that **every capability is a plugin**: provider, model, search engine, speech engine and OCR engine are each independently selectable. The core is pure TypeScript with a ports-and-adapters architecture, fully decoupled from UI, platform and frameworks — leaving clean seams for a future iOS / native port.

---

## Contents

- [How it differs from the official demo](#how-it-differs-from-the-official-demo)
- [Quick start](#quick-start)
- [Features](#features)
- [Pluggable architecture](#pluggable-architecture)
- [Error codes and human messages](#error-codes-and-human-messages)
- [Data, privacy and security](#data-privacy-and-security)
- [Project structure](#project-structure)
- [Development](#development)
- [Quality gates](#quality-gates)
- [License and acknowledgements](#license-and-acknowledgements)

---

## How it differs from the official demo

This project starts from `deepseek-ai/chat-demo` (MIT) and adds substantial enhancements. It is a **superset**, not a replacement:

| Dimension | Official demo | This project |
| --- | --- | --- |
| Providers | DeepSeek only | 84 brands in a models.dev-generated catalog, each selectable; **full functionality only with DeepSeek** — most third-party endpoints support OpenAI-compatible text chat only |
| Storage | Browser-local | Local SQLite (loopback service), ZIP history import/export, accelerated import of 627 MB-scale archives |
| Model picker | Fixed / minimal | Dedicated Models settings page, e-commerce-style filtering (price / context / capabilities / modalities), OpenCode-style selection interactions |
| Web search | DeepSeek server tool only | 5 pluggable options (DeepSeek tool/API, Tavily, Serper, Brave); third parties routed through a local proxy |
| Speech | DeepSeek built-in | Engine registry + dynamic voices/sample rates; only one ASR/TTS implementation (DeepSeek) ships today |
| Images / documents | Upload and send | Capability detection: if the model lacks image support, content is OCR'd to text first; videos are rejected when unsupported |
| OCR | None | Images/documents converted to text when the model lacks image support; registry currently ships only DeepSeek OCR (extension point left for third parties) |
| Error handling | Raw English errors | Machine codes stay machine, human UI: stable codes + Chinese reassurance + auto-retry gates |
| Architecture | Conventional frontend | ports/adapters layering, pure TS core, portable |
| License | MIT | MIT (upstream copyright and NOTICE retained) |

The visual layer follows the official style: brand blue `#3964fe`, bluish-gray neutrals, hairline borders, three-tier tokens, capsule shapes, state-machine copy (tokens in `src/app/theme.css`).

## Known limitations (read first)

This is an **engineering-complete DeepSeek client**, not a turnkey mass-market chat app and not a "universal provider platform". Registries are extension points, not delivered capabilities:

- **Full functionality only with DeepSeek**: attachments, voice, read-aloud, OCR, auto-titles and server-side search are bound to `Provider.capabilities.deepseekTools`, true only for DeepSeek. Other providers get OpenAI-compatible text chat; leaving DeepSeek silently disables web search.
- **Catalog ≠ availability**: the 84 brands are a public models.dev list behind a local proxy. Most endpoints "work if they happen to be `/v1/chat/completions`"; Azure, Bedrock, Vertex, Ollama need dedicated auth/routing that the generator does not cover and will 404. The genuinely tuned ones are DeepSeek, OpenRouter, OpenCode Go/Zen and custom endpoints.
- **Registries are extension points**: search has 5 options (3 third parties via local proxy), but OCR and speech each ship only a DeepSeek implementation — interfaces exist, no second vendor.
- **Model-picker metadata is not a delivery guarantee**: displayed price/video capability is metadata browsing; whether an attachment can be sent depends on the current model's input modalities and whether it is DeepSeek.
- **Shares are local-only snapshots**: links live in local SQLite and only open on this machine, not a public share (UI copy reflects this).
- **Local-first and memory**: reading existing memories (local retrieval injected into context) is on by default; writing (a background `deepseek-flash` extraction after each reply — an extra paid API call) is **off** by default and must be enabled in settings. When enabled, conversation text is sent to the extraction model.
- **Not a PWA / not for static hosting**: it needs the local Node service for the SQLite API; dropping `dist/` on static hosting (e.g. GitHub Pages) yields an empty shell. The repo ships local-run instructions only; CI runs type/lint/tests/build but does not deploy a static site.

## Quick start

Requires **Node.js 22.12+** and **pnpm**.

```sh
pnpm install
```

**Development** (two terminals):

```sh
pnpm dev:server   # terminal 1: SQLite service on 127.0.0.1:8787
pnpm dev          # terminal 2: Rspack UI on http://localhost:8090
```

Open <http://localhost:8090>.

**Production** (one local service serves both the UI and the API):

```sh
pnpm build
pnpm start
```

Open <http://127.0.0.1:8787>. The database is created automatically at `data/chat-demo.db`; `data/` is gitignored.

On first launch, legacy IndexedDB / sql.js data is detected and migrated to SQLite, with the old store kept as a rollback point.

## Features

**Conversation**
- Multiple sessions, automatic titles, rename, folders, pinning; edit prompts, regenerate, switch between message branches
- Streaming replies, deep thinking (collapsible process timeline), continue/stop generation
- Web search with source citations, link reading, `latest_reminder`
- Markdown + syntax highlighting + KaTeX math + Mermaid diagrams; a sandboxed live-preview panel for HTML code blocks

**Attachments & multimodal**
- Upload, paste or drag files; images, documents, audio and video (video requires a model that declares support)
- Capability-driven delivery: supported → native multimodal block; image/document unsupported → automatic OCR-to-text; video unsupported → rejected with a clear Chinese explanation
- Voice input (live spectrum) and read-aloud, each with swappable engines

**Pluggability**
- 84 brands, independently selectable (**note**: most are OpenAI-compatible text endpoints; attachments/search/voice/auto-titles only work fully with DeepSeek); OpenCode free gateway is a protocol-level implementation, no agent framework
- Model picker: filter by price / context / modality / capability, recent use, favorites and comparison
- Search, speech and OCR are all registry + dropdown; third-party engines route through the local proxy to bypass CORS

**Experience**
- Simplified Chinese / English, light / dark themes (one token set, no flash on switch)
- Separate desktop and mobile layouts; mobile input pinned to bottom with safe-area insets
- Full accessibility: aria-pressed / role=alert|status / focus-visible / prefers-reduced-motion
- Error messages with reassuring Chinese copy and fix actions by cause (tidy history / switch model / check key / top up / shrink file)

## Pluggable architecture

Design goal: **every capability is an independently selectable plugin, and the core is fully decoupled from UI, platform and frameworks**.

```
src/
  ports/      pure interfaces (zero deps): Http / Platform / KeyValueStore / Clock / Notify / PageLifecycle
  services/   domain logic (algorithms, protocols, orchestration; no UI/platform imports)
  stores/     all zustand stores (physically relocated, unified state layer)
  adapters/   platform implementations (Web notify bridge, etc.; iOS only swaps this layer)
  app/        composition root: wires adapters, syncs theme and locale
  components/ React UI (the only layer allowed to keep DOM/framework dependencies)
  i18n/       English and Chinese copy
```

**Ports and adapters**
- `ports/http.ts`: injectable fetch (browser fetch by default); on iOS call `setHttp(URLSession impl)` — zero changes in services
- `ports/platform.ts`: the single boundary for document/window/navigator/Blob URL/base64/AudioContext/mic/animation frames/lifecycle
- `NotifyPort` / `setMemoryNotifier`: the core no longer imports the UI toast component

**Capability registry `services/capabilities.ts`**
Inspired by DSH's reversible registration, implemented in lightweight pure TS (no agent framework):
- Three roles: definition (port) → implementation (provider) → consumer (looks up by id via the registry)
- Every registration returns a disposer; switching releases the previous implementation first, reverse-order teardown, idempotent
- User preferences store only an id + minimal override

**Data-driven model capabilities**
- `Provider.capabilities` (deepseekTools / files / voice / title) replaces `id === 'deepseek'` hardcoding
- `modelCapabilities.ts`: `createCapabilities` / `attachmentModality` / `planDelivery` pure functions decide native / OCR / reject delivery

## Error codes and human messages

Following Microsoft Graph / RFC 9457 conventions: **machine codes stay machine, human copy stays in the UI**.

- `services/api/problem.ts`: 14 stable machine codes + 5 cause groups (content / account / crowded / ours / connection), exhaustive mapping; the raw server message is diagnostic-only and **never shown to users**
- `services/chat/describe.ts`: projects each code to reassuring Chinese copy + fix actions; `Record<ApiProblemCode, …>` guarantees every code has copy (a missing code fails compilation)
- Gates: rate-limit / busy / timeout / connection hiccups → 2 background exponential-backoff retries; account / content / parameter errors are never retried
- 31 dedicated tests lock down "no raw English leaks / every code has a cause / correct actions / retry gates"

For example, the confusing overflow error now reads:

> This conversation is getting long. I will tidy it up for you — your messages and history are all safe.
> `[Tidy history] [Switch model] [New chat]`

## Data, privacy and security

- **API keys / settings**: browser localStorage; never uploaded or shipped with code
- **Conversations / original attachments / long-term memory / shares**: local SQLite (`data/chat-demo.db`)
- **Service binds 127.0.0.1 only**, no auth surface; third-party search/OCR route through the local proxy with separately stored keys
- **History import/export**: ZIP format; import replaces all local conversations and attachments after confirmation and validation; export includes conversations and locally available image originals, excluding keys, settings and non-image attachment originals (format in `src/services/chat/history/README.md`)
- **Delete all chats**: clears conversations, attachment originals and drafts after confirmation; keys and settings are preserved, files already uploaded to the API service are unaffected
- No user data or keys are bundled with the project

## Project structure

```
.
├── src/
│   ├── app/           layout, theme.css, composition root, global styles
│   ├── adapters/web/  Web platform adapters
│   ├── ports/         pure interfaces + injectable impls (http / platform, ...)
│   ├── stores/        zustand state layer (13 stores + barrel)
│   ├── services/      domain logic
│   │   ├── api/       API client, SSE, protocol types, problem machine-code layer, provider catalog
│   │   ├── chat/      sessions, branches, compression, attachments, history archives, shares, error copy
│   │   ├── memory/    long-term memory
│   │   ├── speech/    recording and read-aloud
│   │   └── ...        model catalog/meta, search/OCR/speech registries, etc.
│   ├── components/    React UI (chat / settings / markdown / sider / messages ...)
│   ├── i18n/          English and Chinese copy
│   └── utils/         utilities
├── server/            local SQLite API service + generic provider proxy
├── crates/
│   └── crc32-wasm/    Rust/WASM CRC32 + DEFLATE acceleration (optional, falls back to pure JS)
├── scripts/           build, WASM build/verify, archive import verification, etc.
├── _research/         design and reverse-engineering reports (if shipped)
├── rspack.config.ts   build config (api.deepseek.com by default)
└── vitest.config.ts
```

## Development

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Rspack UI dev server (8090) |
| `pnpm dev:server` | SQLite service on 127.0.0.1:8787 (watch) |
| `pnpm build` | Build into `dist/` (includes LICENSE / NOTICE) |
| `pnpm start` | Serve `dist/` and API on 8787 |
| `pnpm type` | TypeScript type check |
| `pnpm lint` | oxlint |
| `pnpm test` | Vitest unit tests (**35 files / 561 tests**, no API key needed) |
| `pnpm test:watch` | Watch mode |
| `pnpm test:server` | SQLite data-layer tests |
| `pnpm format` | oxfmt |
| `pnpm build:wasm` / `pnpm verify:wasm` | Build / verify the Rust-WASM acceleration module |

[rspack.config.ts](rspack.config.ts) targets `https://api.deepseek.com` by default; `createConfig({ apiOrigin, devServer })` allows a custom API origin and dev proxy.

Chatting defaults to `deepseek-flash` over the Anthropic-compatible Messages / Files APIs. When connecting other providers, requests carry extensions for search, link reading, titles and `latest_reminder`; the service must support the corresponding capabilities. Unsupported ones are turned off via the `Provider.capabilities` data flags.

**Key development rules**
- Run `src/services/chat/prefixStability.test.ts` before and after any request-construction change; if it goes red, fix the code — never edit assertions to pass
- Keep core logic pure TS: don't import UI components, `document`/`window`, or bare `fetch` in new code
- When adding an error code, add both the code in `problem.ts` and the copy in `describe.ts` (the type system enforces this)

## Quality gates

Green before every delivery:

```
pnpm type    ✓
pnpm lint    ✓
pnpm test    ✓  35 files / 561 tests
pnpm build   ✓  Rspack compiled successfully
```

These gates run for real on every push in `.github/workflows/ci.yml` (including `pnpm test` and `pnpm test:server`), not just documented. The local server security tests (auth, nosniff, CSP) are part of `pnpm test:server`.

## License and acknowledgements

- MIT licensed. This project is a derivative of `deepseek-ai/chat-demo` and retains the upstream MIT copyright notice; see [NOTICE](NOTICE) for complete third-party and data-source attributions.
- Provider/model catalog data comes from [models.dev](https://github.com/anomalyco/models.dev) (MIT).
- This is a community derivative work, not affiliated with DeepSeek and not representing its views. "DeepSeek" and related marks belong to DeepSeek Inc.
