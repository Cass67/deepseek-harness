# Agent Note: 通过 SDK 提供供应商原生认证

Status: implemented

[English](2026-08-18-provider-native-authentication.md) | 中文

## Problem

SDK 目录可以描述供应商路由，但进程外客户端无法为其完成认证。API 密钥必须在启动前存在，而 OpenAI Codex、Anthropic、GitHub Copilot、Kimi、OpenRouter 和 xAI 等订阅供应商无法运行各自的 OAuth 或设备流程。在每个界面重新实现这些协议，会重复回调、挑战、轮询、交换和刷新逻辑，同时扩大秘密暴露面。

## Decision

LLM seam 持有供应商中立的认证词汇：不含秘密的方法和状态元数据、文本/秘密/选择/手动代码提示、进度与授权事件、登录和登出。pi-ai 适配器通过 `Models.login`、`Models.checkAuth` 和 `Models.logout` 实现该词汇；供应商特有的 OAuth 协议仍完全由 pi-ai 持有。

每个 pi-ai `Models` 快照共享同一个按供应商分区的持久凭证存储。其路径依次取 `DSH_PI_AI_AUTH_PATH`、`$DSH_HOME/pi-ai-auth.json`、`~/.dsh/pi-ai-auth.json`。存储严格验证 JSON 凭证，要求直接父目录和文件权限分别为 `0700` 与 `0600`，并在 `dsh-atomic-write` 的同级锁与原子重命名下执行跨进程读改写。供应商原生 OAuth 刷新因此更新同一存储，不与快照或进程生命周期耦合。

显式声明 `apiKeyEnv` 的配置继续遵守原有的“引用缺失即明确失败”约定，并且不提供原生登录。未声明该字段的配置可以使用已安装供应商提供的环境、已存 API 密钥或 OAuth 方法。OpenAI API 访问与 OpenAI Codex 订阅访问保持为两条路由，因为它们使用不同端点和认证产品。

## SDK flow contract

`provider/authStart` 在供应商工作完成前返回不透明流程 id。相关通知携带不含秘密的事件、提示、提示结算和唯一终态。`provider/authRespond` 采用首个响应获胜语义，绝不回显提交值。`provider/authCancel` 中止供应商工作及所有待处理提示。服务器关闭会中止全部流程，并在传输关闭前等待任务结束。

提示级中止处理 OAuth 回调竞争：浏览器回调获胜时，供应商中止手动代码提示，服务器发出 `promptResolved`。迟到或重复响应不能进入其他提示或流程。错误通知只携带通用失败消息，不携带可能包含令牌响应数据的供应商异常。

TypeScript 和 Python 客户端在运行时验证全部请求结果和通知结构。秘密只存在于提示响应请求和持久凭证文件中；它们不会进入会话事件、对话文本、日志、状态元数据或终端通知。

## Alternatives considered

**通过 `apiKeyEnv` 存储所有密钥。** 该方案支持静态 API 密钥，但无法表示可刷新的 OAuth 凭证或供应商作用域字段，也会绕过供应商库的加锁刷新约定。

**在 TUI 或 SDK 服务器实现 OAuth。** 未采用，因为回调端口、PKCE、设备轮询、令牌交换与刷新行为因供应商而异，并且已经归 pi-ai 所有。复制这些逻辑会造成协议漂移并增加秘密处理代码。

**直接复用 Pi coding-agent 的 `auth.json`。** 未采用，因为 DeepSeek Harness 不应依赖另一个应用包或其配置目录。凭证结构可以兼容，但存储所有权和路径选择仍是 Harness 部署决策。

**返回阻塞式登录 RPC。** 未采用，因为登录活动期间客户端必须回答中间提示，并观察设备或浏览器指令。异步、服务器持有的流程为取消和关闭提供明确所有权。

## Consequences

客户端可以从供应商选择器连接 API 密钥和订阅供应商，包括浏览器回调、设备代码与手动挑战流程。凭证跨重启保留，并可在模型快照之间安全刷新。代价是增加五个认证 RPC 方法、四类通知、Python 对等实现，以及一个同一 OS 用户下其他进程仍可读取的用户私有 JSON 文件；OS keychain 集成延后。

聚焦测试覆盖存储验证、权限与并发修改；适配器方法/状态/登录/登出委托；SDK 关联、秘密不回显、取消、提示中止、关闭静默与畸形载荷拒绝；Python 验证；以及 TUI 遮罩和 URL scheme 验证。
