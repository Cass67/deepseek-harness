# Agent Note: SDK JSON-RPC 公开交互式会话控制

Status: implemented

[English](2026-08-17-sdk-interactive-session-controls.md) | 中文

## 问题

SDK JSON-RPC 运行时能够接收提示词并流式发送生命周期事件，但交互式客户端无法发现模型路由、修改实时会话后续请求、取消当前活动、关闭单个会话或调用人类命令。否则 TUI 调用方只能替换整个进程、硬编码目录，或把 slash command 作为模型可见用户消息提交。

这些控制必须保留现有归属规则：模型切换不能把同一个 step 的提示词组装与请求路由拆开；取消回执不能伪装成 idle 收敛；资源释放必须等待完全停稳；命令分派必须使用现有注册表与持久命令生命周期。

## 决策

共享协议、JSON-RPC 服务器、TypeScript 客户端与 Python 客户端公开提供方／模型目录、会话模型选择、会话取消、会话关闭、命令列表与命令执行。具名客户端方法会在返回前对每项响应做运行时校验；Python 发布对应 Pydantic 模型。

`llm/catalog` 调用 `ctx.llm.listProviders()`，并独立结算每个提供方。每个已列出模型都通过 `ctx.llm.resolveModelInfo()` 解析，使健康分组保留 id、显示名称、描述、已声明输入模态、由适配器定义的推理强度及其配置默认值；失败的列表查询或精确解析进入 `failures`，不会移除其他健康分组。

每个 SDK 创建的 agent 会在未发布 setup 阶段安装核心 `installModelSelection()` listener。`session/selectModel` 会在通过 `ctx.llm.resolveCallConfig()` 异步校验前预留会话，使并发关闭获胜且不会复活会话，并修改可变选择，而不是固定的 `Agent.options`。提示词组装会捕获供请求路由使用的一份选择，因此并发变化只在后续 step 生效。普通 `request/header` 快照会在 loop 使用路由时记录它，并让会话日志可以重建活动路由。

`session/cancel` 只为运行中活动调用 `Agent.cancel({ kind: 'user' }, { keepInbox: true })`，并立即报告是否请求取消。`session.status` 继续作为 idle 收敛信号。`session/close` 会合并并发关闭归属，在资源释放期间拒绝创建，中止并结算活动命令分派，删除服务器记录，并等待自有 `AgentHandle.dispose()`，之后才允许干净创建。

Provider 原生认证同样属于控制面，而不是会话内容。`ctx.llm` 暴露无秘密的方法/状态以及登录/登出；SDK 服务器持有异步 flow/prompt 关联，并把实际 API key/OAuth 协议、回调服务器、设备轮询、token 交换与刷新委托给适配器。提交的秘密和手动代码只存在于响应中。Flow 事件、prompt 解析、完成、取消与关机都有关联，且不写会话事件。

`command/list` 与 `command/execute` 读取可选 `ctx.commands` 服务。列表返回有效作用域描述符。执行会把完整 slash-command 行传给注册表，并返回结构化成功、命令错误、未知命令或能力不可用结果。注册表执行追加 `command/run` 与 `command/done`；服务器绝不会把命令输入或结果文本转换成用户消息。

## 验证

服务器测试覆盖认证 flow 关联、prompt 首响应获胜、无秘密通知、精确推理元数据、部分目录失败、路由应用与已记录请求 header、选择与关闭的归属竞争、活动取消与保留 inbox、关闭归属与重建、非法 wire 参数、命令发现与执行，以及能力缺失。TypeScript 子进程测试与 Python 客户端测试覆盖每个具名方法及非法响应。无密钥 SDK 快照覆盖组装后的 JSON-RPC 运行时，并证明选择会在 `request/header` 中替换初始路由；Python 构建产物可用时，单可执行文件快照会投影这些控制项。

## 曾考虑的替代方案

**选择时修改 `Agent.options`。** Agent options 是固定创建输入，无法把提示词变量与请求路由耦合。现有模型选择机制提供所需的逐 step 快照。

**在取消响应中等待 idle。** 取消与完全停稳是正交生命周期事实，已排队工作可能在被取消活动之后继续。现有状态通知继续承担收敛通道。

**关闭整个运行时来结束一个会话。** 进程资源释放可以完全停稳，但会丢弃无关会话，并阻止交互式复用。服务器已经为每个 SDK 会话持有准确 handle。

**通过 `session/prompt` 发送 slash-command 文本。** 这样会让命令变得模型可见，并绕过命令发现、作用域遮蔽、命令 handler 与持久命令生命周期事件。

**一个提供方失败时让完整目录失败。** 独立 adapter 可能具有独立网络或配置故障；隐藏健康路由会使交互式恢复无法进行。

## 后果

TUI 可以配置 API key 和 provider 订阅 OAuth，而不会把凭据放入 composer、对话记录或会话日志。适配器的所有者私有原子凭据存储跨重启保留 refresh token，而显式 `apiKeyEnv` profile 继续保持具名引用缺失即失败语义。

TUI 可以在一个长期运行的 SDK 运行时中完成模型变化、取消、会话资源释放与直接命令，无需建立并行注册表或生命周期状态。模型路由变化保持 step 原子性，并可通过普通请求 header 重建；命令效果保持持久，但不进入模型历史。

取消继续控制整个 agent 活动，而不是产生提示词自有结果。目录成员关系仍是建议性信息：目录展示与选择校验都会向拥有该路由的 adapter 查询准确元数据，选择器值继续由 adapter 定义，而不会成为协议枚举。关闭会话只移除实时 SDK 归属；持久化 resume 与 history 不在本切片内。命令执行没有协议取消 token，因此在后续交互协议负责请求作用域中止前，handler 取消仍局限于运行时资源释放。
