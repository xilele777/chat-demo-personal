# 个人版 Cloudflare 部署

此版本供一个人跨设备使用：一个访问密码登录，Workers 代理模型请求，D1 保存完整消息树，R2 保存附件。无需 Cloudflare Access、邮箱策略或 AUD，没有注册、多用户管理或 MCP。原始纯前端模式仍可用。

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
  "MAX_OUTPUT_TOKENS": "8192"
}
```

实际模型 ID 必须以中转站文档为准。默认值 `https://api.deepseek.com/v1` + `deepseek-chat` 是待自行配置的示例，并不保证某家中转站兼容。

OpenAI 兼容模式使用标准 Chat Completions：支持流式正文、接口公开返回的思考内容、用量、`reasoning_effort`、按需函数调用搜索和独立的会话标题生成。标题在首轮成功回答后异步生成；失败时保留首条问题的临时标题，手动重命名优先。不会向 OpenAI 模型发送 DeepSeek 的标题、安全或链接阅读扩展；语音入口按能力隐藏。

输入框提供“思考：自动 / 低 / 中 / 高”。自动不传 `reasoning_effort`，由服务商使用默认值。默认仅对名称以 `gpt-5` 至 `gpt-9` 或 `o1` 等推理模型前缀开头的模型开放三档；中转别名或其他能力可在 Worker **Variables** 设置 `OPENAI_REASONING_EFFORTS`，例如 `low,medium,high,xhigh`，实际列表应以模型支持范围为准。设为空字符串可仅保留自动。只展示接口真实返回的思考文字，不模拟模型内部思考。

OpenAI 默认使用 `max_completion_tokens`，它同时计入思考和正文；上游明确返回“不支持该参数”时才兼容重试 `max_tokens`。同样兼容明确拒绝 `stream_options` 的中转站，不会默默丢弃用户选择的思考强度。

`MAX_INPUT_TOKENS` 默认 `24000`，独立于 `MAX_OUTPUT_TOKENS`。标准模式使用 UTF-8 字节作为保守的文本 token 上界，每张图片预留 4096 token；按完整轮次裁剪旧上下文，保留本轮问题和工具往返。它是预算估算，并非模型的精确 tokenizer 或图片用量计数。会话完整历史仍保存；本轮内容本身超过预算时会提示缩短问题或移除附件。历史搜索来源的 URL、标题和受限摘要供后续追问使用，历史引用编号与本轮引用隔离。

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

OpenAI 模式启用搜索后，模型使用标准 `web_search` 函数按需决定是否搜索，并结合当前上下文生成独立搜索词；问候、翻译或上下文足够的问题可以直接回答。每轮最多调用 2 次 Tavily basic 搜索，每次最多保留 5 个去重的 HTTP/HTTPS 来源；模型收到工具结果后继续回答。界面显示真实搜索词、进行中 / 完成 / 失败状态、来源卡片和 `[citation:N]` 引用。历史回复保存这些过程，跨设备仍可查看；实时过程只在发起设备展示。

联网搜索每次加载页面默认关闭，开启时按钮明确显示“联网搜索已开启”，当前页面内沿用选择。失败会显示失败步骤，并告知模型搜索不可用，让其明确说明并使用已有知识回答；没有结果时也不冒充搜索成功。Tavily 按自己的额度和套餐计费，不配置密钥时入口禁用。OpenAI 中转模型需支持标准函数调用。

Anthropic 兼容模式继续使用“先搜索再回答”的路径，搜索词取本轮问题文字前 400 字符；不包含多轮自主搜索或逐页浏览。DeepSeek 扩展模式继续使用上游原生搜索 / 浏览事件，仅在上游确实支持相应扩展时使用，不能只改协议名称来获得能力。

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

## 验证

```powershell
pnpm type
pnpm type:worker
pnpm lint
pnpm build:cloud
pnpm test:cloud
```

`test:cloud` 只执行关键集成路径：真实本地 D1/R2 上的版本冲突、原子历史替换和删除、附件字节往返、模拟 OpenAI 流式转换，以及基本访问边界。它使用临时数据库和模拟 API，不调用收费模型、不接触线上数据。默认使用本机 8788 和 9899 端口。

人工浏览器验证包括密码登录、刷新后保持登录、退出、桌面与手机布局；此前还验证了聊天和独立浏览器会话读取同一云端记录。真实中转站需要在选定服务后再验证。

官方参考：

- Cloudflare Workers Static Assets：<https://developers.cloudflare.com/workers/static-assets/>
- Wrangler 配置：<https://developers.cloudflare.com/workers/wrangler/configuration/>
- D1：<https://developers.cloudflare.com/d1/>
- R2：<https://developers.cloudflare.com/r2/>
- Worker Secrets：<https://developers.cloudflare.com/workers/configuration/secrets/>
