# 个人版 Cloudflare 部署

此版本供一个人跨设备使用：一个访问密码登录，Workers 代理模型请求，D1 保存完整消息树和远程 MCP 配置，R2 保存附件。无需 Cloudflare Access、邮箱策略或 AUD，没有注册或多用户管理。原始纯前端模式仍可用。

## 已实现与边界

- 会话、标题、消息分支、生成结果与附件原件跨设备同步。
- 会话菜单支持“置顶 / 取消置顶”，置顶会话单独显示在列表顶部。状态随会话同步，导入导出也会保留，不修改会话的聊天时间。
- 回答开始和结束、编辑、删除时保存；返回页面及窗口聚焦时拉取，页面可见时每 15 秒检查。生成中的文字由发起设备展示，其他设备看到已保存快照，不支持跨设备停止生成。
- 两台设备修改同一旧版本时返回冲突。本机未同步快照保存在 IndexedDB；可以重试，或者“保留副本并同步”，将本机修改另存为云端新会话。
- 通过 Cloudflare Secret 设置至少 12 字符的 `APP_PASSWORD`，各设备首次输入密码后保持登录 30 天；修改密码使现有登录失效。密码只在登录时提交，登录态使用 HttpOnly Cookie，不保存在 localStorage。
- 网络恢复前不要清除浏览器站点数据。此版本启动仍需要联网验证登录状态和读取云端列表；不提供完整离线启动。
- 草稿、主题、语言和其他界面偏好仍属于各设备；上游密钥只保存在 Worker Secret。
- 一个会话的 JSON 上限为 1.5 MB；超过时会提示保存失败，需要导出后开启新会话。批量历史导入会在浏览器及 Worker 中读取完整会话数组，不适合超大归档。
- 删除会话不会立刻删除 R2 中的附件对象或上游已上传文件，避免影响其他分支/会话和未完成同步。R2 清理需在备份后自行执行，当前没有自动垃圾回收。
- ZIP 导入会替换**全部云端历史**；ZIP 导出沿用原有格式，只附带图片原件，非图片附件只有元数据。云端日常同步则包含所有已保存附件原件。

## 1. 安装与本地运行

需要 Node.js 22.12+（建议 24）和 pnpm。

```powershell
pnpm install
Copy-Item .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，设置本地 `APP_PASSWORD`，需要实际聊天时再填写 `UPSTREAM_API_KEY`；编辑 `wrangler.jsonc` 中上游协议、地址和模型。

```powershell
pnpm db:local
pnpm dev:cloud
```

打开 `http://127.0.0.1:8787`，输入 `.dev.vars` 中设置的密码。`DEV_AUTH=true` 仅控制本地调试错误和本地 HTTP 上游，不绕过密码验证；不要用于生产环境。开发模式用本地 D1/R2，不会写生产数据。

原纯前端模式使用 `pnpm dev`；`pnpm build` 构建纯前端版本，`pnpm build:cloud` 构建请求同源 `/api` 的云端版本。

## 2. 选择上游协议

编辑 `wrangler.jsonc` 的 `vars`。`UPSTREAM_BASE_URL` 填接口基础地址，不包含最终的 `/chat/completions` 或 `/messages`。

| 协议        | Base URL 示例              | 实际请求                 | 支持范围                                         |
| ----------- | -------------------------- | ------------------------ | ------------------------------------------------ |
| `openai`    | `https://relay.example/v1` | `/v1/chat/completions`   | 标准流式文字，图片，文本/代码附件                |
| `anthropic` | `https://relay.example/v1` | `/v1/messages`           | 标准流式 Messages，图片，文本/代码附件           |
| `deepseek`  | `https://api.deepseek.com` | `/anthropic/v1/messages` | 原项目的 DeepSeek 扩展功能；上游必须支持相应接口 |

例如 OpenAI 兼容中转：

```json
{
  "UPSTREAM_PROTOCOL": "openai",
  "UPSTREAM_BASE_URL": "https://relay.example/v1",
  "UPSTREAM_MODEL": "your-model-id",
  "MAX_OUTPUT_TOKENS": "32768",
  "MAX_INPUT_TOKENS": "196608"
}
```

实际模型 ID 必须以中转站文档为准。仓库中的 `wrangler.jsonc` 包含当前部署环境的配置；部署到自己的账号时，需要替换账号、数据库、存储桶和上游配置。接口地址与模型名称应以自己使用的服务商文档为准。

