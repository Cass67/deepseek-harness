# Agent Note: The SDK client spawns the runtime under a real Node interpreter

Status: implemented

English | [中文](2026-09-01-sdk-client-node-interpreter.zh.md)

## Problem

HarnessClient spawned the runtime subprocess with `process.execPath` — the
interpreter of the calling process. TUI clients that run under Bun (Bun
plus OpenTUI render the interface, and they boot the harness as a child
process) therefore launched `lib/bin.js` with Bun. Bun 1.3.10's transpiler
crashes with `Scope mismatch while visiting` on some harness plugin sources
(for example `llm/llm-pi-ai/src/index.ts`) during module analysis, so the
runtime died about 70ms after spawn — before the JSON-RPC initialize
handshake — and the TUI surfaced a dead "input unavailable" panel.

## Decision

`resolveDshLaunch` resolves the runtime interpreter through
`runtimeCommand()`: `DSH_RUNTIME_NODE` forces the binary; otherwise a Bun
caller (`process.execPath` basename `bun`/`bun.exe`) uses
`npm_node_execPath`, falling back to `node` on `PATH`; any other caller
keeps its own `process.execPath`. The runtime contract stays unchanged —
Node (or a node-compatible interpreter) executes the same built `lib`
entry and the same profile patches.

## Alternatives considered

**Run the TUI itself under Node.** Rejected: OpenTUI's renderer and the
TUI's plugin stack are Bun-built; swapping the host interpreter is a
different migration, not a runtime-launch fix.

**Pin or patch Bun waiting for upstream.** Rejected: the panic is a known
Bun compiler bug with no immediate fix; the runtime does not need Bun's
transpiler at all.

**Rely on a wrapper script in the TUI.** Rejected: the SDK client owns
spawning; the interpreter choice belongs in the seam that spawns it.

## Consequences

The runtime always starts under a real Node even when the caller runs under
Bun; `DSH_RUNTIME_NODE` gives operators an explicit override. The Python
SDK is unaffected (it launches its own runtime). The interpreter falls back
to `node` on `PATH`, so a missing or shadowed Node shows as a normal spawn
failure rather than a Bun crash.