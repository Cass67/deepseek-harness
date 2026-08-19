# Agent Note: SDK sessions resume explicitly and interactions cross JSON-RPC

Status: implemented

English | [中文](2026-08-17-sdk-session-resume-interactions.zh.md)

## Problem

Interactive SDK clients need durable session discovery, exact history, explicit resume, approvals, and user questions. Parsing backend JSONL would couple clients to one persistence provider. Treating an unknown prompt id as resume would make creation ambiguous. Approval and question waits also need cancellation, first-response-wins ownership, and exact answer validation across the process boundary.

## Decision

The JSON-RPC protocol adds `session/list`, `session/history`, and `session/resume`. Listing and history delegate to `ctx.sessionQuery`, which owns the live-preferred logical corpus and replay validation. History reads never attach an agent. Resume is a separate operation through `ctx.agents.resume`; it reconstructs the latest logged request route, installs the same model-selection mechanism as fresh SDK sessions, and enters the SDK server's existing creation/close ownership maps. The SDK runtime rejects a durable header with `agentPreset` before publishing an agent because it does not compose recorded presets.

The server registers as the optional `ctx.userQuestions` provider and as an `approval/request` answerer while each service is active. Cordis dependency fibers add, replace, and remove both registrations with service lifecycle changes. Each pending wait owns one cloned request and random request id, then emits `interaction.requested`. Clients answer through `interaction/respond`. The server validates the response kind and validates question ids, order, option labels, uniqueness, custom text, and single/multi-select rules against the exact published question. It removes the entry before settling, so the first valid response wins. Abort, session activity cancellation, and server disposal settle pending waits and attempt `interaction.resolved`; a failed requested notification rolls back publication, while a failed resolved notification cannot prevent settlement.

TypeScript and Python clients expose matching list, history, resume, approval-response, question-response, and question-cancel methods. Every named response is validated at the client wire boundary. History validation covers the durable header, contiguous event envelopes, and JSON object payloads without claiming exhaustive knowledge of extension-owned payload fields. Default JSON-RPC runtime compositions include session-query exact reads, approval, user-questions, and the ask-user tool without adding stdout output; the standalone minimal runtime intentionally omits those interactive services.

## Verification

Server tests cover exact list/history delegation, preset-safe resume, approval correlation, cloned question ownership, optional-service lifecycle changes, notification failures, duplicate responses, invalid options, and settlement. TypeScript and Python tests cover malformed history and mismatched identities, while assembled snapshots cover a complete requested/responded/resolved question journey.

## Alternatives considered

**Parse JSONL in each client.** This would exclude SQLite and future backends and duplicate session repair and replay validation outside the owning service.

**Treat any unknown session id as resume.** Creation and resume have different failure and ownership semantics; explicit resume prevents a typo from silently creating an empty replacement.

**Use server-to-client JSON-RPC requests.** The existing notification subscription already carries session-scoped asynchronous work and response methods support first-response-wins validation without adding a second request dispatcher to each SDK.

## Consequences

Clients can browse and resume sessions without knowing the persistence format. Creation stays lazy for prompt/select operations, while resume remains explicit and auditable. Interactions survive transport latency but not runtime shutdown; reconnect replay is not provided by this stdio process-owned transport, so callers must keep their notification subscription active while a request is pending.
