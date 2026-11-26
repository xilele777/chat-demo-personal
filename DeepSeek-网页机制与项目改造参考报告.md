# DeepSeek 网页机制与项目改造参考报告

版本：1.0。整理日期：2026 年 11 月 26 日（北京时间）。

本报告供另一个 AI 阅读并结合用户的项目进行改造。内容合并了本次对 DeepSeek 网页 Network、账号配置、模型模式、上下文预算及网页打包代码的分析，并加入项目实现建议。

## 1. 使用说明与证据边界

分析对象为 https://chat.deepseek.com/ 的网页登录产品，采样客户端版本为 2.8.0，配置版本为 105。网络采样约发生在 2026-11-26 12:09–12:24，随后继续检查已获取的前端代码。数据来自一个已登录账号，不能代表所有账号或未来版本。

证据分为四类：

| 标签 | 含义 | 如何用于项目修改 |
|---|---|---|
| 网络实测 | 浏览器实际发送或收到的请求、响应、配置 | 可以作为该次产品行为的直接样本 |
| 前端代码 | 网页已加载的公开打包代码中的处理逻辑 | 可以确认客户端机制，不能代替服务端实现证据 |
| 改造建议 | 本报告针对通用 AI 项目的建议 | 需要结合项目架构、模型供应商和现有功能决定是否实施 |
| 未知 | 当前证据没有揭示或没有验证 | 不得补写成已确认事实 |

用户的项目代码、架构及模型供应商尚未提供。本报告不假定项目一定直接调用 DeepSeek 网页私有接口，也不假定它具备服务端会话、检索或摘要能力。

本次完成：登录后的初始化捕获；首轮普通问答；刷新后读取测试会话历史；同一会话中的深度思考算术测试；读取客户端配置和主 JavaScript。未实测上传大文件、耗尽账号配额、超长上下文、消息数量边界、禁用模式、连续重新生成或实际断流恢复。

所有访问令牌、登录参数、个人身份信息、真实会话 UUID、设备标识和挑战签名均已从本报告隐藏。原始 HAR 不包含在交付中。

## 2. 对项目最有价值的结论

1. 前端将当前对话分支已用 token 与新附件 token 合并检查，已有对话会挤占后续附件预算。
2. 当前下发预算为 890880，但不能把它认定为底层模型真实上下文窗口。
3. 会话有分支、父子消息和版本关系；发送请求引用会话及父消息，不重新上传完整聊天历史。
4. 配额可以按全部模式或特定模式返回耗尽标志和恢复时间。本账号当前返回空配额数组，没有提供剩余次数。
5. 编辑和重新生成配置值各为 5，前端按同一消息的分支版本数计算，不是账号每日聊天次数。
6. 模式、思考能力、搜索开关和实际使用的模型名称是不同概念。开启思考后仍返回 default 模式，具体模型名为空。
7. SSE 使用带状态的路径增量协议，操作和路径可能省略并继承前值；不能逐块当成独立完整 JSON。
8. 继续生成与断流恢复使用不同操作，恢复已有消息需要避免把重试当成新提问。
9. 网页存在按 token 超长和按消息数量达到上限的不同处理路径，具体服务端阈值未完全披露。
10. 自动摘要、服务端截断、系统提示词和采样参数没有被当前证据揭示；项目如果需要这些能力，应自行明确设计。

## 3. 账号配额、限制和状态

### 3.1 当前账号返回了什么

