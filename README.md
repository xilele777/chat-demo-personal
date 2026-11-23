# chat-demo-personal

支持接入自定义 API 的网页对话工具。使用自己的模型服务，在浏览器里提问、阅读资料和讨论代码；历史可以保存在本地，也可以通过 Cloudflare 在手机和电脑之间同步。

简体中文 | [English](README.en.md) · [Cloudflare 部署指南](DEPLOY.cloudflare.zh-CN.md)

## 功能

- **对话与追问**：流式显示回答，随时停止生成；编辑问题、重新生成回答，并在消息分支间切换。
- **历史管理**：自动生成标题，支持手动重命名、置顶和删除，置顶对话集中显示在列表顶部。
- **图片与文件**：上传、粘贴或拖入图片及文本/代码附件；图片可在当前页面预览、下载原图。
- **联网搜索**：开启后可查看搜索过程、来源和引用。OpenAI 兼容模式由模型结合对话上下文决定是否搜索。
- **思考强度**：支持的 OpenAI 兼容模型可选择默认或其他思考档位，展示接口实际返回的思考内容。
- **内容阅读**：支持 Markdown、代码高亮、数学公式和 Mermaid 图表。
- **跨设备使用**：云端模式同步对话、消息分支、置顶状态和附件原件；最近会话缓存与预加载减少切换等待。
- **界面与备份**：中英文、浅色/深色主题、移动端布局，以及 ZIP 历史导入导出。

搜索、思考、图片和语音的可用范围取决于接入的模型、协议及服务配置。

## 两种使用方式

|            | 个人云端模式                                   | 纯前端模式                         |
| ---------- | ---------------------------------------------- | ---------------------------------- |
| 适合       | 手机、电脑之间继续同一段对话                   | 在一个浏览器里使用，或部署静态网页 |
| 接口接入   | OpenAI / Anthropic 兼容接口、DeepSeek 扩展接口 | 原项目的 DeepSeek 兼容扩展接口     |
| 历史与附件 | Cloudflare D1 / R2，跨设备同步                 | 当前浏览器的 IndexedDB             |
| API Key    | 保存在 Worker Secret 中                        | 在设置中填写，保存在当前浏览器     |
| 访问方式   | 一个访问密码，各设备分别登录                   | 打开页面后填写 API Key             |
| 部署       | Cloudflare Workers + D1 + R2                   | 静态服务器或本地 HTML 文件         |

云端模式面向个人使用，使用一个共享访问密码，没有注册和多用户管理。

## 接入自己的 API

云端模式在部署配置中指定接口地址、协议和模型，API Key 单独保存为 Secret。

| 协议               | 可用能力                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| **OpenAI 兼容**    | Chat Completions 流式对话、图片、文本/代码附件；思考强度和思考内容取决于模型，按需联网搜索需要函数调用支持 |
| **Anthropic 兼容** | Messages 流式对话、图片、文本/代码附件；可配置发送问题前的联网搜索                                         |
| **DeepSeek 扩展**  | 原项目的搜索、链接阅读、文件和语音能力，需要上游支持对应扩展接口                                           |

