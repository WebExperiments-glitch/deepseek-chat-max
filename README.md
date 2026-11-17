# chat-demo

English | [简体中文](README.zh-CN.md)

A local-first chat app powered by the DeepSeek API. A loopback-only Node service stores conversations, attachments, and long-term memory in SQLite; the browser talks to the configured API service directly.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
pnpm install
pnpm dev:server   # terminal 1: SQLite API on 127.0.0.1:8787
pnpm dev          # terminal 2: UI on http://localhost:8090
```

Open http://localhost:8090.

For a production build served by the same local service:

```sh
pnpm build
pnpm start
```

Open http://127.0.0.1:8787. The SQLite database is created automatically at `data/chat-demo.db`; the `data/` directory is ignored by git.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

Your API key and settings are stored in the browser's localStorage. Conversations, original attachments, and long-term memory are stored in SQLite by the local Node service. The service binds `127.0.0.1` only and does not expose an authentication surface. Existing IndexedDB or sql.js data is migrated into SQLite on first launch; the old stores are kept as a rollback point.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Development

| Command          | Description                              |
| ---------------- | ---------------------------------------- |
| `pnpm dev`       | Start the Rspack UI dev server           |
| `pnpm dev:server`| Start the SQLite API on 127.0.0.1:8787   |
| `pnpm build`     | Build into `dist/`                       |
| `pnpm start`     | Serve `dist/` and the API on 8787        |
| `pnpm type`      | Run TypeScript type checks               |
| `pnpm lint`      | Lint with oxlint                         |
| `pnpm test:server` | Run SQLite data-layer tests            |
| `pnpm format`    | Format with oxfmt                        |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