【网络实测】`GET /api/v0/chat/status` 多次返回 `mute: null`、`quotas: []`。`users/current` 的 chat 字段也返回相同状态。一个完整状态响应如下：

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "generated_at": 1795666896.754,
      "mute": null,
      "quotas": []
    }
  }
}
```

含义是当前数据没有标记禁言，也没有列出配额条目。不能解释为无限额度、零额度、剩余五次或每日不限量。每日上限、已用次数、剩余次数、下一次恢复时间在当前样本中均未提供。

### 3.2 配额机制支持哪些信息

【前端代码】模块 58259 对 quota 条目解析以下字段：

| 字段 | 客户端用途 |
|---|---|
| model_type | null 对应全部模式；非空对应指定模式 |
| is_exhausted | 判断匹配范围是否额度耗尽 |
| reset_at | 恢复时间，代码乘 1000 转成毫秒，原始字段按 Unix 秒处理 |
| msg | 显示额度提示 |
| alert | 可携带提示标题、描述、图片、按钮组和显示去重标识 |

这些字段来自前端支持的结构，本账号没有实际返回非空 quota 条目。客户端按 model_type 匹配，选择耗尽条目及相关恢复时间；不能从这段代码推导服务端的计费周期或额度计算方法。

【网络实测＋前端代码】状态响应头 `x-fetch-after-sec: 120` 指示下一次状态检查间隔，前端按它安排轮询，通常在页面可见时执行。120 秒是状态刷新间隔，不是配额恢复时间。代码在缺少有效间隔时使用约 300 秒的默认轮询间隔。

### 3.3 单条消息的编辑与重新生成限制

【网络实测】模式配置：edit_quota = 5，regenerate_quota = 5。

【前端代码】等价限制判断如下，省略了框架和本地消息过滤细节：

```text
siblings = 当前消息的有效同级分支
changedVersions = max(0, siblings.length - 1)
quota = 当前操作是编辑 ? edit_quota : regenerate_quota
reached = changedVersions >= quota
```

这是消息版本／分支数量限制，通常允许原版本之外追加 5 个编辑或重新生成版本。它不表示账号每天只能聊、编辑或生成 5 次。服务端是否实施完全相同的限制未通过耗尽测试确认。

### 3.4 其他账号状态

【网络实测】该账号还返回 minor_mode_status = NONE、need_birthday = false、is_mainland = true、status = 0。不能据此推导会员等级、免费额度或模型权限档位。用户资料响应还存在 token、email、mobile_number、id_profile 等敏感字段，项目日志应避免保留其值。

## 4. 模型模式、能力与隐藏配置

### 4.1 当前下发模式

【网络实测】scope=model 的配置版本为 105，model_configs 的配置 ID 为 1882712689。

| model_type | 名称 | is_default | enabled | switchable | show_model_name_in_session |
|---|---|---|---|---|---|
| default | 快速模式 | true | true | true | false |
| expert | 专家模式 | false | false | false | false |
| vision | 识图模式 | false | false | false | false |

【前端代码】模式选择器按 `enabled && switchable` 过滤，因此配置中存在的 expert、vision 当前不会作为可切换模式列出。会话顶部的模式名显示受 show_model_name_in_session 控制，本次三个模式均为 false。

这说明当前账号收到的配置包含未启用模式。不能证明修改本地开关就能获得服务端权限，也不能推断专家模式底层对应哪个模型。

default 的 file_feature.vision = true，表示快速模式的文件功能配置支持视觉。独立 vision 模式禁用与 default 支持图片是不同配置，二者可以同时成立。本次未实际上传图片验证视觉效果。

think_feature、search_feature、tts_feature 返回空对象。空对象不是 false；前端部分能力判断检查对象是否存在。但不能仅靠对象存在推导所有子功能、服务端权限或实际效果。

### 4.2 未显示的更新提示

【网络实测】scope=web_upgrade 的 value 提取如下：

```json
{
  "silent_refresh": false,
  "show_refresh_prompt": false,
  "force_refresh": false,
  "refresh_prompt_content": {
    "title": "🎉 新版本已上线",
    "body": "“专家模式”功能上新，刷新后即可体验。",
    "confirm_button_text": "立即刷新",
    "cancel_button_text": "稍后提醒"
  }
}
```

这是已经下发但当前未显示的文案。提示开关和 expert 启用标志都为 false，不能认定该账号已开放专家模式，也不能推导发布时间。

### 4.3 思考开关与具体模型版本

【网络实测】首轮普通测试请求 model_type=default、thinking_enabled=false，响应 model 字段为空字符串。

同一会话追加算术测试时，请求 model_type=null、parent_message_id=2、thinking_enabled=true；服务端 ready 事件返回 model_type=default，响应先有 THINK 片段，再有 RESPONSE，结果为 323，model 仍为空字符串。

因此，可确认思考开关生效，并且本次响应仍标记为 default 模式。不能确认开关前后底层模型是否相同，也没有证据确认 R1、V3 或其他权重版本。main 配置中出现名称含 r1 的字段，也不足以证明本次正在调用 R1。

## 5. 上下文、附件与输入预算

### 5.1 已下发的限制值

【网络实测】下列值是客户端配置，不是已经测出的模型物理边界。

| 配置路径 | 值 | 已知用途或范围 |
|---|---|---|
| model.input_character_limit | 2621440 | 输入字符限制配置；不是 token 数 |
| model.file_feature.token_limit | 890880 | 不开启思考时的预算配置 |
| model.file_feature.token_limit_with_thinking | 890880 | 开启思考时的预算配置 |
| main.normal_history_and_file_token_limit | 890880 | 名称指向普通路径的历史和文件预算 |
| main.r1_history_and_file_token_limit | 890880 | 名称指向 r1 路径的历史和文件预算 |
| model.file_feature.max_input_file_count | 20 | 文件数量配置 |
| model.file_feature.max_upload_file_size | 104857600 | 前端除以 1024²，显示为 100 MiB |
| model.file_feature.support_file_exts | 985 个列表项 | 图片、PDF、Office、文本和代码等扩展名列表 |

三个下发模式的上述数值相同，但 expert、vision 当前禁用。不能把禁用模式的配置当成可用权限。

【前端代码】预算读取器优先选择当前模式的 file_feature.token_limit 或 token_limit_with_thinking。无法取得相应模式／文件能力配置时，存在 61440 的回退预算。这个回退值不是当前账号正在使用的额度。

### 5.2 890880 实际怎样参与计算

【前端代码】主 bundle 的 class x3 实现 token 计数控制器：

```text
branchUsed = 选中父消息的 accumulatedTokenUsage；无父消息时取 0
fileUsed = 当前待发送附件各 serverInfo.tokenUsage 的总和
budget = 当前模式／思考状态对应的配置预算