OpenAI / Anthropic 兼容模式可以配置 [Tavily](https://tavily.com/) 提供联网搜索。OpenAI 模式开启搜索后，模型可以直接回答，也可以先查找资料再回答；搜索过程和来源随历史保存。

标准兼容模式支持 PNG、JPEG、GIF、WebP，以及不超过 2 MiB 的文本/代码附件。PDF、Office 和电子书尚未接入解析服务。语音输入与回复朗读需要 DeepSeek 扩展接口支持。切换服务商后，已有附件可能需要重新添加。

具体参数、模型兼容范围和密钥设置见[部署指南](DEPLOY.cloudflare.zh-CN.md#2-选择上游协议)。

## 快速开始

需要 Node.js 22.12+（建议 24）和 pnpm。

```sh
git clone https://github.com/xilele777/chat-demo-personal.git
cd chat-demo-personal
pnpm install
```

### 本地运行云端模式

复制配置文件：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

在 `.dev.vars` 中设置至少 12 字符的 `APP_PASSWORD` 和模型服务的 `UPSTREAM_API_KEY`；在 [wrangler.jsonc](wrangler.jsonc) 中填写 `UPSTREAM_PROTOCOL`、`UPSTREAM_BASE_URL` 和 `UPSTREAM_MODEL`。

```sh
pnpm db:local
pnpm dev:cloud
```

打开 <http://127.0.0.1:8787>，输入访问密码即可使用。本地开发使用本地数据库和附件存储。

部署到自己的 Cloudflare 账号时，先替换 `wrangler.jsonc` 中的账号、数据库、存储桶和上游配置，再创建资源、设置 Secrets 并发布。完整步骤见 [Cloudflare 部署指南](DEPLOY.cloudflare.zh-CN.md)。模型请求、联网搜索和云端存储按各服务的实际用量及套餐计费。

### 本地运行纯前端模式

```sh
pnpm dev
```

打开 <http://localhost:8090>，在设置中填写 API Key。此模式默认直连 DeepSeek；自定义 API 地址需修改 [rspack.config.ts](rspack.config.ts)，上游仍需兼容原项目的扩展接口。

```sh
pnpm build
```

静态产物位于 `dist/`，可部署到静态服务器。也可以直接打开 `dist/index.html`，但浏览器和 API 服务需要允许 `file://` 页面的存储与跨域请求。

## 历史与数据

**云端同步**：会话保存在 D1，附件原件保存在 R2。回答开始和结束，以及编辑、删除时保存；返回页面或窗口聚焦时同步，页面可见时每 15 秒检查更新。正在生成的文字只在发起设备实时显示，其他设备读取已保存的内容。修改冲突时，可以重试或保留本机副本后同步。

最近会话的本地缓存用于减少加载等待，启动仍需要联网。草稿、主题、语言和界面偏好保存在各设备。云端单个会话的 JSON 上限为 1.5 MB，较长对话可以备份后另开新会话。

**本地存储**：纯前端模式将 API Key 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB。数据按浏览器和站点地址隔离，换浏览器或域名需要迁移历史。

**数据发送**：发送消息、附件和使用语音时，相关内容会提交给配置的 API 服务；云端联网搜索的搜索词还会提交给 Tavily。

**备份与迁移**：在“设置 → 数据管理”中导入导出 ZIP。导出包含会话及可用的图片原件，不包含 API Key、设置或非图片附件原件。导入在确认并校验成功后，会替换当前模式的全部历史：云端模式替换云端历史，纯前端模式替换本地历史。导入前请先备份。旧站点迁移见[迁移指南](DEPLOY.cloudflare.zh-CN.md#6-从原项目迁移历史)，归档格式见[历史导入导出说明](src/services/chat/history/README.md)。

删除云端会话不会立即清理 R2 附件，也不会删除已上传到模型服务的文件；当前没有自动附件清理功能。

## 开发

| 命令                              | 用途                                                     |
| --------------------------------- | -------------------------------------------------------- |
| `pnpm dev` / `pnpm dev:cloud`     | 启动纯前端 / 本地云端版本                                |
| `pnpm build` / `pnpm build:cloud` | 构建对应版本到 `dist/`                                   |
| `pnpm type` / `pnpm type:worker`  | 前端 / Worker 类型检查                                   |
| `pnpm lint`                       | 代码检查                                                 |
| `pnpm test:context`               | 检查上下文预算与历史来源保留                             |
| `pnpm test:cloud`                 | 使用本地 D1/R2 和模拟 API 执行集成测试，需先构建云端版本 |
| `pnpm deploy:cloud`               | 构建并部署到已配置的 Cloudflare 账号                     |

前端使用 React + TypeScript，云端使用 Cloudflare Workers、D1 和 R2。`src/` 包含页面、会话和附件逻辑，`worker/` 包含认证、同步、模型适配和搜索，`migrations/` 包含数据库迁移。

## 来源与许可证

本项目基于 [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo) 独立维护，增加个人云端部署、自定义 API 接入和对话体验改进。采用 [MIT 许可证](LICENSE)，分发时请保留许可证；第三方依赖遵循各自的许可证。
