# Agent Note: SDK JSON-RPC exposes interactive session controls

Status: implemented

English | [中文](2026-08-17-sdk-interactive-session-controls.zh.md)

## Problem

The SDK JSON-RPC runtime admitted prompts and streamed lifecycle events, but an interactive client could not discover model routes, change a live session's later requests, cancel current activity, close one session, or invoke human commands. TUI callers otherwise had to replace the process, hard-code catalogs, or submit slash commands as model-visible user messages.

These controls must preserve existing ownership rules: a model switch cannot divide prompt assembly from request routing in one step, cancellation acknowledgement cannot masquerade as idle convergence, teardown must await quiescence, and command dispatch must use the existing registry and durable command lifecycle.

## Decision

The shared protocol, JSON-RPC server, TypeScript client, and Python client expose provider/model catalog, session model selection, session cancellation, session close, command listing, and command execution. Named client methods validate every response at runtime; Python publishes matching Pydantic models.

`llm/catalog` calls `ctx.llm.listProviders()` and settles each provider independently. Every listed model is resolved through `ctx.llm.resolveModelInfo()` so healthy groups retain ids, display names, descriptions, declared input modalities, and adapter-owned reasoning efforts with the configured default. A failed listing or exact resolution appears in `failures` without removing other healthy groups.

Each SDK-created agent installs the core `installModelSelection()` listeners during unpublished setup. `session/selectModel` reserves the session before asynchronous validation through `ctx.llm.resolveCallConfig()`, so a concurrent close wins without session resurrection, and changes the mutable selection rather than fixed `Agent.options`. Prompt assembly captures one selection for request routing, so a concurrent change applies only at a later step. The ordinary `request/header` snapshots record a route when the loop uses it and reconstruct the active route from the session log.

`session/cancel` calls `Agent.cancel({ kind: 'user' }, { keepInbox: true })` only for running activity and immediately reports whether it requested cancellation. `session.status` remains the idle-convergence signal. `session/close` deduplicates concurrent close ownership, rejects creation while teardown is active, aborts and settles active command dispatches, removes the server record, and awaits the owning `AgentHandle.dispose()` before permitting later clean creation.

Provider-native authentication is also a control plane rather than session content. `ctx.llm` exposes non-secret methods/status plus login/logout; the SDK server owns asynchronous flow/prompt correlation and delegates actual API-key/OAuth protocols, callback servers, device polling, token exchange, and refresh to the adapter. Submitted secrets and manual codes travel only in responses. Flow events, prompt resolution, completion, cancellation, and shutdown are correlated without writing a session event.

`command/list` and `command/execute` read the optional `ctx.commands` service. Listing returns effective scoped descriptors. Execution passes a complete slash-command line to the registry and returns a structured success, command error, unknown-command, or capability-unavailable outcome. Registry execution appends `command/run` and `command/done`; the server never converts command input or result text into a user message.

## Verification

Server tests cover auth flow correlation, first-response-wins prompts, secret-free notifications, exact reasoning metadata, partial catalog failure, route application and logged request headers, selection-versus-close ownership, active cancellation and inbox preservation, close ownership and recreation, invalid wire parameters, command discovery and execution, and capability absence. TypeScript subprocess tests and Python client tests cover every named method plus malformed responses. Keyless SDK snapshots exercise the assembled JSON-RPC runtime and prove that selection replaces the initial route in `request/header`; the Python built-executable snapshot projects the controls when that artifact is available.

## Alternatives considered

**Mutate `Agent.options` on selection.** Agent options are fixed creation input and do not couple prompt variables with request routing. The existing model-selection mechanism supplies the required per-step snapshot.

**Wait for idle in the cancellation response.** Cancellation and quiescence are orthogonal lifecycle facts, and queued work may continue after the canceled activity. Existing status notifications remain the convergence channel.

**Close the complete runtime to end one session.** Process teardown reaches quiescence but discards unrelated sessions and prevents interactive reuse. The server already owns an exact handle per SDK session.

**Send slash-command text through `session/prompt`.** That would make commands model-visible and bypass command discovery, scoped shadowing, command handlers, and durable command lifecycle events.

**Fail the complete catalog when one provider fails.** Independent adapters can have independent network or configuration failures; hiding healthy routes would make interactive recovery impossible.

## Consequences

A TUI can configure API keys and provider subscription OAuth without putting credentials into the composer, transcript, or session log. The adapter's owner-private atomic credential store preserves refresh tokens across restarts while explicit `apiKeyEnv` profiles retain fail-loud named-reference semantics.

A TUI can drive one long-lived SDK runtime across model changes, cancellation, session teardown, and direct commands without inventing parallel registries or lifecycle states. Model route changes remain step-atomic and reconstructable through ordinary request headers; command effects remain durable but outside model history.

Cancellation remains whole-agent activity control rather than a prompt-owned result. Catalog membership remains advisory: catalog presentation and selection validation both ask the owning adapter for exact route metadata, and selector values stay adapter-owned rather than becoming a protocol enum. Closing a session removes only live SDK ownership; persistence resume and history remain outside this slice. Command execution has no wire cancellation token, so handler cancellation remains limited to runtime teardown until a later interaction protocol owns request-scoped aborts.
