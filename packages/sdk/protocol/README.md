# @deepseek-ai/dsh-sdk-protocol

English | [中文](README.zh.md)

The shared wire protocol for the DeepSeek Harness SDK runtime: one newline-delimited JSON-RPC 2.0 transport class plus the named request, result, and notification types both wire ends speak. The package root enumerates the protocol consumer interface; source modules are not exported as deep imports. The server side is the [`dsh-sdk-jsonrpc-server`](../server/README.md) plugin; clients are [`dsh-sdk-client`](../client/README.md) (TypeScript) and the [Python SDK](../../../python/README.md) (which mirrors these shapes but does not import them). A pure library — no plugin, no Config, no registration.

## Transport

`JsonRpcLineTransport` frames JSON-RPC 2.0 over caller-owned byte streams, one compact JSON frame per `\n`-terminated line. Frames with `id` and `method` are requests, `id` alone is a response, `method` alone is a notification; malformed JSON lines are ignored. `start()` attaches stream listeners, `close()` detaches them and rejects pending requests without destroying the streams. Missing request handlers answer `-32601`; handler rejections answer `-32603` with the error message. An error response rejects the pending `request()` with `JsonRpcResponseError`, which preserves the wire `code` and optional `data`. `JsonRpcTransportPeer` is the outbound surface (request/notify) the server class is typed against.

## Wire types

`types.ts` names every payload of the protocol served by `HarnessSdkJsonRpcServer`:

| Direction | Method | Types |
|---|---|---|
| client→server | `initialize` | `InitializeParams` → `InitializeResult` |
| client→server | `llm/catalog` | no params → `ModelCatalogResult` (healthy provider groups plus independent failures) |
| client→server | `provider/authInfo` | `ProviderAuthInfoParams` → `ProviderAuthInfoResult` (non-secret methods/status) |
| client→server | `provider/authStart` / `provider/authRespond` / `provider/authCancel` / `provider/authLogout` | asynchronous provider-native authentication controls |
| client→server | `attachment/imageLimits` | no params → `AttachmentImageLimitsResult` |
| client→server | `attachment/saveImage` | `AttachmentSaveImageParams` → `AttachmentSaveImageResult` |
| client→server | `session/prompt` | `SessionPromptParams` → `SessionPromptResult` (durable enqueue receipt) |
| client→server | `session/list` | no params → `SessionListResult` |
| client→server | `session/history` | `SessionControlParams` → `SessionHistoryResult` |
| client→server | `session/resume` | `SessionControlParams` → `SessionResumeResult` |
| client→server | `session/selectModel` | `SessionSelectModelParams` → `SessionSelectModelResult` |
| client→server | `session/cancel` | `SessionControlParams` → `SessionCancelResult` |
| client→server | `session/close` | `SessionControlParams` → `SessionCloseResult` |
| client→server | `command/list` | `SessionControlParams` → `CommandListResult` |
| client→server | `command/execute` | `CommandExecuteParams` → `CommandExecuteResult` |
| client→server | `interaction/respond` | `InteractionRespondParams` → `InteractionRespondResult` |
| client→server | `shutdown` | no params → `{}` |
| server→client | `session.event` | `SessionEventNotification` (every session in the runtime, unfiltered) |
| server→client | `session.status` | `SessionStatusNotification` (whole-agent `running`/`idle` transition) |
| server→client | `interaction.requested` | `InteractionRequestedNotification` (approval or user-question request) |
| server→client | `interaction.resolved` | `InteractionResolvedNotification` |
| server→client | `provider.auth.event` / `provider.auth.prompt` / `provider.auth.promptResolved` / `provider.auth.finished` | correlated provider-native authentication flow |
| server→client | `subagent.started` | `SubagentStartedNotification` |
| server→client | `subagent.finished` | `SubagentFinishedNotification` (in-process runs only) |

`HarnessSdkRequestMap` and `HarnessSdkNotificationMap` index these by method name. Provider authentication starts asynchronously and returns an opaque flow id immediately. Prompt ids are first-response-wins; cancellation aborts the complete flow; prompt-resolved and finished notifications let clients discard stale UI. Events carry only URLs, device codes, instructions, and progress—submitted API keys and manual codes are request-only values and are never echoed. Image uploads carry non-empty canonical padded base64 plus a declared supported media type and optional display name; the server bounds the encoded string from the active `maxImageBytes` before decoding, rejects noncanonical encodings, and returns a durable `ImageAttachmentRef`. Session listing and history read the live-preferred logical corpus through `ctx.sessionQuery`; history never resumes an agent, while `session/resume` explicitly rebuilds one through `ctx.agents.resume` and preserves its latest logged model route. Interaction requests use stable request ids, validate answers against the exact pending question, settle on cancellation or server disposal, and remove the pending entry before resolution so the first valid response wins. Catalog provider lookups settle independently, so `ModelCatalogResult.failures` does not remove healthy `providers`; each listed model includes adapter-owned reasoning efforts and its configured default when exact resolution exposes them. Model selection applies at the next step assembly boundary and later appears in ordinary `request/header` events. Cancellation acknowledges only whether running activity received a request; clients observe later idle convergence through `session.status`, and queued inbox work remains queued. Session close returns only after the SDK-owned agent reaches quiescence. Command capability absence and unknown command lines are structured results; command execution uses the Harness command registry and never implicitly sends a user message to the model. `SessionPromptResult.messageId` identifies the queued `UserMessage`; it does not identify a later assistant message, turn ending, or prompt result. Clients combine the open-ended `session.event` stream with agent-wide `session.status` according to their own activity ownership. `SubagentFinishedNotification.lastAssistantMessage` contains the child's last non-empty assistant message or, when no such message exists, its accumulated assistant text; the field is absent when the child produced neither. `InitializeParams.maxTokens` is an optional positive safe integer that caps each conversation-model output for SDK-created agents and their in-process descendants; omission allows the selected adapter's exact-model default to apply, or otherwise preserves provider behavior. The notification payload types depend on `SessionEvent` (`dsh-session`), `ContentBlock` (`dsh-llm`), and `SubagentStopReason` (`dsh-subagent`) — the protocol streams full session-log envelopes, so the session vocabulary is part of the wire contract. `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.

## Model Experience

None, as this package defines the client-facing wire protocol; the model-visible surfaces belong to the runtime plugins composed behind the serving [`dsh-sdk-jsonrpc-server`](../server/README.md) entry.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No protocol-version negotiation** — the handshake carries only `serverInfo.version` (`0.0.1`, unvalidated by clients); pre-release stance, no compatibility promise.
- **Interactions use notifications plus correlated responses** — the server does not issue bidirectional JSON-RPC requests; `interaction.requested` carries a stable id answered through `interaction/respond`.
