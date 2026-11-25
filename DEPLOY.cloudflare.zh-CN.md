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
- 一个会话的 JSON 上限为 1.5 MB；超过时会提示保存失败，需要导出后开启新会话。批量导入逐会话暂存，全部检查后用 D1 条件事务原子切换；容量与采样范围见下文。
- 删除会话不会立刻删除 R2 中的附件对象或上游已上传文件，避免影响其他分支/会话和未完成同步。R2 清理需在备份后自行执行，当前没有自动垃圾回收。
- ZIP 导入会替换**全部云端历史**；新 ZIP 备份保存完整会话数据及可用的图片、非图片附件原件，兼容导入旧 DeepSeek v3 ZIP。新备份需要本版本或更新版本恢复，不能导入 DeepSeek 原站；凭据和应用设置不在历史备份内。

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

支持的模型在输入框提供配置的思考档位。选择“默认”不传 `reasoning_effort`，由服务商使用模型预设值。应用不再按模型名称猜测档位：默认模型可在 Worker **Variables** 设置 `OPENAI_REASONING_EFFORTS`，例如 `low,medium,high,xhigh`；其他模型使用下文 `MODEL_PROFILES` 的 `reasoningEfforts`。未配置或设为空时隐藏强度入口，也不向 Responses 发送 `reasoning` 和加密推理 include 参数。只展示接口真实返回的思考文字，不模拟模型内部思考。

Chat Completions 使用 `max_completion_tokens`，上游明确拒绝时兼容 `max_tokens`；也兼容明确拒绝 `stream_options` 的中转站。Responses 使用 `max_output_tokens`。两者的输出限制均计入思考与正文，不默默丢弃用户选择的思考强度。

### 模型切换、思考与 MCP

输入框的“联网搜索”右侧可选择当前服务的模型；“设置 → 模型”可刷新上游 `/models` 列表，接口不提供列表时可手动添加模型 ID。下一条消息使用选中的模型，续写保留原回答的模型。这里只切换模型，不改变部署的协议、服务地址或 API Key。输入框下方居中显示整个会话的累计 Token，并排显示输入、缓存、输出和思考统计。

在 Worker Variables 中设置字符串 `MODEL_PROFILES`，值为按模型 ID 索引的 JSON。以下数值仅示范配置方式，实际窗口与能力必须由自己的服务商确认：

```json
{
  "small-model": {
    "contextTokens": 8192,
    "maxOutputTokens": 1024,
    "images": false,
    "tools": false,
    "apiStyle": "chat_completions"
  },
  "large-model": {
    "contextTokens": 131072,
    "maxInputTokens": 100000,
    "maxOutputTokens": 8192,
    "images": true,
    "tools": true,
    "reasoningEfforts": ["low", "medium", "high"],
    "apiStyle": "responses"
  }
}
```

在 `wrangler.jsonc` 中，`vars.MODEL_PROFILES` 需保存为转义后的 JSON 字符串，仓库已有示例。`contextTokens` 必填，可为 `null` 表示窗口未知；`maxOutputTokens`、`images`、`tools` 必填。输入预算取 `maxInputTokens` 与“窗口减输出减 1024”中的较小值；未知窗口未给输入预算时使用 8192。`apiStyle` 只控制同一 OpenAI 服务的 Chat Completions/Responses 路径，不切换协议、服务地址和密钥。`reasoningEfforts` 默认为空列表，允许 `none,minimal,low,medium,high,xhigh` 中模型实际支持的值。

匹配的模型配置优先；默认模型没有独立配置时沿用全局预算和协议基本能力。其他未配置模型使用输入 8192、输出 2048 的文本模式，关闭图片、工具和联网搜索，并明确显示能力未配置。可以配置 `"*"` 条目替换该回退策略，但其能力必须适用于所有未单独配置的模型。设置页随选中模型更新预算、窗口和能力；续写、重新生成及自动标题也使用目标模型配置。`/models` 只用于发现 ID，不作为能力证明。仓库当前模型的窗口保留 `null`，没有据名称填入一个未经验证的窗口。

OpenAI 推理模型在等待返回时显示“正在思考”；兼容 `reasoning_content`、`reasoning` 及 `reasoning_details` 中公开的文字或摘要。接口仅返回答案或加密推理时，只展示答案。Anthropic 返回的思考块与签名在本轮工具往返中保留。

“设置 → MCP”可管理最多五个远程 **Streamable HTTP** 连接，填写名称、公共 HTTPS 地址和可选 Bearer Token，测试连接后选择要启用的工具。Token 保存在 D1，不回传或写入浏览器 localStorage；更换服务地址时需重新填写 Token。MCP 配置不包含在历史 ZIP 备份中。

