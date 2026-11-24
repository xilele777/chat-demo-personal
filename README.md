# chat-demo-personal

支持接入自定义 API 的网页对话工具。使用自己的模型服务，在浏览器里提问、阅读资料和讨论代码；历史可以保存在本地，也可以通过 Cloudflare 在手机和电脑之间同步。

简体中文 | [English](README.en.md) · [Cloudflare 部署指南](DEPLOY.cloudflare.zh-CN.md)

## 功能

- **对话与追问**：流式显示回答，随时停止生成；编辑问题、重新生成回答，并在消息分支间切换。
- **历史管理**：自动生成标题，支持重命名、置顶和删除；分组标题旁或会话菜单可进入多选，支持全选、批量置顶和删除。顶部搜索图标或 Ctrl/Cmd+K 搜索标题和消息，点击结果定位到对应消息与分支。
- **文字草稿**：按会话保存到本机，刷新或重新打开页面可恢复；已发送、已删除会话的草稿自动清除，未发送附件仅在当前页面保留。
- **模型与用量**：输入框的“联网搜索”右侧可切换当前 API 服务的模型，“设置 → 模型”可获取模型列表或手动添加模型 ID；输入框下方显示会话累计 Token 和缓存命中率，点击展开输入、输出、缓存读写、思考 Token 和已统计回答数，累计包含所有回答分支。未返回的分项显示“未返回”，不会冒充零用量。
- **MCP 连接**：在“设置 → MCP”中添加远程 Streamable HTTP 服务，支持 Bearer Token 或 OAuth 浏览器登录，可测试连接、启停服务和选择工具。OAuth 凭据保存在云端并自动刷新；支持 Notion 官方 MCP。适用于 OpenAI / Anthropic 兼容模式，读取工具直接调用，其他工具在对话中确认后执行。
- **图片与文件**：上传、粘贴或拖入图片及文本/代码附件；图片可在当前页面预览、下载原图。
- **联网搜索**：开启后可查看搜索过程、来源和引用。OpenAI 兼容模式由模型结合对话上下文决定是否搜索。
- **思考强度**：支持的 OpenAI 兼容模型可选择默认或其他思考档位，展示接口实际返回的思考内容。
- **内容阅读**：支持 Markdown、代码高亮、数学公式和 Mermaid 图表。
- **跨设备使用**：云端模式同步对话、消息分支、置顶状态和附件原件；最近会话缓存与预加载减少切换等待。
- **界面与备份**：点击左上角 Logo 或文字返回新对话；侧栏平滑收起与展开，遵循系统减少动态效果设置。支持中英文、浅色/深色主题、移动端布局，以及 ZIP 历史导入导出。

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

最近会话的本地缓存用于减少加载等待，启动仍需要联网。文字草稿、模型选择、主题、语言和界面偏好保存在各设备；本地与云端草稿分别保存。保存失败会显示受影响的会话和原因，可以直接重试；修改冲突时可保留副本后同步。云端单个会话的 JSON 上限为 1.5 MB，较长对话可以备份后另开新会话。

Token 用量以接口实际返回为准，缓存输入计入输入总数，思考 Token 已包含在输出中，不重复累加；续写会累计到原回答。未返回用量的请求不计入统计，不伪造零用量；会话累计不包含自动标题生成。MCP 配置和凭据保存在 D1，仅登录后可管理，令牌不回传到浏览器；工具参数和结果会发送给所连接的 MCP 服务与模型。当前支持远程 Streamable HTTP、可选 Bearer 认证及 OAuth 登录（PKCE S256 与动态客户端注册），暂不支持本机 stdio 与旧版 SSE。

**本地存储**：纯前端模式将 API Key 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB。数据按浏览器和站点地址隔离，换浏览器或域名需要迁移历史。

**数据发送**：发送消息、附件和使用语音时，相关内容会提交给配置的 API 服务；云端联网搜索的搜索词还会提交给 Tavily。

**备份与迁移**：在“设置 → 数据管理”中导入导出 ZIP。导出包含会话及可用的图片原件，不包含 API Key、设置或非图片附件原件。导入在确认并校验成功后，会替换当前模式的全部历史：云端模式替换云端历史，纯前端模式替换本地历史。导入前请先备份。旧站点迁移见[迁移指南](DEPLOY.cloudflare.zh-CN.md#6-从原项目迁移历史)，归档格式见[历史导入导出说明](src/services/chat/history/README.md)。

删除云端会话不会立即清理 R2 附件，也不会删除已上传到模型服务的文件；当前没有自动附件清理功能。

ZIP 是迁移归档，尚未完整恢复 MCP 调用记录、模型配置、处理时长和 Token 分项；这些限制及数据恢复的改进顺序见[内部审阅报告](REVIEW.zh-CN.md)。

## 开发

`pnpm test` 统一运行上下文、工具、研究、协议和可靠性专项回归。先运行 `pnpm build:cloud`，再运行 `pnpm test:cloud-ui`，可自动启动隔离的本地 D1/R2 与模拟 API，并完成桌面、移动端及竞态验收；此流程也用于 CI。Windows 默认使用 Edge，Linux/CI 使用 Chromium（先运行 `pnpm exec playwright install --with-deps chromium`）。

| 命令                              | 用途                                                          |
| --------------------------------- | ------------------------------------------------------------- |
| `pnpm dev` / `pnpm dev:cloud`     | 启动纯前端 / 本地云端版本                                     |
| `pnpm build` / `pnpm build:cloud` | 构建对应版本到 `dist/`                                        |
| `pnpm type` / `pnpm type:worker`  | 前端 / Worker 类型检查                                        |
| `pnpm lint`                       | 代码检查                                                      |
| `pnpm test:context`               | 检查上下文预算与历史来源保留                                  |
| `pnpm test:research`              | 检查搜索停止条件、去重、证据预算和固定提示复用                |
| `pnpm test:product`               | 检查草稿恢复、分支搜索和 Token 统计                           |
| `pnpm test:anthropic`             | 检查 Anthropic 原生思考、MCP 调用与确认流程                   |
| `pnpm test:ui`                    | 使用已安装的 Edge 验收桌面和手机界面，需先运行模拟服务        |
| `pnpm test:interactions`          | 验收欢迎页、Logo 导航、多选、批量操作和侧栏，需先运行模拟服务 |
| `pnpm test:cloud`                 | 使用本地 D1/R2 和模拟 API 执行集成测试，需先构建云端版本      |
| `pnpm deploy:cloud`               | 构建、应用远程数据库迁移并部署到 Cloudflare                   |

前端使用 React + TypeScript，云端使用 Cloudflare Workers、D1 和 R2。`src/` 包含页面、会话和附件逻辑，`worker/` 包含认证、同步、模型适配和搜索，`migrations/` 包含数据库迁移。

## 来源与许可证

本项目基于 [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo) 独立维护，增加个人云端部署、自定义 API 接入和对话体验改进。采用 [MIT 许可证](LICENSE)，分发时请保留许可证；第三方依赖遵循各自的许可证。