combinedUsed = branchUsed + fileUsed
filesAllowed = budget - branchUsed
exceeded = uploadSupported AND combinedUsed > budget
```

serverInfo.tokenUsage 来源于文件解析数据的 token_usage；父消息的 accumulatedTokenUsage 来源于消息响应中的 accumulated_token_usage。

这比仅凭字段名更明确：前端把服务端回报的 accumulated_token_usage 当成当前分支已占用预算，而不是把它直接当作该条回答的输出 token 数。

已有聊天会减少新附件可用空间；不同分支按各自选中的父消息计数，不应把所有备选回答的累计值再相加。

这个具体检查主要服务于附件与现有分支预算，它没有在上述公式中直接加入当前新提问文本的 token 估计。输入字符限制、发送状态及后端限制是其他检查，不能把这个公式宣称为完整的服务端 prompt 长度计算。

### 5.3 超限提示与可阅读比例

【前端代码】部分多文件发送／编辑路径会在超限时禁止发送，并计算提示比例：

```text
remaining = budget - branchUsed
如果 remaining <= 0：提示删减内容或开启新对话
否则：百分比 = max(1, floor(remaining / fileUsed * 100))
提示“DeepSeek 只能阅读全部文件的 X%，请删减后发送”
```

提示用于说明超限和让用户调整文件。代码证据不证明服务端实际只读取文件前 X%，也不证明它自动进行了摘要或分块检索。

### 5.4 token 数值的解释边界

【网络实测】首轮测试历史中，用户消息 accumulated_token_usage=75，回答消息对应值为 78。前端代码确认它被用于分支预算；仍不能由这两个数值推导精确 tokenizer、系统提示词占用、思考 token 计入方式或计费规则。

890880 不是已确认的模型真实上下文窗口。真实模型限制可能还包含系统提示、工具结果、图片编码、输出预留和服务端内部处理，当前证据未说明这些如何计算。

## 6. 会话分支、历史保存与缓存策略

### 6.1 发送怎样关联上下文

【网络实测】completion 请求携带 chat_session_id、parent_message_id、prompt 和 ref_file_ids，没有重新上传完整历史消息数组。首轮父消息为 null，第二轮父消息为 2。

【前端代码】getCompletionReqParentId 沿当前选中的消息路径向前寻找有效父消息，跳过特定本地占位消息。消息具有 message_id、parent_id、childIds、currentChildIndex 等关系，界面维护分支选择。

由此可确认客户端按会话和父消息关联后续提问，历史保存在服务端。服务器实际怎样构造模型输入、是否只截取部分历史、是否加入隐藏提示，仍未知。

### 6.2 历史获取与本地缓存

【网络实测】刷新测试会话后，history_messages 返回已保存的问答、会话信息、cache_control=REPLACE 和 cache_reset_at。

【前端代码】请求可携带 cache_version、cache_reset_at。响应为 REPLACE 时替换客户端历史；为 MERGE 时将返回消息与已有缓存按 message_id 合并去重。前端通常使用 IndexedDB 缓存，有不可用时的回退路径。

REPLACE／MERGE 是客户端历史同步策略，不是模型记忆压缩或上下文截断策略。不能因为页面保留了旧消息，就认定模型每次读取所有旧消息。

### 6.3 两种独立的长会话限制

【前端代码】消息状态包括 CONTEXT_LENGTH_EXCEEDED，相关消息的重新生成功能会被禁止。归一化逻辑在缺少有效累计计数、且状态为超长时使用 Infinity 作为预算用尽的哨兵。

代码还处理 MAX_MESSAGE_COUNT_REACHED，提示“消息数量达到上限，请开启新对话”。错误枚举中的数值 3 是业务错误编号，不是允许三条消息。

因此存在按上下文长度与按消息数量处理的不同路径。没有测出服务端实际最大消息数、自动重置规则或截断阈值。

## 7. 网络接口与请求格式

### 7.1 已实际捕获的接口

以下路径相对 https://chat.deepseek.com，列出的核心请求均观察到 HTTP 200。

| 方法 | 路径 | 返回或用途 | 本次请求编号 |
|---|---|---|---|
| POST | /api/v0/users/oauth/get_token | 登录 token 和 user | 68 |
| GET | /api/v0/users/current | 当前账号资料、状态、部分额度字段 | 75、131 |
| POST | /api/v0/users/auth_token/check_device | 设备检查请求 | 79、141 |
| GET | /api/v0/client/settings | 按 main/model/provider/banner/web_upgrade scope 获取配置 | 80–83、127–130、191、193 |
| POST | /api/v0/chat_session/create | 请求体为空对象，返回会话及 ttl_seconds | 97 |
| GET | /api/v0/chat_session/fetch_page | 会话列表、has_more；本次首批 100 条 | 86、133 |
| GET | /api/v0/chat/status | generated_at、mute、quotas | 85、144、213 |
| POST | /api/v0/chat/create_pow_challenge | 获取指定路径的挑战 | 96、142、145 |
| POST | /api/v0/chat/completion | 发送消息，SSE 返回结果 | 104、233 |
| GET | /api/v0/chat/history_messages | 会话元信息与消息历史 | 136 |
| POST | /api/v0/telemetry | 遥测上报，实测体未按 JSON 展开 | 87、110 |
| POST | /api/v0/client/settings/report | 客户端配置报告 | 89、91、158 |

会话列表请求的观察 query 为 lte_cursor.pinned=false。settings 请求带 did 和 scope。请求编号仅用于关联本次采样，不是接口稳定标识。

【前端代码，未实测调用】另有 POST /api/v0/chat/regenerate、/chat/edit_message、/chat/continue、/chat/resume_stream。

普通响应具有 code/msg 与 data.biz_code/biz_msg/biz_data 两层状态包装，调用方不能只检查 HTTP 200。

### 7.2 首轮请求样本

【网络实测】脱敏样本：

```json
{
  "chat_session_id": "<SESSION_UUID>",
  "parent_message_id": null,
  "model_type": "default",
  "prompt": "这是一条 Network 接口分析测试消息，请只回复：测试成功。",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": true,
  "action": null,
  "preempt": false,
  "shumei_device_id": "<REDACTED>"
}
```

第二轮关键字段如下，其余身份字段省略：

```json
{
  "model_type": null,
  "parent_message_id": 2,
  "thinking_enabled": true,
  "search_enabled": true,
  "prompt": "模型配置测试：请计算 17×19，只需给出结果。"
}
```

【前端代码】preempt 可由请求父消息仍处于生成中的状态决定，涉及发送和生成并发处理；本次没有实测抢占行为。action 可能在编辑等路径中携带动作值，本次首轮为 null，其他值未确认。

### 7.3 认证与挑战

【网络实测】关键请求头如下：

```http
Authorization: Bearer <REDACTED>
Content-Type: application/json
x-ds-pow-response: <REDACTED>
x-device-id: <REDACTED>
x-device-model: <REDACTED>
x-client-bundle-id: <REDACTED>
x-client-platform: web
x-client-version: 2.8.0
x-client-locale: zh_CN
x-client-timezone-offset: 28800
```

网页登录 Bearer token 不能当作开放平台 API Key。网页 /api/v0/ 接口不能凭这次观察视为公开、稳定的集成 API。

PoW 请求体为 target_path=/api/v0/chat/completion。响应包含 algorithm、challenge、salt、signature、difficulty、expire_at、expire_after、target_path。实测 algorithm=DeepSeekHashV1、difficulty=144000、expire_after 原始值=300000；expire_after 单位和完整算法未独立验证。

网页正常获取和处理挑战，再随请求发送结果。配置 pow_prefetch=true、pow_prefetch_count=1，刷新后也观察到预取请求；不应假定挑战只在点击发送时创建。没有复用、伪造或绕过挑战。

## 8. SSE 增量协议、完成状态与恢复

### 8.1 实测协议

【网络实测】响应头包括 content-type=text/event-stream; charset=utf-8、cache-control=no-cache、x-ds-sse-heartbeat-timeout-secs=8，并包含追踪 ID。

首轮流中有 ready、update_session、普通 data 增量、title、close。关键片段如下，首次 response 对象已省略无关字段：

```text
event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}

