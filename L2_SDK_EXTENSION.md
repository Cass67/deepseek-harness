# L2 SDK Extension — the Cass67/deepseek-harness fork additions

This documents exactly what the `Cass67/deepseek-harness` fork adds to the
upstream DeepSeek Harness JSON-RPC SDK, and why, so anyone porting (cherry
picking) the work into upstream or another fork understands the scope,
semantics, and prerequisites. It is the companion to
[`deepseek-tui`](https://github.com/Cass67/deepseek-tui), which depends on
these methods.

## TL;DR

Upstream's JSON-RPC runtime (`packages/sdk/server`) exposes only the prompt
loop: `initialize`, `session/prompt`, `shutdown`, plus the streaming
`session.status` / `session.event` notifications. The fork adds a second layer
— **L2** — of application-control methods a real client needs to drive the
harness beyond prompting: read/write settings, list skills, list agent
presets, select a model, cancel/close/resume sessions, run slash commands,
answer approvals and user questions, query the model catalog, upload durable
images, and authenticate providers.

Upstream `master` today still ships only the prompt loop. **Every method below
is fork-only.** (Upstream `v0.1.0-rc.8` did not add any of these; its only
SDK-server change was an `initialize` runtime-readiness wait.)

The two fork commits together:

| Commit       | Subject                                                                      | What it lays down                                                                                                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `f2ffab2f83` | `feat(sdk): durable image attachments, interactive session controls, resume` | Shared ground: provider-neutral auth vocabulary in `dsh-llm`, adapter auth/image support (since the upstream merge, the pi-ai auth rides upstream's credentials-plane seam `auth.ts`/`login.ts` instead of the fork's original `auth-store.ts`), low-level `dsh-sdk-client` request plumbing, protocol structure, JSON-RPC runtime snapshot, Python SDK/runtime, the `jsonrpc-agent` example + snapshots, and the four Agent Notes. |
| `f5afaacf40` | `feat(sdk): L2 runtime methods for settings, skills and agent presets`       | The concrete method implementations: `packages/sdk/server/src/server.ts` dispatch (+1029 lines) and the high-level TypeScript `client.ts` / protocol `types.ts` / `index.ts`.                                                                                                                                     |

Apply them in that order (`f2ffab2f83`, then `f5afaacf40`); the second is a
direct child of the first on the fork's `main`.

## Why this exists

`deepseek-tui` is a thin client: it runs the harness as a stdio JSON-RPC
subprocess and renders the `session.event` stream. Without L2, a client built
on `dsh-sdk-client` can prompt but cannot:

- read or write settings (the TUI settings overlay, `/permission`,
  last-model-restore),
- list skills (`Ctrl+K` picker),
- list agent presets (`Ctrl+A` picker),
- choose a model or change a live session's later requests (`Ctrl+L`, `/model`),
- cancel the active turn or close one session without killing the process
  (`/cancel`, `/new`),
- recover or resume a saved session (`/sessions`, `session/resume`),
- run a slash command through the harness command registry instead of sending
  it to the model (`/provider`, arbitrary commands),
- answer an approval or user-question request across the process boundary,
- `Ctrl+P`/auto-upload durable image attachments (PNG/JPEG/WebP/GIF) with
  server-side admission,
- authenticate API-key and subscription (OAuth/device) providers from the
  provider picker.

Before L2, all of that required replacing the process, hard-coding catalogs,
or submitting slash commands as model-visible user messages.

## Wire surface added

The fork's server dispatch (24 methods total; bold = fork additions; the other
four are the upstream prompt loop):

```
initialize  session/prompt  shutdown                # upstream baseline
session.status / session.event                      # upstream streaming notifications

# fork additions:
settings/get  settings/set
skills/list
agent-presets/list
session/list  session/history  session/resume
session/cancel  session/close  session/selectModel
command/list  command/execute
interaction/respond
llm/catalog
attachment/imageLimits  attachment/saveImage
provider/authStart  provider/authInfo  provider/authRespond  provider/authCancel  provider/authLogout
```

### Grouped by concern