模型会按需调用已启用工具。所有既有及新增工具默认逐次确认；在设置中勾选并保存“信任某工具，允许自动读取”，且远端仍声明 `readOnlyHint: true` 时，该工具才可自动执行及并发读取。远端注解不构成独立授权。其他工具显示名称和参数，选择“允许这次调用”后执行。“拒绝”、停止生成或确认过期后不会执行该次待确认调用。配置修改、服务/工具禁用或删除、URL/令牌/认证变化会使进行中的旧请求失效；派发前重新检查 D1，已派发操作无法撤回。认证/地址变化、重新 OAuth 授权及已发现 schema 变化清除旧自动读取信任；远端 schema 更新后可“测试连接”并保存以刷新。工具调用数量、连接超时与输出长度均有限制。当前支持 OpenAI / Anthropic 兼容协议，以及 Bearer Token / OAuth 登录；暂不支持 DeepSeek 扩展协议的 MCP、本机 stdio 或旧版 SSE。Notion OAuth 连接方式见第 7 节。

所有 MCP 工具定义都按需加载：首轮只提供受预算约束的简短目录和 `mcp_load_tools`，模型查询名称、描述后加载最多 3 个工具的完整参数定义。每次加载替换上次定义并保留参数约束，单批最多 12,000 token，最多 12 次目录查询/加载。独立的读取工具可并行，写入及依赖操作按顺序执行，并保留用户确认。MCP 返回值不再直接截断 JSON；大结果在本次请求中完整缓存，以受限片段返回，模型可用 `read_tool_result` 按偏移或关键词读取遗漏内容，不必重做远程操作。缓存不跨请求保存。

`pnpm deploy:cloud` 会先构建，再应用远程数据库迁移，最后发布 Worker；迁移失败时停止发布。已有部署升级会应用所有待执行迁移，包括本批 `0005_tool_operations.sql`、`0006_history_import.sql`、`0007_object_lifecycle.sql`，也可用 `pnpm db:remote` 单独迁移。本地运行使用 `pnpm db:local`。新表保存有限操作核验证据、导入暂存及对象恢复引用，不替换历史数据；缺少 `0005` 时工具派发会被保存屏障阻止。发布前备份 D1；SQL 导出含配置/凭据，必须放在忽略提交的私有目录。

模型超时可在 Variables 配置 `MODEL_RESPONSE_TIMEOUT_MS`（默认 120000）、`MODEL_FIRST_EVENT_TIMEOUT_MS`（180000）、`MODEL_IDLE_TIMEOUT_MS`（180000）、`MODEL_TOTAL_TIMEOUT_MS`（900000），单位毫秒，允许 10–3600000 的整数。期限按每次实际模型调用独立计算；完整思考事件刷新空闲期限，ping、注释和半条事件不能延长它，等待 MCP 确认不消耗模型期限。浏览器使用 `/api/config` 的配置增加等待余量，整轮默认另有 45 分钟总限额，单次模型配置更长时相应延长。静态模式使用独立的浏览器默认期限。

SSE 单行最多 1 MiB、单事件最多 2 MiB（UTF-8，含事件行分隔）；异常响应最多读取 64 KiB，随后取消读取，展示错误摘要。标准模式的回答可展开查看保留/省略轮次、首个保留问题与输入/输出预算估算。DeepSeek 扩展服务自行管理上下文，因此不显示伪造的本地范围。

标准模式还会从被裁剪的当前分支生成有来源的原文摘录，最多 16 段/4000 字符，总成本含说明最多 `min(1024, inputBudget / 8)` tokens，计入本次输入估算；额外模型摘要请求为 0。来源按消息 ID、角色和内容的 SHA-256 核验，每次生成/续写重新从原文提取；编辑、切换回答版本或删除来源后的旧摘录不能复用。摘要失败或预算不足时继续完整轮次裁剪。摘录不含附件原件，不能保证全部早期事实被保留；缺证据时查看原消息或重新读取，旧授权和工具主张不得被当成新的执行许可。

生成前必须将请求恢复 ID 提交到本页面 IndexedDB outbox；工具状态和上下文记录也独立提交。20 秒无法提交或存储失败会结束生成，网络保存失败仍允许保留本机恢复记录。D1 操作记录仅保存请求/操作 ID、服务/工具名称、状态、时间和结果 SHA-256。加载会话或点击核验不会调用工具；结果正文缺失时需要读取核验。已派发且未确认的记录显示结果未知，不自动重放；它不是跨请求幂等机制。操作记录暂未自动清理，保留和清理策略列入后续任务 10；不应把会话 ZIP 当作此表的灾难恢复备份。

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