data: {"v":{"response":{"message_id":2,"parent_id":1,"model":"","role":"ASSISTANT","status":"WIP","fragments":[{"id":2,"type":"RESPONSE","content":"测试","references":[],"stage_id":1}]}}}

data: {"p":"response/fragments/-1/content","o":"APPEND","v":"成功"}

data: {"v":"。"}

data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":78},{"p":"quasi_status","v":"FINISHED"}]}

data: {"p":"response/status","o":"SET","v":"FINISHED"}

event: title
data: {"content":"接口测试确认"}

event: close
data: {"click_behavior":"none","auto_resume":false}
```

### 8.2 省略字段的规则已由代码确认

【前端代码】class Eb 初始化操作为 SET、路径为空字符串。每次解析时，缺少 o 则继承前次操作，缺少 p 则继承前次路径。BATCH 的内部用新的解析器按顺序解析，再加上外部路径前缀。

因此样本中的只有 v 的句号增量会继承前面的 APPEND 和文本路径。这是已经由前端代码确认的行为，不再只是根据流样本推测。

协议还涉及数组尾部索引 -1、字符串追加、数组追加或插入、替换以及嵌套批量更新。实现时需要类型和路径检查，避免把所有 APPEND 都理解成字符串拼接。

消息正文包含 fragments，实测普通答复为 RESPONSE，思考测试有 THINK 后接 RESPONSE。流同时更新 token 使用量、状态、搜索状态、标题等，不只输出文字。

### 8.3 续写和断流恢复

【前端代码】continue 请求携带 chat_session_id、message_id 和 fallback_to_resume；resume_stream 请求关联原会话与消息。代码可以在继续操作中退回恢复已有消息，也可收到完整消息后替换／同步状态。

收到过增量、却没有正常 close 等情况下，客户端存在自动恢复路径。服务端返回完整消息、会话无效、HTTP 错误或用户取消等状态会影响是否继续恢复。没有实测所有触发条件或最大恢复次数。

【网络实测配置】completion/edit/regenerate/continue/resume 请求超时相关配置均为 60000 ms；auto_resume_request_timeout_ms 和 sse_auto_resume_timeout 为 3000 ms。这些是配置值，不应合并理解为所有请求三秒后重试。心跳响应头的 8 秒同样不能等同于总生成时间上限。

## 9. 搜索、文件和其他客户端策略

### 9.1 搜索选项与实际触发

【网络实测】首轮请求 search_enabled=true，响应 search_triggered=false。开启搜索选项不保证每次执行搜索。

main 配置：search_state_on_launch=on、search_state_on_login=on、search_state_on_automatically_created_chat=on、search_state_on_manually_created_chat=keep。allow_file_with_search=true，模式文件配置 conflict_with_search=false。

【前端代码】实际搜索启用还结合模式是否有 search_feature、附件状态与文件搜索冲突配置判断。代码包含“不支持与文件同时搜索”的其他路径，不能拿这些错误文案当成当前配置一定不支持。

provider 配置有电话邦 dhb、知乎 zhihu、同花顺 ths、同花顺 iFinD edb，priority 为 0、1、2、2，citation_dedupe_scope 均为 message。它们是来源品牌／引用配置，不证明每次搜索都访问这些服务。

### 9.2 文件处理配置

【网络实测】files_host=files.deepseeksvc.com，picture_compress_format=webp，photo_picker_compress_ratio=0.8，enable_thumbnail=true。

【前端代码】文件对象包含 file_size、status、retryable、audit_result、token_usage，图片还包含尺寸。存在解析状态轮询、失败重试和审核状态处理。预算用解析结果的 token_usage，不按文件字节数直接换算 token。本次没有实测上传流程。

### 9.3 辅助网络与遥测

【网络实测】gator.volces.com 的 webid/list/profile/list 多次返回 200；fp-it-acc.portal101.cn/deviceprofile/v4 返回 200。它们是标识、统计或设备 profile 相关流量线索，未解码核对全部内容。

hif-leim.deepseek.com/query 返回 200，hif-dliq.deepseek.com/query 多次出现 ERR_CONNECTION_CLOSED，未阻止测试答复完成和历史读取。其完整用途与失败原因未知。

登录页面曾出现 localhost.weixin.qq.com 端口探测失败和微信支持域名 ERR_BLOCKED_BY_ORB。不能据此认定聊天核心接口失效。

【网络实测配置】volcengine_enabled 是字符串 true；interaction_sample_rate=1；launch_clean_session_interval_seconds=21600。这些字段不证明模型部署在特定云平台，不证明会话六小时到期，也不能从采样配置单独判断具体收集了哪些数据。

【前端代码】telemetry 上报路径使用 application/octet-stream，并处理 x-request-encryption-key、x-ds-compression 等头部。这里的压缩是遥测传输处理，不是模型上下文压缩证据。

## 10. 尚未揭示的服务端内容

以下内容在当前响应和已检查的前端代码中未获得可核实答案：

- 具体模型权重名称、模型部署架构、实际 context window 和输出 token 上限。
- 系统提示词、temperature、top_p、其他采样或推理强度参数。
- 服务端是否进行自动摘要、如何丢弃旧消息、是否按位置截断、是否做附件检索或分块。
- 是否将思考片段、工具结果、图片编码计入同一累计量及其精确规则。
- 每日／每小时账户额度、计费周期、确切最大消息数量。
- PoW 完整实现、挑战到期字段单位以及服务端完整风控策略。

不要因为源码缺少某项逻辑就断言服务端没有该能力。不要用界面仍显示历史、累计 token 差值或模型自我介绍补足这些未知项。

## 11. 供项目 AI 参考的改造建议

本节全部属于【改造建议】，不是已经确认的 DeepSeek 服务端行为。先检查用户项目，再决定采用哪些设计。

### 11.1 区分两种集成方式

| 项目方式 | 推荐处理 |
|---|---|
| 模型服务维护会话上下文，客户端发送 session/parent 引用 | 以服务端会话状态、累计用量和恢复能力为准；避免重复上传完整历史 |
| 项目调用无状态模型 API，每轮自行提交 messages | 项目负责选取当前分支、组装历史、估算 token、预留输出空间及执行明确的截断／摘要策略 |

如果现有项目使用公开模型 API，优先保持公开 API 契约，不应为模仿网页而引入网页登录 token、网页 PoW 或私有路径。若项目本身就是网页适配器，则把这些变化封装在独立适配层，处理接口版本和失败反馈。

### 11.2 建立明确的能力与配置模型

分别维护 modeId、providerModelId、thinkingEnabled、searchPreferred、searchTriggered、enabled、switchable、visionSupported 和上下文预算。配置中的模式名称不能替代供应商真实模型 ID。

限制值应来自项目的模型配置、供应商文档或实际返回的能力，不照抄 890880、2621440、20、100 MiB 或 5。未知能力应使用显式未知状态，避免默认成无限额度或已启用。

### 11.3 上下文预算

将字符限制、输入 token、输出预留、文件大小、消息数量和账号额度拆成独立维度。对无状态 API，建议建立如下预算模型：

```text
modelContextLimit = 已确认的供应商模型上下文限制
reservedOutput = 本项目预计或允许的输出预算
safetyMargin = tokenizer 差异等安全余量
inputCapacity = modelContextLimit - reservedOutput - safetyMargin