| Concern       | Methods                                                                                                       | Why                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Settings      | `settings/get`, `settings/set`                                                                                | Read/redact namespaces and apply `patch`/`replace`. Powers the settings overlay, `/permission`, last-route restore, agent-preset selection.                                                |
| Skills        | `skills/list`                                                                                                 | Enumerate skill providers/packs for the `Ctrl+K` picker.                                                                                                                                   |
| Agent presets | `agent-presets/list`                                                                                          | List named per-session compositions for the `Ctrl+A` picker.                                                                                                                               |
| Sessions      | `session/list`, `session/history`, `session/resume`, `session/cancel`, `session/close`, `session/selectModel` | Browse durable sessions, read exact history through the query service, _explicitly_ resume one, cancel the active turn, tear down one session, and change model selection step-atomically. |
| Commands      | `command/list`, `command/execute`                                                                             | Discover scope-effective slash commands and run one through the registry with durable lifecycle, never as a model message.                                                                 |
| Interactions  | `interaction/respond`                                                                                         | Answer approval requests and user questions (`ApprovalModal`, `InteractionOverlay`), first-response-wins.                                                                                  |
| Catalog       | `llm/catalog`                                                                                                 | List every registered provider + resolve each model's modality/metadata/reasoning for the `Ctrl+L` picker.                                                                                 |
| Attachments   | `attachment/imageLimits`, `attachment/saveImage`                                                              | Query the active image policy and publish one canonical-base64 image to the durable store, returning an opaque `ImageAttachmentRef`.                                                       |
| Provider auth | `provider/authStart`, `authInfo`, `authRespond`, `authCancel`, `authLogout`                                   | Non-secret provider-native authentication (API-key masked entry, OAuth/device/manual-code flows) owned by the adapter; credentials persist through the harness credential plane (`ctx.credentials`) and its authorization flows.                               |

## Key contracts

These are the semantics a porter must preserve (full reasoning in the four
Agent Notes under `.agents/notes/implemented/feature/2026-08-1[7-8]-*.md`):

- **`settings/set`** takes exactly `namespace` plus either `patch` or
  `replace` (not both, not neither) and an optional `expectedRevision`.
  Namespaces register **asynchronously after `initialize` resolves**, so a
  client must poll rather than read once.
- **`session/resume` is explicit** — a separate `ctx.agents.resume` op that
  restores the latest logged route and installs the same model-selection
  mechanism as a fresh session. It is _not_ implicit on an unknown id, so a
  typo cannot silently create an empty replacement.
- **`session/selectModel` is step-atomic**: it validates via
  `ctx.llm.resolveCallConfig()` and changes the _mutable selection_, which
  prompt assembly captures per step — a concurrent close cannot resurrect the
  session, and a selection change applies only at a later step. The ordinary
  `request/header` snapshot reconstructs the active route from the log.
- **`session/cancel`** is whole-agent activity control (`Agent.cancel({ kind:
'user' }, { keepInbox: true })`) that reports whether it requested a cancel;
  `session.status` remains the idle-convergence signal.
- **`session/close`** deduplicates close ownership, aborts active command
  dispatches, and awaits the owning handle's `dispose()` before a clean
  recreation. Closing removes only live SDK ownership — persistence and
  history live in the query service.
- **Commands** go through `ctx.commands` with durable `command/run` /
  `command/done` lifecycle; the server never converts command input or result
  into a user message. Execution has no wire cancellation token yet.
- **Interactions** are first-response-wins: the server clones one request,
  emits `interaction.requested`, validates the response kind and (for
  questions) exact option ids/order/labels/uniqueness/custom text/multi-select
  against the published question, then removes the entry before settling.
  Abort, session cancel, and disposal settle pending waits.