OpenAI 兼容模式支持 Chat Completions 与 Responses。`OPENAI_API_STYLE` 默认为 `chat_completions`，当前部署使用 `responses`：请求 `reasoning.summary=detailed`，将公开的推理摘要转换成可展示的思考块；`store=false`，工具往返中的加密推理项只作为不透明数据传回上游，不在页面展示。接口仍可能不给摘要，例如简单任务或较低思考强度。两种模式均支持流式正文、用量、按需工具循环、搜索和独立标题生成；Responses 使用 `reasoning.effort`，Chat Completions 使用 `reasoning_effort`。标题在首轮成功回答后异步生成；失败时保留临时标题，手动重命名优先。

支持的模型在输入框提供“思考：默认 / 低 / 中 / 高”。选择“默认”不传 `reasoning_effort`，由服务商使用模型预设值。默认仅对名称以 `gpt-5` 至 `gpt-9` 或 `o1` 等推理模型前缀开头的模型开放三档；中转别名或其他能力可在 Worker **Variables** 设置 `OPENAI_REASONING_EFFORTS`，例如 `low,medium,high,xhigh`，实际列表应以模型支持范围为准。设为空字符串时隐藏思考强度入口，不传此参数。只展示接口真实返回的思考文字，不模拟模型内部思考。

Chat Completions 使用 `max_completion_tokens`，上游明确拒绝时兼容 `max_tokens`；也兼容明确拒绝 `stream_options` 的中转站。Responses 使用 `max_output_tokens`。两者的输出限制均计入思考与正文，不默默丢弃用户选择的思考强度。

### 模型切换、思考与 MCP

输入框的“联网搜索”右侧可选择当前服务的模型；“设置 → 模型”可刷新上游 `/models` 列表，接口不提供列表时可手动添加模型 ID。下一条消息使用选中的模型，续写保留原回答的模型。这里只切换模型，不改变部署的协议、服务地址或 API Key。输入框下方居中显示整个会话的累计 Token，并排显示输入、缓存、输出和思考统计。

OpenAI 推理模型在等待返回时显示“正在思考”；兼容 `reasoning_content`、`reasoning` 及 `reasoning_details` 中公开的文字或摘要。接口仅返回答案或加密推理时，只展示答案。Anthropic 返回的思考块与签名在本轮工具往返中保留。

“设置 → MCP”可管理最多五个远程 **Streamable HTTP** 连接，填写名称、公共 HTTPS 地址和可选 Bearer Token，测试连接后选择要启用的工具。Token 保存在 D1，不回传或写入浏览器 localStorage；更换服务地址时需重新填写 Token。MCP 配置不包含在历史 ZIP 备份中。

模型会按需调用已启用工具。服务声明 `readOnlyHint: true` 的工具可直接调用，请只启用信任的服务；其他工具会在对话中显示名称和参数，选择“允许这次调用”后执行。“拒绝”、停止生成或确认过期后不会执行该次待确认调用。工具调用数量、连接超时与输出长度均有限制。当前支持 OpenAI / Anthropic 兼容协议，以及 Bearer Token / OAuth 登录；暂不支持 DeepSeek 扩展协议的 MCP、本机 stdio 或旧版 SSE。Notion OAuth 连接方式见第 7 节。

所有 MCP 工具定义都按需加载：首轮只提供受预算约束的简短目录和 `mcp_load_tools`，模型查询名称、描述后加载最多 3 个工具的完整参数定义。每次加载替换上次定义并保留参数约束，单批最多 12,000 token，最多 12 次目录查询/加载。独立的读取工具可并行，写入及依赖操作按顺序执行，并保留用户确认。MCP 返回值不再直接截断 JSON；大结果在本次请求中完整缓存，以受限片段返回，模型可用 `read_tool_result` 按偏移或关键词读取遗漏内容，不必重做远程操作。缓存不跨请求保存。

`pnpm deploy:cloud` 会先构建，再应用远程数据库迁移，最后发布 Worker；迁移失败时停止发布。已有部署升级会自动应用包含 `0003_mcp.sql` 的待执行迁移，也可用 `pnpm db:remote` 单独迁移。本地运行使用 `pnpm db:local`。新增表只保存 MCP 配置和临时确认记录，不替换历史数据。