工具结果的内存预算独立于 Token 预算：`MAX_TOOL_RESULT_BYTES` 默认 1 MiB（单条保留文本）、`MAX_TOOL_CACHE_BYTES` 默认 8 MiB（本次请求总量）、`MAX_TOOL_CACHE_ENTRIES` 默认 128。缓存按 JavaScript UTF-16 字符串的两字节码元保守计量，超限时保留有限预览并明确说明完整数据未缓存，不提供无效的 `result_id`；已缓存的早期证据不会因后续结果被淘汰。`MAX_MCP_RESPONSE_BYTES` 默认 2 MiB，在 SDK 解析前限制单个 HTTP 返回体的实际字节，覆盖有 Content-Length 和分块流式返回。它不等于进程总堆内存保证，仍需考虑并发、解析对象和协议开销。

当前 MCP 桥接将图片、音频及内嵌二进制资源转换为不含 Base64 的元数据，明确标记二进制内容不可作为文字证据。工具本身可能已经执行，返回太大或缓存失败不代表操作没有副作用；应先用读取工具核验，再决定是否重试写入。

写操作已派发而返回失败时，同一次生成内会阻止相同服务、工具及规范化参数的自动重试，避免重复创建或修改。模型仍可读取核验并报告结果；后续新提问可由用户决定是否再次执行。

新回复顶部显示“处理用时”，从附件准备完成、发出模型请求开始，包含模型等待、工具调用、确认等待和回答生成，并按浏览器单调时钟计算与保存；续写累计前一次用时。它不是模型内部推理耗时，公开摘要的到达速度无法测量后者。历史记录仍按已有思考块用时显示，缺少记录时不伪造秒数。

会话 Token 统计累计所有回答版本、续写和已返回用量的工具阶段，续写过程中保留此前累计量。后台每条记录是单次请求，包含自动标题请求，不能要求每条记录都递增。中断发生在用量帧返回前时，最后一次请求的账单 Token 无法由浏览器恢复；此前已完成工具阶段的用量会即时返回并保留。标题用量不计入页面的会话累计量。

标准模式附件支持 PNG、JPEG、GIF、WebP，图片上限 8 MiB、文本/代码附件上限 2 MiB；PDF、Office、电子书没有接入独立解析服务，不能当纯文本发送。图片还受目标模型的能力和服务商限制。DeepSeek 扩展模式沿用原项目的文件和语音接口。

Worker 按实际读取字节限制请求，`Content-Length` 仅用于提前拒绝，缺少或声明较小时仍计量实际流。原件上传上限 64 MiB，使用 R2 分段上传，超限或流中断会取消暂存分段，保留已有原件。标准模式 multipart 请求最多 9 MiB；普通 JSON 最多 256 KiB，聊天请求最多 4 MiB，会话保存请求最多 1,600,000 字节，旧整包历史替换接口最多 16 MiB。单会话存储仍受原有 1.5 MB 限制；当前 ZIP 导入使用分批暂存接口，超限保留旧历史。

标准模式先按附件元数据估算和裁剪完整旧轮次，再读取保留的原件；最多展开 50 个附件、累计 16 MiB 原件。文档估算按原件字节保守预留，可能比实际分词更早裁剪。图片能力关闭时，保留上下文中的图片会提示切换模型；已裁剪旧轮次的原件不再读取。

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


## 元数据缓存、容量和维护（2026-11-25）

本批新增 `0006_history_import.sql`、`0007_object_lifecycle.sql`；与 `0005_tool_operations.sql` 一起已于 2026-11-25 最终发布时应用。发布前导出 D1，发布后核对原数据数量/版本、迁移及线上浏览器入口。线上版本 `fd8b0bec-2fc2-42c9-8e23-78187dc66870`；没有调用生产模型，生产完整容量/业务/灾备仍需单独验证，详见 [发布验收记录](reports/final-acceptance.zh-CN.md)。