- **Attachments**: `attachment/saveImage` accepts exact fields, a
  service-supported media type, canonical **padded** base64 (rejects
  oversized text before decoding; rejects encodings that don't round-trip),
  optional name. Before `session/prompt` enqueue the server resolves every
  image ref through the active store, verifies canonical metadata matches,
  and applies `maxImagesPerMessage` / `maxMessageImageBytes`. A failure leaves
  the prompt and session uncreated. Attachment ids stay opaque; the provider
  owns raster decode, type-vs-declared verification, pixel limits, and durable
  publication.
- **Provider auth**: `provider/authStart` returns an opaque flow id before
  provider work completes; `authRespond` is first-response-wins and never
  echoes submitted secrets; `authCancel` aborts provider work and every
  pending prompt; shutdown aborts all flows before transport teardown.
  Secrets exist only in the prompt response and the `0700/0600` owner-private
  credential file — never in session events, transcripts, logs, status, or
  notifications. A profile naming `apiKeyEnv` keeps fail-loud credential-ref
  semantics and offers no native login.

## Files touched (the cherry-pick footprint)

- `packages/sdk/protocol/` — `types.ts` (wire types), `index.ts`, `package.json`,
  `tsconfig.json`, `README*`
- `packages/sdk/client/` — `client.ts` (high-level L2 methods), `index.ts`,
  `api.ts` (low-level request plumbing), tests (`sdk-client.spec.ts`,
  `fake-runtime.ts`), `package.json`, `tsconfig.json`, `README*`
- `packages/sdk/server/` — `server.ts` (the dispatcher + all method impls),
  `tests/server.spec.ts`, `package.json` (new runtime deps), `tsconfig.json`,
  `README*`
- `packages/llm/llm/` — `types.ts`, `index.ts`: provider-neutral **auth
  vocabulary** (non-secret method/status, text/secret/select/manual-code
  prompts, progress + authorization events, login, logout)
- `packages/llm/llm-pi-ai/` — `adapter.ts` (auth delegation + attachment
  resolution + native image conversion), `provider.ts`, `config.ts`, `index.ts`,
  tests. On the merged tree the durable store is upstream's `auth.ts`
  (`credentialStoreFrom`/`authContextFrom`) and `login.ts`
  (`registerPiAiFlows`); the fork's original `auth-store.ts` is deleted.
- `packages/skill/`, the `jsonrpc-agent` example (`cordis.yml` variants +
  snapshots), the Python SDK (`python/sdk`) and runtime
  (`python/sdk-runtime`), regenerated docs, and the four Agent Notes.

## Prerequisites on the target tree

Without these, parts of the surface are absent or fail loud (by design):

- **Settings / skills / agent presets**: namespaces and registries come from
  composed plugins — the fork merely proxies them. Mount the settings file
  provider, skill provider registry, and agent-preset registry.
- **Sessions / resume / history**: requires `ctx.sessionQuery` (live-preferred
  logical corpus, exact-history replay validation). Resume additionally needs
  `ctx.agents.resume`.
- **Interactions**: requires the `ctx.userQuestions` provider and an
  `approval/request` answerer; the server registers as both while active and
  re-binds on `ctx.on('user-questions/..')`-style lifecycle changes.
- **Attachments**: requires an `attachments` service mounted (the shipped
  compositions mount `dsh-attachment-local`; its root follows
  `DSH_HOME`, never the workspace/session dir). Absence makes
  `saveImage`/`imageLimits` fail with an explicit capability-absence error.
- **Provider auth**: requires the pi-ai adapter to implement the LLM auth
  vocabulary and the harness credential plane: on the merged tree the
  adapter's `createModels` receives upstream's `{ credentials, authContext }`
  injection from `credentialStoreFrom(ctx)`/`authContextFrom(ctx)`, and
  `registerPiAiFlows` offers the login surfaces.
- **Commands**: optional `ctx.commands`; absence returns a structured
  capability-unavailable outcome rather than failing the wire.

## Verification

- `pnpm vitest packages/sdk ...` — 147 SDK tests across protocol/client/server
  (server auth-flow correlation, first-response-wins, secret non-echo,
  selection-vs-close ownership, cancellation/inbox preservation, close
  ownership, command dispatch, interaction settlement, malformed-wire
  rejection; client malformed-response rejection; Python parity tests).
- `scripts/preflight.mjs` (in `deepseek-tui`) probes four methods —
  `settings/get`, `settings/set`, `skills/list`, `agent-presets/list` — the
  minimum the TUI needs, and turns a missing L2 into one clear message.
- Keyless SDK snapshots boot the real JSON-RPC composition (image attachment
  upload + durable `user/message` pin, `request/header` route replacement,
  full requested/responded/resolved interaction journey); the Python
  built-executable snapshot projects the controls when that artifact exists.

## Porting to upstream

Rebase/apply both commits onto the target `packages/sdk` tree in order. The
pair merges cleanly onto `dsh-v0.1.0-rc.8` (they are exactly what the
`Cass67` fork carries on top of it); expect to re-resolve the `sdk/server`
README prose and the `initialize` readiness boundary if upstream has since
touched that method. The fork now tracks upstream `master`
(`dsh-v0.1.2-alpha.3`) with the L2 surface merged on top, and `deepseek-tui`
boots that merged tree via `dsh --profile sdk` with its `cordis.yml` as a
`--patch` overlay — the `v0.1.0-rc.8-l2` tag is retired.

If only part of the surface is wanted, the two commits are grouped to allow
the LLM-auth/attachment ground (f2ffab2f83) to be reviewed, split, or dropped
independently of the method implementations (f5afaacf40), but the server
dispatcher and the high-level client methods both live in the second commit.
