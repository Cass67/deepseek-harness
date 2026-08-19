# @deepseek-ai/dsh-sdk-jsonrpc-server

English | [中文](README.zh.md)

The `jsonrpc` plugin serves newline-delimited JSON-RPC over stdio so out-of-process SDK clients can drive harness agents. [`HarnessSdkJsonRpcServer`](src/server.ts) owns the protocol methods and notifications; the transport and the named wire types live in [`dsh-sdk-protocol`](../protocol/README.md), shared with the client SDKs; [`jsonrpc-demo`](../../examples/jsonrpc-demo/README.md) supplies the surrounding `cordis.yml` application.

## Wiring

`inject: ['agents']`; attachment, LLM, command, session-query, approval, and user-question services are read as optional capabilities. The server gets or creates one agent per `sessionId`. It forwards subagent completions only when the service-snapshotted lifecycle `local` flag is true; provider names, child ids, and durable lineage never establish locality. A registered adapter wins, an unowned `deepseek-official` route mounts `dsh-llm-deepseek`, and any other unowned provider fails initialization. Other capabilities come from the surrounding `cordis.yml`.

## Config

`maxTokensAsSuccess` defaults to `false` and affects only the deployment-mapped status on `subagent.finished`; root-session prompts have no prompt-level status. `JsonRpcConfig.input`, `output`, and `exit` are runtime-only transport hooks; production uses process stdio and `process.exit`.

## stdout is the protocol

Stdout carries only JSON-RPC frames. The deployment must not compose a stdout logger; diagnostics belong on stderr.

## Shutdown and exit semantics

The plugin answers `shutdown`, flushes the response, disposes the root context so SDK-owned agents, subscriptions, and persistence reach quiescence, then exits with code 0. EOF and signal exits belong to the app bin, which also disposes the root context. Unloading only this plugin stops serving without exiting the process.

## Wire notes

Provider auth methods expose only non-secret status. `provider/authStart` returns an opaque flow id before provider work completes; the server owns prompt correlation, per-prompt abort, whole-flow cancellation, one active flow per provider, and shutdown quiescence. Submitted values are never copied into notifications or diagnostics; terminal failures use a generic message. `attachment/imageLimits` returns the active attachment service policy. `attachment/saveImage` accepts only exact upload fields, a service-supported media type, an optional string name, and non-empty canonical padded base64; it rejects an encoded string beyond the active byte limit before decoding, then delegates verified bytes to `ctx.attachments.saveImage`. Both methods fail clearly when no attachment service is composed. `initialize.serverInfo.name` is the wire-stable `deepseek-harness-sdk-runtime`. An optional positive `initialize.maxTokens` becomes the request output cap of each SDK-created agent and its in-process descendants; invalid values reject initialization, while omission sends no SDK cap and allows the selected adapter or provider route default to apply. `session/prompt` queues one identified user message and immediately returns `{ messageId }`. The server streams every durable fact as `session.event` and every whole-agent lifecycle transition as `session.status`; it does not assign an assistant message or `turn/end` to that prompt. Independent requests may enqueue more work on the same session. `llm/catalog` lists every registered provider independently, resolves each listed model's adapter-owned reasoning efforts, and reports failed model listings or exact resolution beside healthy groups. `session/selectModel` validates through `ctx.llm.resolveCallConfig`; the shared agent-scoped selection snapshots at step assembly, so it cannot split one running step, and ordinary request headers log each applied route. `session/cancel` calls `Agent.cancel({ kind: 'user' }, { keepInbox: true })` and returns before idle convergence. `session/close` aborts and settles active command dispatches, then awaits the server-owned handle's disposal before permitting clean recreation. `command/list` and `command/execute` use `ctx.commands`; absent capability and unknown lines return structured outcomes, while admitted commands produce command lifecycle events without a model-visible user message. `session/list` and `session/history` use `ctx.sessionQuery` without acquiring an agent; `session/resume` is an explicit `ctx.agents.resume` operation that restores the latest logged route. Approval and user-question requests become `interaction.requested` notifications, and `interaction/respond` validates correlation and exact question choices before the first valid response claims the wait. Cancellation, session closure, and server disposal settle pending interactions. Persistence roots and persona come from `cordis.yml`.

## Model Experience

### SDK user message

#### What the model sees

For each accepted `session/prompt`, the conversation model receives the caller-supplied `contentBlocks` verbatim as one user message; an image uploaded through `attachment/saveImage` becomes model-visible only when its returned reference appears in an image block in that SDK session. This package adds no system-prompt prose or tool schema; those come from the plugins in the surrounding `cordis.yml`.

#### Token effect

Data-dependent user-message tokens enter retained session history and are resent on later turns until another package compacts them. The JSON-RPC frames, session notifications, and server bookkeeping add zero model-context tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Preset-backed sessions cannot resume** — this runtime rejects a durable `agentPreset` before agent publication because it does not compose recorded presets.
- **Cancellation is session-activity scoped, not prompt scoped** — acknowledgement does not identify a prompt or await idle; clients observe whole-agent status and durable events.
- **There is no per-prompt result** — `MessageId` identifies inbox admission only; clients that own an automation interval must define and observe that interval themselves.
- **stdout purity is deployment-enforced** — a surrounding config can still load a stdout logger and corrupt the JSON-RPC channel; this plugin does not inspect or veto sibling loggers.
- **Automatic adapter mounting is DeepSeek-specific** — `initialize` can reuse any pre-registered model adapter, but its only fallback mounts `dsh-llm-deepseek`.
