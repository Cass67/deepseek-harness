# @deepseek-ai/dsh-sdk-jsonrpc-server

[English](README.md) | 中文

`jsonrpc` 插件通过 stdio 提供以换行符分隔的 JSON-RPC，使进程外 SDK 客户端能够驱动 harness agent（智能体）。[`HarnessSdkJsonRpcServer`](src/server.ts) 负责协议方法和通知；传输与具名协议类型位于 [`dsh-sdk-protocol`](../protocol/README.md)，与客户端 SDK 共享；[`jsonrpc-demo`](../../examples/jsonrpc-demo/README.md) 提供外围的 `cordis.yml` 应用。

## 组装

`inject: ['agents']`；附件、LLM、命令、会话查询、批准和用户问题服务作为可选能力读取。服务器按 `sessionId` 获取或创建一个 agent。只有服务对生命周期建立快照时记录的 `local` 标志为 true，服务器才会转发 subagent 完成事件；提供方名称、子级 id 和持久化谱系均不能证明本地性。已注册的适配器优先；尚无适配器负责的 `deepseek-official` 路由会挂载 `dsh-llm-deepseek`，任何其他尚无适配器负责的提供方都会导致初始化失败。其他能力由外围 `cordis.yml` 提供。

## 配置

`maxTokensAsSuccess` 默认为 `false`，且只影响 `subagent.finished` 上由部署映射的状态；根会话提示词没有提示词级状态。`JsonRpcConfig.input`、`output` 和 `exit` 是仅供运行时使用的传输钩子；生产环境使用进程 stdio 和 `process.exit`。

## stdout 即协议

Stdout 只承载 JSON-RPC 帧。部署不得组合 stdout logger；诊断应写入 stderr。

## 关闭与退出语义

插件响应 `shutdown`，刷新响应并 dispose（资源释放）根上下文，使 SDK 持有的 agent、订阅和持久化达到完全停稳，然后以代码 0 退出。EOF 和信号退出由 app bin 处理，后者也会 dispose 根上下文。仅卸载此插件会停止服务，但不会退出进程。

## 协议说明

Provider 认证方法只暴露无秘密状态。`provider/authStart` 在 provider 工作完成前返回不透明 flow ID；服务器负责 prompt 关联、单 prompt 中止、整个 flow 取消、每个 provider 只允许一个活动 flow，以及关机停稳。提交值绝不会复制到通知或诊断中；终态失败只使用通用消息。`attachment/imageLimits` 返回当前附件服务策略。`attachment/saveImage` 只接受精确的上传字段、服务支持的媒体类型、可选字符串名称和非空、规范且带填充的 base64；编码字符串超过当前字节限制时会在解码前被拒绝，之后验证过的字节交给 `ctx.attachments.saveImage`。未组合附件服务时，这两个方法都会明确失败。`initialize.serverInfo.name` 的协议稳定值为 `deepseek-harness-sdk-runtime`。可选的正整数 `initialize.maxTokens` 会成为每个 SDK 创建的 agent 及其进程内后代的请求输出上限；非法值会使初始化失败，省略时则不发送 SDK 上限，并应用所选适配器或提供方路由的默认值。`session/prompt` 将一条带标识的用户消息排入队列，并立即返回 `{ messageId }`。服务器将每个持久事实作为 `session.event` 流式发出，并将整个 agent 生命周期的每次状态转换作为 `session.status` 发出；它不会把某条助手消息或 `turn/end` 归属于该提示词。同一会话上的独立请求可以继续排入更多工作。`llm/catalog` 独立列出每个已注册提供方，解析每个已列出模型由适配器定义的推理强度，并在健康分组旁报告失败的模型查询或精确解析。`session/selectModel` 通过 `ctx.llm.resolveCallConfig` 校验；共享的 agent 作用域选择会在 step 组装时建立快照，因此不会拆分一个运行中的 step，普通请求 header 会记录每个已应用路由。`session/cancel` 调用 `Agent.cancel({ kind: 'user' }, { keepInbox: true })`，并在 idle 收敛前返回。`session/close` 会中止并结算活动命令分派，再等待服务器持有的 handle 完全释放，之后才允许干净重建。`command/list` 与 `command/execute` 使用 `ctx.commands`；能力缺失与未知命令行返回结构化结果，已准入命令只生成命令生命周期事件，不产生模型可见用户消息。`session/list` 与 `session/history` 使用 `ctx.sessionQuery` 且不获取 agent；`session/resume` 显式调用 `ctx.agents.resume` 并恢复最新记录的路由。批准和用户问题请求成为 `interaction.requested` 通知；`interaction/respond` 在首个有效响应取得等待项前校验关联关系和确切问题选项。取消、会话关闭和服务器释放都会结算待处理交互。持久化根目录和 persona 由 `cordis.yml` 提供。

## 模型体验

### SDK 用户消息

#### 模型看到的内容

对于每个已接受的 `session/prompt`，对话模型会将调用方提供的 `contentBlocks` 原样作为该 SDK 会话中的一条用户消息接收；通过 `attachment/saveImage` 上传的图像只有在返回的引用出现在图像块中时才会对模型可见。此包不会添加系统提示词文本或工具 schema；这些内容来自外围 `cordis.yml` 中的插件。

#### Token 影响

依数据而定的用户消息 token 会进入保留的会话历史，并在后续轮次中重复发送，直至另一个包将其压缩（compaction）。JSON-RPC 帧、会话通知和服务器内部记录不会增加模型上下文 token。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **无法恢复由 preset 支持的会话**：此运行时不会组合已记录的 preset，因此会在发布 agent 前拒绝持久化 `agentPreset`。
- **取消以会话活动而非提示词为作用域**：回执既不标识提示词，也不等待 idle；客户端观察整个 agent 的状态与持久事件。
- **没有逐提示词结果**：`MessageId` 只标识 inbox 准入；拥有自动化活动区间的客户端必须自行定义并观察该区间。
- **stdout 纯净性由部署保证**：外围配置仍可能加载 stdout logger 并破坏 JSON-RPC 通道；此插件不会检查或否决同级 logger。
- **自动挂载适配器仅支持 DeepSeek**：`initialize` 可以复用任何预先注册的模型适配器，但唯一的回退行为是挂载 `dsh-llm-deepseek`。
