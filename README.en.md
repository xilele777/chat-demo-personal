# chat-demo-personal

A web chat tool that connects to your own API. Use your preferred model service for questions, reading documents, and discussing code. Keep history in your browser, or deploy to Cloudflare to share conversations and attachments across your phone and computer.

[简体中文](README.md) | English · [Cloudflare deployment guide (Chinese)](DEPLOY.cloudflare.zh-CN.md)

## Features

- Streaming replies with a stop button; edit questions, regenerate answers, and switch between message branches.
- Automatic conversation titles, manual renaming, pinning, and deletion.
- Search titles and message text from the sidebar icon or Ctrl/Cmd+K; results reveal and focus messages in any branch.
- Text drafts survive refresh and reopening on the same device; cloud and local drafts are separate.
- Switch models beside Web search in the composer; discover available IDs or add them in Settings. Conversation token totals appear centered below the composer, alongside input, output, cache and reasoning statistics.
- Remote MCP connections in Settings: Streamable HTTP, optional Bearer tokens or OAuth browser sign-in (including official Notion MCP), automatic cloud token refresh, tool selection, connection testing, and approval before non-read tool calls. Available with OpenAI- and Anthropic-compatible providers.
- Upload, paste, or drag in images and text/code files; preview images in the page and download originals.
- Optional web search with visible progress, sources, and citations. In OpenAI-compatible mode, the model decides whether to search based on the conversation.
- Configurable reasoning effort for supported models; display reasoning text actually returned by the API.
- Markdown, code highlighting, math, and Mermaid diagrams; light/dark themes, Chinese/English, and mobile layouts.
- Cloud sync for conversations, branches, pins, and original attachments; recent conversation caching and preloading.
- ZIP history backups and migration from local history to cloud storage.

Search, reasoning, images, and speech depend on the configured provider and protocol.

## Choose a mode

|                         | Personal cloud mode                                             | Static mode                             |
| ----------------------- | --------------------------------------------------------------- | --------------------------------------- |
| API                     | OpenAI-compatible, Anthropic-compatible, or DeepSeek extensions | Original DeepSeek-compatible extensions |
| History and attachments | Cloudflare D1 / R2, shared across devices                       | IndexedDB in the current browser        |
| API key                 | Worker Secret                                                   | Browser settings and localStorage       |
| Access                  | One shared password, separate login on each device              | Open the page and enter an API key      |
| Hosting                 | Cloudflare Workers + D1 + R2                                    | Static server or local HTML file        |

Cloud mode is for personal use with a single access password and no registration or multi-user management.

## Connect an API

Cloud mode configures the protocol, base URL, and model in `wrangler.jsonc`, with the API key stored separately as a Secret.

- **OpenAI-compatible:** streaming Chat Completions, images, and text/code attachments. Reasoning features depend on the model; model-directed search requires function calling.
- **Anthropic-compatible:** streaming Messages, images, and text/code attachments, with optional search before generating an answer.
- **DeepSeek extensions:** the original search, link reading, file, and speech features, where supported by the upstream service.

OpenAI / Anthropic modes can use [Tavily](https://tavily.com/) for web search. Standard modes support PNG, JPEG, GIF, WebP, and text/code attachments up to 2 MiB. PDF, Office, and ebook parsing are not implemented. Speech requires the DeepSeek extension APIs. Attachments may need to be added again after switching providers.

See the [deployment guide](DEPLOY.cloudflare.zh-CN.md) for configuration and compatibility details.

## Getting started

Install Node.js 22.12+ (24 recommended) and pnpm:

```sh
git clone https://github.com/xilele777/chat-demo-personal.git
cd chat-demo-personal
pnpm install
```

### Run cloud mode locally

Copy `.dev.vars.example` to `.dev.vars`. Set `APP_PASSWORD` to at least 12 characters and provide your `UPSTREAM_API_KEY`. Configure `UPSTREAM_PROTOCOL`, `UPSTREAM_BASE_URL`, and `UPSTREAM_MODEL` in [wrangler.jsonc](wrangler.jsonc).

```sh
pnpm db:local
pnpm dev:cloud
```

Open <http://127.0.0.1:8787> and enter your access password. Development uses local database and attachment storage.

To deploy to your own Cloudflare account, replace the account, database, bucket, and upstream configuration, create the resources, and set the Secrets following the [deployment guide (Chinese)](DEPLOY.cloudflare.zh-CN.md). Model requests, search, and hosting are billed by the respective providers.

### Run static mode

```sh
pnpm dev
```

Open <http://localhost:8090> and enter an API key in Settings. Static mode connects to DeepSeek by default. Customize the API origin in [rspack.config.ts](rspack.config.ts); the provider must support the original extension APIs.

`pnpm build` writes the static site to `dist/`. Deploy it to a static server, or open `dist/index.html` directly if your browser and API provider allow storage and cross-origin requests from `file://` pages.

## History and data

Cloud mode stores conversations in D1 and original attachments in R2. It saves at generation start/end and on edits/deletion, and checks for updates on page return, window focus, and every 15 seconds while visible. Live generation appears on the originating device; other devices see saved snapshots. Conflicts can be retried or resolved by keeping the local changes as a separate conversation.

Recent conversation caching reduces loading time; startup still requires a network connection. Drafts and interface preferences remain per-device. Each cloud conversation has a 1.5 MB JSON limit.

Static mode stores API keys/settings in localStorage and conversations/original attachments in IndexedDB, isolated by browser profile and site origin. Messages, attachments, and speech content are sent to the configured API service when used. Cloud web search also sends search queries to Tavily.

History export in Settings includes conversations and available original images, excluding API keys, settings, and original non-image attachments. A confirmed, validated import replaces **all history in the current mode**, including cloud history in cloud mode. Back up first. See the [archive documentation (Chinese)](src/services/chat/history/README.md).

Deleting cloud conversations does not immediately remove R2 attachments or files already uploaded to the model provider. Automatic attachment cleanup is not implemented.

## Development

| Command                           | Purpose                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm dev` / `pnpm dev:cloud`     | Run static / local cloud mode                                                 |
| `pnpm build` / `pnpm build:cloud` | Build the corresponding mode into `dist/`                                     |
| `pnpm type` / `pnpm type:worker`  | Check frontend / Worker types                                                 |
| `pnpm lint`                       | Lint code                                                                     |
| `pnpm test:context`               | Check context budgets and retained historical sources                         |
| `pnpm test:cloud`                 | Run integration checks with local D1/R2 and mock APIs; build cloud mode first |
| `pnpm deploy:cloud`               | Build and deploy to the configured Cloudflare account                         |

The frontend uses React and TypeScript. The cloud backend uses Cloudflare Workers, D1, and R2. UI and conversation logic live in `src/`, cloud adapters and storage in `worker/`, and database migrations in `migrations/`.

## Credits and license

Independently maintained from [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo), with personal cloud deployment, custom API support, and chat experience improvements. Licensed under [MIT](LICENSE); retain the license when distributing the app. Third-party dependencies have their own licenses.