usedInput = 系统提示 + 选中分支历史 + 当前提问 + 工具结果 + 附件实际选入内容
remaining = inputCapacity - usedInput
```

这是推荐设计，不是 DeepSeek 已披露的公式。图片、音频等应采用相应供应商计量规则；用附件解析或选入片段的 token 数，不仅按字节大小估算。

使用服务端累计量时，应记录来源和统计口径，避免再加上已经包含的历史／附件造成重复计数。数值未知时不要悄悄当成 0；可采用估计值并标明。

### 11.4 超限时采取明确策略

项目可根据需求选择拒绝并提示、让用户删减、按相关性检索附件片段、摘要旧历史或开启新会话。不要无提示地只读取前一部分文件。

如果引入摘要：保留原始历史，单独保存摘要及其覆盖范围；保留用户约束和关键事实；记录摘要版本和生成时点；在新请求中明确使用哪份摘要。自动摘要是项目新设计，不能写成已验证的 DeepSeek 策略。

如果引入附件检索：记录实际选入的片段、来源及预算，不把整文件 token 用量和已选入片段量混算；不要向用户声称已完整阅读被省略内容。

### 11.5 消息分支与版本

维护稳定消息 ID、parentId、选中子分支和消息状态。生成新请求时从选中叶节点回溯祖先路径，不把所有重生成候选合并进上下文。

编辑与重新生成应创建可回溯版本。版本次数限制与账户日额度独立表示；如果项目需要限制，应说明限制范围和恢复方式。

### 11.6 账号额度状态

区分未提供配额、可用、耗尽、限流、禁言和认证失效。配额条目支持全局与模型范围，并分别处理 resetAt、说明和提醒。

不要把空数组显示成“无限”，不要把模式配置中的 editQuota 显示成“今日剩余次数”。轮询间隔可采纳服务端返回值并设置合理上下界；恢复时间与轮询时间分别存储。

### 11.7 SSE 适配、恢复和幂等

将传输解析、供应商增量协议和应用消息状态分开。如果适配本报告中的协议，必须处理 SSE 跨网络块缓冲、事件边界、UTF-8、p/o 继承、BATCH 路径、数组索引及操作类型。

普通 OpenAI 风格或其他供应商流不要误套 DeepSeek 的 p/o/v 协议，应各自实现适配器。

取消、完成、超时、断连和业务失败分别处理。恢复请求应关联原消息；重试不重复创建用户消息，不重复扣费或重复追加已收到文字。优先使用服务端幂等键、消息版本、游标或完整消息同步能力；没有这些能力时，明确限制自动重放。

继续生成和恢复原输出要有不同操作语义，保留已经收到的内容与状态。重试次数、退避、时间窗口和用户取消应明确受控，避免无限恢复。

### 11.8 可观测性与敏感数据

建议记录 provider/mode/model、上下文预算来源、估计或实际用量、选中分支、附件选入量、搜索实际触发、首次增量时间、完成原因、恢复次数和业务错误码。

访问令牌、Cookie、设备指纹、手机号、邮箱、原始文件全文和用户完整历史应采用按需脱敏与最少保存。追踪 ID 可以用于故障关联，但不替代业务状态判断。

## 12. 给负责改项目的 AI 的工作说明

以下内容可直接作为后续任务说明，结合用户原本的项目目标使用：

> 请先阅读项目已有说明与代码，确认项目使用的模型供应商、会话维护方式、消息结构、token 计量和流式协议。把本报告当作参考案例，区分网络实测、客户端源码行为和本报告的建议。优先修复项目实际存在的问题：上下文重复计数、混入其他分支、把未知配额当无限、将模式标签当模型版本、超限无提示、断流重试重复创建消息，以及流式状态不同步。依据项目供应商的真实限制配置预算；不要硬编码本报告中的 DeepSeek 数值。若需加入摘要、检索或截断，请给出明确策略、数据保留方式和验证方法，并说明这些属于项目新实现。最后汇报修改文件、行为变化、验证结果与仍依赖供应商的未知项。

建议完成项目检查后形成以下对应表：

| 检查项 | 当前项目实现 | 发现的问题 | 拟修改位置 | 验证方式 |
|---|---|---|---|---|
| 模式与真实模型 ID | 待检查 | 待确认 | 待定位 | 能力映射与配置检查 |
| 分支选择与历史构造 | 待检查 | 待确认 | 待定位 | 编辑／重生成后只使用选中路径 |
| token 预算与输出预留 | 待检查 | 待确认 | 待定位 | 边界输入与附件组合 |
| 配额未知／耗尽／恢复 | 待检查 | 待确认 | 待定位 | 空数组、全局及模型级条目 |
| SSE 状态更新 | 待检查 | 待确认 | 待定位 | 实际供应商协议的分块、批量、完成事件 |
| 取消与断流恢复 | 待检查 | 待确认 | 待定位 | 部分输出后断连，不重复消息或文字 |

可按项目实际改动选择必要验证，不要求为了照搬案例而重写现有架构。

## 13. 验证重点与结论边界

下列场景可作为项目改造后的验证参考：

- 已用历史增加时，新附件剩余预算相应减少；不会把累计量重复相加。
- 切换分支后，历史与预算均跟随选中分支。
- 当前提问、系统提示、工具内容和输出预留是否被纳入项目自己的完整计量。
- 超限、未知配额、耗尽和恢复时间各有正确反馈。
- 编辑／重生成限制不会被误表示为每日聊天额度。
- SSE 单个 JSON 或中文字符跨网络块时仍能正确解析；目标协议的省略字段和批量更新行为正确。
- 断流恢复、完整消息同步和取消不会重复追加或覆盖错误消息。
- 模型模式禁用、配置缺失和实际模型名未知时，界面和调用均不会虚报能力。

本报告没有验证 DeepSeek 服务端极限，也没有修改用户项目。它提供可核实的网页客户端机制与供下游 AI 落地的设计参考。

## 14. 证据索引

网络编号对应本次捕获会话，不可在新的浏览器会话中直接复用。

| 主题 | 网络证据 | 前端代码定位关键词 |
|---|---|---|
| 账号状态与配额 | 75、131、200、213 | 模块 58259、is_exhausted、reset_at、x-fetch-after-sec |
| 模式与限制配置 | 81、191 | model_configs、enabled、switchable、show_model_name_in_session |
| 未显示更新提示 | 82、193 | web_upgrade、refresh_prompt_content |
| 普通测试 | 104；历史 136 | accumulated_token_usage、fragments |
| 思考测试 | 233 | thinking_enabled、THINK、RESPONSE |
| 上下文与附件预算 | main/model 配置；历史 136 | class x3、useBranchUsedTokenCount、useMaxTokenNewFilesAllowed、getFilesTokenCount |
| 版本次数限制 | 模式配置 | getMessageBranchSiblings、max(0, count - 1)、edit_quota、regenerate_quota |
| 增量协议 | 104、233 | class Eb、class x6、APPEND、SET、BATCH |
| 会话父消息与缓存 | 136 | getCompletionReqParentId、cache_version、cache_control、REPLACE、MERGE |
| 长度和数量上限 | 未实测触发 | CONTEXT_LENGTH_EXCEEDED、MAX_MESSAGE_COUNT_REACHED |
| 生成恢复 | 未实测触发 | resume_stream、fallback_to_resume、autoResume |

主代码来源：[main.c918de4e90.js](https://fe-static.deepseek.com/chat/static/main.c918de4e90.js)。文件内容／构建名可能随网站更新变化，本报告依据的是本次加载版本。

本报告已合并此前两份阶段报告，并纳入后续代码检查得到的更明确结论：累计 token 的前端预算用途、5 次限制的分支作用域、p/o 省略字段继承规则、上下文超长与消息数量上限的区别。发生理解差异时，以本报告的证据标签和更新后的说明为准。
