# Agent Note: Provider-native authentication over the SDK

Status: implemented

English | [中文](2026-08-18-provider-native-authentication.zh.md)

## Problem

The SDK catalog could describe provider routes, but an out-of-process client could not authenticate them. API keys had to exist before launch, and subscription providers such as OpenAI Codex, Anthropic, GitHub Copilot, Kimi, OpenRouter, and xAI could not run their native OAuth or device flows. Reimplementing those protocols in each surface would duplicate callback, challenge, polling, exchange, and refresh logic while increasing secret exposure.

## Decision

The LLM seam owns provider-neutral authentication vocabulary: non-secret method/status metadata, text/secret/select/manual-code prompts, progress and authorization events, login, and logout. The pi-ai adapter implements that vocabulary by calling `Models.login`, `Models.checkAuth`, and `Models.logout`; pi-ai remains the sole owner of provider-specific OAuth protocols.

Every pi-ai `Models` snapshot shares one durable provider-keyed credential store. Its path resolves from `DSH_PI_AI_AUTH_PATH`, then `$DSH_HOME/pi-ai-auth.json`, then `~/.dsh/pi-ai-auth.json`. The store strictly validates JSON credentials, requires its direct parent and file to have modes `0700` and `0600`, and performs cross-process read-modify-write under `dsh-atomic-write`'s sibling lock and atomic rename. Provider-native OAuth refresh therefore updates the same store without snapshot or process-lifetime coupling.

A profile that names `apiKeyEnv` keeps the existing fail-loud credential-reference contract and does not offer native login. A profile without that field may use its installed provider's ambient, stored API-key, or OAuth methods. OpenAI API access and OpenAI Codex subscription access remain separate routes because they use different endpoints and authentication products.

## SDK flow contract

`provider/authStart` returns an opaque flow id before provider work completes. Correlated notifications carry non-secret events, prompts, prompt settlement, and one terminal outcome. `provider/authRespond` is first-response-wins and never echoes the submitted value. `provider/authCancel` aborts provider work and every pending prompt. Server shutdown aborts all flows and waits for their tasks before transport teardown.

Prompt-local abort handles OAuth callback races: when a browser callback wins, the provider aborts its manual-code prompt and the server emits `promptResolved`. Late or duplicated responses cannot reach another prompt or flow. Error notifications carry a generic failure message rather than provider exceptions that could contain token response data.

TypeScript and Python clients validate all request results and notification shapes at runtime. Secrets exist only in the prompt response request and durable credential file; they do not enter session events, transcripts, logs, status metadata, or terminal notifications.

## Alternatives considered

**Store every key through `apiKeyEnv`.** This supports static API keys but cannot represent refreshable OAuth credentials or provider-scoped fields. It also bypasses the provider library's locked refresh contract.

**Implement OAuth in the TUI or SDK server.** Rejected because callback ports, PKCE, device polling, token exchange, and refresh behavior differ by provider and already belong to pi-ai. Copying them would create protocol drift and additional secret-handling code.

**Reuse Pi coding-agent `auth.json` directly.** Rejected because DeepSeek Harness must not depend on a separate application package or its configuration directory. The credential shape is compatible, but storage ownership and path selection remain Harness deployment decisions.

**Return a blocking login RPC.** Rejected because clients must answer intermediate prompts and observe device/browser instructions while login remains active. An asynchronous server-owned flow gives cancellation and shutdown explicit ownership.

## Consequences

Clients can connect API-key and subscription providers from the provider picker, including browser callback, device-code, and manual challenge flows. Credentials survive restarts and refresh safely across model snapshots. The cost is five auth RPC methods, four notification kinds, Python parity, and an owner-private JSON file that remains readable to other processes running as the same OS user; OS keychain integration is deferred.

Focused tests cover store validation, permissions and concurrent mutation; adapter method/status/login/logout delegation; SDK correlation, secret non-echo, cancellation, prompt abort, shutdown quiescence, and malformed payload rejection; Python validation; and TUI masking and URL-scheme validation.