OpenAI 的 `MAX_INPUT_TOKENS` 默认 `196608`，`MAX_OUTPUT_TOKENS` 默认 `32768`；Anthropic 缺省分别为 `64000` 和 `8192`。设置 → 模型会显示当前输入预算和单次输出上限。两者必须按当前模型与中转站的实际能力配置，这些数值不能扩展模型原生窗口。可设置 `MODEL_CONTEXT_TOKENS` 为已确认的模型窗口；输入预算会自动扣除输出上限和 1024 token 余量。标准模式估算 ASCII 文本每 3 个字符约 1 token、非 ASCII 每个字符预留 2 token，每张图片预留 4096 token；按完整轮次裁剪旧上下文，保留本轮问题和工具往返。它是预算估算，并非模型的精确 tokenizer 或图片用量计数。系统提示和 MCP 工具定义也占预算：超限时单独提示减少启用工具或提高预算，工具结果超限也有独立提示，避免把固定工具开销误报为问题过长。会话完整历史仍保存。历史搜索来源的 URL、标题和受限摘要供后续追问使用，历史引用编号与本轮引用隔离。

启动合并读取登录状态和模型配置，正常加载显示轻量品牌画面，不再弹出“个人云端空间 / 正在加载对话”对话框。图片在当前页面打开预览，支持关闭、Esc、点击外侧和下载原图；标签页使用内嵌 SVG 标识。

### 配置联网搜索（继续使用当前中转模型）

OpenAI / Anthropic 兼容模式支持独立的 [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)，不需要修改 `UPSTREAM_PROTOCOL`、模型或中转地址。

