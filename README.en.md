# chat-demo-personal

A web chat tool that connects to your own API. Use your preferred model service for questions, reading documents, and discussing code. Keep history in your browser, or deploy to Cloudflare to share conversations and attachments across your phone and computer.

[简体中文](README.md) | English · [Cloudflare deployment guide (Chinese)](docs/deployment.zh-CN.md)

## Features

- Streaming replies with a stop button; edit questions, regenerate answers, and switch between message branches.
- Response and stream progress deadlines end stalled generation. Standard cloud model replies show retained/omitted history ranges and estimated budgets. Tool status is saved independently; server dispatch/completion records support recovery without replaying writes with unknown outcomes.
- Standard cloud replies retain bounded, source-bound quotes from omitted branch history. Edits and version changes trigger source verification, and backups preserve the records. No extra summary model calls are made; missing facts require original messages or read verification.
- Automatic conversation titles, manual renaming, pinning, and deletion.
- Search titles and message text from the sidebar icon or Ctrl/Cmd+K; results reveal and focus messages in any branch.
- Text drafts survive refresh and reopening on the same device; cloud and local drafts are separate.
- Switch models beside Web search in the composer; discover available IDs or add them in Settings. Below the composer, click conversation token totals and cache hit rate to expand input, output, cache reads/writes, reasoning and reported-answer counts. Missing metrics are marked as not reported.
- Remote MCP connections in Settings: Streamable HTTP, optional Bearer tokens or OAuth browser sign-in (including official Notion MCP), automatic cloud token refresh, tool selection and connection testing. Every tool requires approval by default; explicitly trusted reads may run automatically. Configuration changes prevent old requests from dispatching more calls. Available with OpenAI- and Anthropic-compatible providers.
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

OpenAI / Anthropic modes can use [Tavily](https://tavily.com/) for web search. Standard modes support PNG, JPEG, GIF and WebP images up to 8 MiB, and text/code attachments up to 2 MiB. PDF, Office, and ebook parsing are not implemented. Speech requires the DeepSeek extension APIs. Attachments may need to be added again after switching providers.

Cloud mode uses `MODEL_PROFILES` to configure each model's context window, input/output budgets, images, tools and reasoning efforts. Settings follow the selected model and clearly show unknown windows. Unconfigured additional models use text mode with smaller budgets. See the [deployment guide](docs/deployment.zh-CN.md#模型切换思考与-mcp). ZIP imports stage individual conversations before an atomic replacement; failed or oversized imports preserve existing history. The deployment guide records capacity and recovery limits.

See the [deployment guide](docs/deployment.zh-CN.md) for configuration and compatibility details.

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

To deploy to your own Cloudflare account, replace the account, database, bucket, and upstream configuration, create the resources, and set the Secrets following the [deployment guide (Chinese)](docs/deployment.zh-CN.md). Model requests, search, and hosting are billed by the respective providers.

### Run static mode

```sh
pnpm dev
```

Open <http://localhost:8090> and enter an API key in Settings. Static mode connects to DeepSeek by default. Customize the API origin in [rspack.config.ts](rspack.config.ts); the provider must support the original extension APIs.

`pnpm build` writes the static site to `dist/`. Deploy it to a static server, or open `dist/index.html` directly if your browser and API provider allow storage and cross-origin requests from `file://` pages.

## History and data

Cloud mode stores conversations in D1 and original attachments in R2. It saves at generation start/end and on edits/deletion, and checks for updates on page return, window focus, and every 15 seconds while visible. Live generation appears on the originating device; other devices see saved snapshots. Conflicts can be retried or resolved by keeping the local changes as a separate conversation.

Recent conversation caching reduces loading time; startup still requires a network connection. Drafts and interface preferences remain per-device. Each cloud conversation has a 1.5 MB JSON limit.

Each page stores its own pending snapshot. Saving or deleting in one page preserves other pages’ unsynced edits. On reopening, competing snapshots and edits from a deleted conversation or replaced history recover as separate local copies. A successful copy save removes only its matching source snapshot. Concurrent edits are not automatically merged; refresh open pages to use this version.

Static mode stores API keys/settings in localStorage and conversations/original attachments in IndexedDB, isolated by browser profile and site origin. Messages, attachments, and speech content are sent to the configured API service when used. Cloud web search also sends search queries to Tavily.

History export in Settings preserves all message branches and their selections, citations and sources, MCP activity, model metadata, processing durations, token breakdowns, and available image and non-image originals. Shared originals are stored once; missing originals are declared. API keys, settings and MCP connection credentials are excluded. Import accepts this app’s new snapshots and legacy DeepSeek v3 ZIPs. A confirmed, validated import replaces **all history in the current mode**. Back up first. See the [archive documentation (Chinese)](src/services/chat/history/README.md).

Deleting cloud conversations does not immediately remove R2 attachments or files already uploaded to the model provider. Automatic attachment cleanup is not implemented.

New snapshots require this version or newer and cannot be imported into the original DeepSeek site. Restore clears provider upload handles, cloud revisions and stale tool approvals; unfinished tools are marked as having an unknown outcome. Legacy ZIPs retain their original data limitations.

## Development

`pnpm test` runs the context, agent, research, protocol, and reliability regressions. After `pnpm build:cloud`, run `pnpm test:cloud-ui` to start isolated local D1/R2 and mock APIs and run all desktop, mobile, and concurrency checks. CI uses the same workflow. Browser checks default to Edge on Windows and Chromium on Linux/CI; install Chromium with `pnpm exec playwright install --with-deps chromium` first.

| Command                           | Purpose                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm dev` / `pnpm dev:cloud`     | Run static / local cloud mode                                                 |
| `pnpm build` / `pnpm build:cloud` | Build the corresponding mode into `dist/`                                     |
| `pnpm type` / `pnpm type:worker`  | Check frontend / Worker types                                                 |
| `pnpm lint`                       | Lint code                                                                     |
| `pnpm test:context`               | Check context budgets and retained historical sources                         |
| `pnpm test:cloud`                 | Run integration checks with local D1/R2 and mock APIs; build cloud mode first |
| `pnpm deploy:cloud`               | Build, apply remote database migrations, and deploy to Cloudflare             |

The frontend uses React and TypeScript. The cloud backend uses Cloudflare Workers, D1, and R2. UI and conversation logic live in `src/`, cloud adapters and storage in `worker/`, and database migrations in `migrations/`.

## Credits and license

Independently maintained from [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo), with personal cloud deployment, custom API support, and chat experience improvements. Licensed under [MIT](LICENSE); retain the license when distributing the app. Third-party dependencies have their own licenses.


This batch adds expiring MCP metadata with selected-service connections, paged history and bounded search, staged atomic imports, cross-tab coordination, recovery object pins and manual cleanup previews. New checks: `test:mcp-cache`, `test:object-lifecycle`, `test:capacity`, `test:coordination-ui`, and `test:disaster-recovery`. See the deployment guide for capacity limits and the full local D1/R2 restore drill; these do not certify production limits.