- MCP 目录保存在 D1 配置中，期限 5 分钟。普通回答和目录查询不连接远端；加载指定工具才连接对应服务，过期时重新发现。初始化与全部发现分页共用 20 秒期限，最多 10 页/100 工具/2 MiB 目录。schema 变化或收到 `tools/list_changed` 通知撤销旧信任并要求新请求；启停、工具权限、URL、令牌和 OAuth 变化仍按配置版本核验。通知只在按需连接存活期间接收，其他时间由期限和配置核验控制。
- 云端列表每页 200 条，前端校验所有页的 generation/revision；搜索先取候选 ID 和大小，然后逐条读取，实际累计 JSON 最多 8 MiB。索引最多 10,000 会话。云端导入逐会话暂存，单会话 1,500,000 字节、整批最多 10,000 会话/512 MiB，24 小时暂存期限，最后在 D1 条件事务中切换。超限、缺失或版本竞争不清空旧历史；提交网络中断后先同步核验 generation，不能由未收到响应推定未提交。
- 备份单份会话/索引 JSON 16 MiB、单原件 64 MiB、解压总量 2 GiB。超限有明确提示，正式历史只在完整校验后替换。配置上限不是全部组合均已做生产容量认证；实测范围见 `reports/capacity-baseline.json`。
- 同源页面用 Web Locks 的会话独占锁及历史共享/独占锁协调，覆盖审批、标题和保存收尾。另一页面被拒绝时保留其本机副本。锁页面关闭后可接管，旧审批不重放；跨设备仍由 D1 版本仲裁。不支持 Web Locks 的浏览器使用 IndexedDB 单一保守租约，串行全部工作；到期不能证明挂起页面或 Worker 已停止，因此不自动抢占。崩溃后先关闭全部本站页面，在浏览器站点存储工具中仅删除 `personal-chat-coordination` 数据库，然后重开；不要删除保存历史/outbox/原件的 `chat-demo` 数据库。BroadcastChannel 不可用时仍保留手动同步入口。

`OBSERVABILITY=true` 和 Wrangler observability 已启用。自定义日志只记录服务端请求 ID、枚举阶段/结果、HTTP 状态、耗时、计数及预算，响应带 `X-Request-ID`。不写正文、完整参数、错误原因链或凭据；SSE 失败看模型流阶段日志，不能只凭入口 200 判断生成成功。

对象维护是人工两阶段流程，未设置定时删除任务：

1. 登录 owner 会话后 `GET /api/storage/objects?prefix=attachments/`（也支持 `provider/`），按返回的 cursor 分页。这是只读预演，返回 key、etag、大小、上传时间和保留原因。
2. `OBJECT_GC_TRACKING_SINCE` 缺省时全部原件受到旧版本恢复保护。开始使用新版本的恢复 pin 后，可配置该 UTC 切换时间；切换前上传的对象继续永久保护，不能猜测旧离线 outbox 已不存在。
3. 切换后至少保留 30 天，只将无会话引用、无恢复 pin 的对象列为 candidate。确认预演清单后，用 `DELETE /api/storage/objects` 的 JSON `{ "key": "attachments/…", "etag": "…" }` 删除单个候选；服务端再次核验引用及 etag，D1 claim 阻止其间新的 pin/上传/会话及导入提交。实际删除前再次读取 R2；任何不确定状态保守拒绝。
4. 本页面 outbox 原件与导入暂存通过永久 pin 保护，成功提交后按版本释放。失败或关闭页面留下的 pin 不自动过期。`GET /api/storage/pins` 按 after 分页列出恢复引用；只有恢复成功、相关备份已验证且原副本已放弃时，才以其返回 version 调用 `DELETE /api/storage/pins/{id}`。旧版本清理不能删除较新 pin。进程在清理中崩溃留下的 `object_gc_claims` 保守阻止重用；先停止写入、核验对象/恢复引用，再由维护人员处理该 claim，不能按时间自动抢占。

最终审查补齐：outbox 在 IndexedDB 删除确认后才释放 pin；导入暂存正文引用也受 pin 保护（包括 ZIP 缺少的原件），以内容摘要区分不同暂存版本，只有浏览器清空暂存后才申请按 generation 释放。提交响应丢失时前端用导入 ID/generation 核验，重复提交不会清空已导入历史。R2 删除返回异常、结果不确定时保留 claim，按上述停写/核验流程处理；每次保存重新核验可用原件，清理后再次引用会按需重传。普通云端请求的 60 秒期限覆盖正文消费，标题收尾可随停止/导入中止。

`pnpm test:disaster-recovery` 会停止一个隔离本地 Worker，复制整个 D1/R2 persistence 目录，再启动新的 Worker 核验 generation/revision、会话、恢复 pin 和原件 SHA-256。这是本地完整存储恢复演练，区别于会话 ZIP。生产灾备还需单独备份 D1 全库、R2 所有原件及 Worker Secrets/配置，并在停止写入的隔离环境演练；会话 ZIP 不含 MCP/OAuth 凭据或应用 Secrets。