1. 在 [Tavily 控制台](https://app.tavily.com/) 创建 API Key。
2. 在 Cloudflare **Workers & Pages → personal-chat → Settings → Variables and Secrets** 添加 **Secret**，名称为 `TAVILY_API_KEY`，值为该密钥。不要把密钥写进 `wrangler.jsonc`、前端代码或聊天中。
3. 部署本次版本后刷新网页，开启输入框下方“联网搜索”再发送问题。

也可以在本机终端中交互输入密钥，再发布代码：

```powershell
pnpm exec wrangler secret put TAVILY_API_KEY
pnpm deploy:cloud
```

本地运行时，将 `TAVILY_API_KEY=你的密钥` 放入忽略提交的 `.dev.vars`，然后启动 `pnpm dev:cloud`。

OpenAI / Anthropic 模式启用搜索后，由模型结合对话决定是否调用 `web_search` 与 `read_web_page`，无需额外的分类模型请求。日期、名称等普通查询默认使用 quick 策略：最多 3 个研究工具轮次、4 次搜索、2 次正文读取，每次 basic 搜索最多 5 个来源。深入调查、实质性比较或多来源报告可在首次网络工具调用时选择 research 策略：最多 6 轮、8 次搜索、6 次正文读取，每次 advanced 搜索最多 8 个来源；中途不能因单个事实难以查到而扩大预算。预算是上限，有充分证据时应立即回答；缺失或矛盾的事实只做有限定向核验，仍不确定时明确说明。连续两轮没有新证据会收尾。普通查询从首次工具调用起经过 30 秒、深入研究经过 90 秒后不再启动新检索；它不是整条回答的耗时保证，已经开始的请求和最终生成仍需完成。普通搜索和正文请求最长等待 12 秒，深入搜索 25 秒、正文 20 秒。

传入模型的累计网络证据预算按 `contextCost` 估算，普通查询最多约 8,000 token，深入研究约 20,000 token；单个结果预览分别约 1,800 / 3,000 token。模型与界面优先接收包含问题关键词的原文片段，保留 URL、标题、引用及截断标记。搜索返回内容和正文在每来源最多 48,000 字符的限制内留在本次请求缓存，可用 `read_tool_result` 和 `find` 定位省略证据；网络缓存读取也计入研究轮次和证据预算。重复查询、页面、完全相同的来源摘要不会反复请求或塞入模型历史，页面锚点和常见跟踪参数归并为同一来源。独立调用默认最多 4 路并行。研究期间工具定义保持稳定，由执行层拒绝超预算调用；OpenAI Responses 的固定提示放在 `input` 开头的 developer 消息中，最终收尾指令单独使用顶层 `instructions`，便于复用固定前缀。实际缓存计量与命中仍取决于模型服务和中转站。

联网搜索每次加载页面默认关闭，按钮通过选中状态显示是否开启，当前页面内沿用选择。失败会显示失败步骤，并告知模型搜索不可用，让其明确说明并使用已有知识回答；没有结果时也不冒充搜索成功。Tavily 按自己的额度和套餐计费，不配置密钥时入口禁用。OpenAI 中转模型需支持标准函数调用。

Anthropic 与 OpenAI 共用上述按需搜索和 MCP 执行策略，不再固定先搜索或直接截取用户问题作为查询。DeepSeek 扩展模式继续使用上游原生搜索 / 浏览事件，仅在上游确实支持相应扩展时使用。

可在 Worker Variables 调整硬上限：`MAX_AGENT_ROUNDS`（默认 24，MCP 流程保留独立预算）、`MAX_TOOL_CALLS`（32）、`MAX_SEARCH_CALLS`（8）、`MAX_PAGE_READS`（12）、`MAX_RESEARCH_ROUNDS`（6）和 `MAX_RESEARCH_TOKENS`（20000）。实际网络预算取这些上限与所选策略的较小值，并受输入预算限制。`TOOL_CONCURRENCY` 默认 4、最多 8；`SEARCH_MAX_RESULTS` 可覆盖策略的结果数、最多 20，`SEARCH_DEPTH` 可覆盖 basic / advanced；`PAGE_MAX_CHARACTERS` 默认 48000。advanced 搜索与更多调用会增加 Tavily 额度消耗。

新回复顶部显示“处理用时”，从附件准备完成、发出模型请求开始，包含模型等待、工具调用、确认等待和回答生成，并按浏览器单调时钟计算与保存；续写累计前一次用时。它不是模型内部推理耗时，公开摘要的到达速度无法测量后者。历史记录仍按已有思考块用时显示，缺少记录时不伪造秒数。

会话 Token 统计累计所有回答版本、续写和已返回用量的工具阶段，续写过程中保留此前累计量。后台每条记录是单次请求，包含自动标题请求，不能要求每条记录都递增。中断发生在用量帧返回前时，最后一次请求的账单 Token 无法由浏览器恢复；此前已完成工具阶段的用量会即时返回并保留。标题用量不计入页面的会话累计量。

标准模式附件支持 PNG、JPEG、GIF、WebP，文本/代码附件上限 2 MiB；PDF、Office、电子书没有接入独立解析服务，不能当纯文本发送。图片仍受服务商的模型能力和大小限制。DeepSeek 扩展模式沿用原项目的文件和语音接口。

切换服务商或协议后，历史服务端文件 ID 不保证通用。需要使用附件时应重新添加文件；会话正文和本地/云端附件原件仍保留。

## 3. 创建 Cloudflare 资源

登录账号：

```powershell
pnpm exec wrangler login
pnpm exec wrangler whoami
```

创建数据库和附件桶：

```powershell
pnpm exec wrangler d1 create personal-chat
pnpm exec wrangler r2 bucket create personal-chat-files
```

将数据库返回的 `database_id` 填入 `wrangler.jsonc`，替换全零占位 ID。如果资源名称被占用，可以换名字并同时修改绑定配置及 package.json 中的数据库命令。

```powershell
pnpm db:remote
```

如账号尚未启用 R2，需先在 Cloudflare 控制台启用；请求、数据库和存储按 Cloudflare 账号套餐及实际用量计费。

## 4. 设置一个访问密码并上线

不需要开通 Zero Trust 或配置 Access。只需：

1. 在 Cloudflare 控制台打开 **Workers & Pages → personal-chat → Settings → Variables and Secrets**。
2. 添加类型为 **Secret** 的变量 `APP_PASSWORD`，值填你自己的访问密码（至少 12 字符）。
3. 保存并部署。打开 Worker 地址，在登录页输入这个密码即可。

也可以在本机终端安全输入：

```powershell
pnpm exec wrangler secret put APP_PASSWORD
pnpm deploy:cloud
```

密码不要发到聊天或写进代码。手机和电脑使用同一个密码，分别保持登录 30 天。在“设置 → 数据管理”中可以退出；修改 `APP_PASSWORD` 会使所有设备的旧登录失效。登录失败限制为同一 IP 15 分钟内最多 10 次；退出不会删除未同步副本。

当前入口：`https://personal-chat.2519175810.workers.dev`。如果之前已经手动创建了 Access 应用，需要移除这个站点的 Access 保护，否则仍会先看到邮箱登录。

## 5. 模型密钥可以后补

先设置访问密码，就可以进入网页、管理和同步历史。准备好中转站时再在同一个界面添加 **Secret**：`UPSTREAM_API_KEY`，并修改 `UPSTREAM_PROTOCOL`、`UPSTREAM_BASE_URL` 和 `UPSTREAM_MODEL`。

终端设置模型密钥：

```powershell
pnpm exec wrangler secret put UPSTREAM_API_KEY
```

同一域名的前端和 API 一起部署。控制台修改普通变量后，请同步修改本地 `wrangler.jsonc` 的同名变量，避免下次本地部署覆盖配置。Secret 不写进这个文件，后续部署会保留已设置的 Secret。

## 6. 从原项目迁移历史

- **同一 origin 的旧 IndexedDB**：打开“设置 → 数据管理 → 上传本机历史”，作为新会话副本上传；重复点击会再产生一份副本。
- **来自 GitHub Pages、localhost 或另一域名**：先在旧页面导出 ZIP，再到新站导入。导入会覆盖现有云端历史，先下载备份。
- 原 ZIP 不含非图片附件原件；这些附件需要重新添加。不要将云端副本误认为旧站点数据已经自动迁移。

## 7. 连接 Notion 等 OAuth MCP 服务

更新已有部署时执行 `pnpm deploy:cloud`，命令会在发布前自动应用 `0004_mcp_oauth.sql` 等待执行迁移。缺少这次迁移时，OAuth 授权无法启动。本地开发使用 `pnpm db:local`。OAuth 注册信息、访问令牌和刷新令牌保存在 D1，不回传浏览器，也不写入本机设置。

在“设置 → MCP → 添加 MCP 连接”填写名称与 `https://mcp.notion.com/mcp`，选择“OAuth 浏览器登录”，点击“登录授权”。浏览器会前往 Notion；完成授权后返回本站，自动保存连接并发现工具。回调地址为本站 origin 加 `/mcp/oauth/callback`，必须使用稳定的公网 HTTPS 域名；更换域名后需要重新授权。回调使用当前浏览器的访问密码会话，请在原浏览器中完成授权。

Notion 官方 MCP 的 OAuth 连接适用于所有套餐，无需购买静态 MCP Token；具体工具仍受 Notion 套餐和工作区权限限制。参考：[连接指南](https://developers.notion.com/guides/mcp/get-started-with-mcp)及[客户端开发指南](https://developers.notion.com/guides/mcp/build-mcp-client)。

访问令牌临近过期或被服务拒绝时自动刷新；D1 锁保证同一连接的刷新串行执行。服务返回 `invalid_grant` 等终止授权错误时，设置页显示“需要登录授权”；点击“重新授权”恢复。暂时的网络或服务故障保留凭据，可稍后重试。取消授权或回调失败保留原连接；删除连接同时清除凭据和待完成授权。OAuth 服务需支持自动发现、PKCE S256 和动态客户端注册；本机 stdio 与旧版 SSE 暂不支持。

## 验证

```powershell
pnpm type
pnpm type:worker
pnpm lint
pnpm build:cloud
pnpm test:cloud
pnpm test:mcp-context
pnpm test:responses
```

`test:cloud` 验证真实本地 D1/R2 上的版本冲突、原子历史替换和删除、附件字节往返、模拟 OpenAI 流式转换、MCP 读写确认及 OAuth 全流程（PKCE、单次回调、并发刷新、临时故障、授权撤销和配置变更）。它使用临时数据库和模拟 API，不调用收费模型、不接触线上数据。默认使用本机 8788 和 9899 端口，可用 `SMOKE_WORKER_PORT` / `SMOKE_MODEL_PORT` 环境变量改端口。

浏览器回归：先运行 `node --import tsx scripts/smoke-cloud.mjs --serve`，另一个终端运行 `pnpm test:ui`。自定义端口时同时设置 `UI_ORIGIN` 和 `UI_MODEL_PORT`。其中 OAuth 检查使用模拟服务；真实 Notion 工作区的最终授权需用户在浏览器中登录完成。

人工浏览器验证包括密码登录、刷新后保持登录、退出、桌面与手机布局；此前还验证了聊天和独立浏览器会话读取同一云端记录。真实中转站需要在选定服务后再验证。

官方参考：

- Cloudflare Workers Static Assets：<https://developers.cloudflare.com/workers/static-assets/>
- Wrangler 配置：<https://developers.cloudflare.com/workers/wrangler/configuration/>
- D1：<https://developers.cloudflare.com/d1/>
- R2：<https://developers.cloudflare.com/r2/>
- Worker Secrets：<https://developers.cloudflare.com/workers/configuration/secrets/>
