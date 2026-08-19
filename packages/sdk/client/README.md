# @deepseek-ai/dsh-sdk-client

English | [中文](README.zh.md)

The TypeScript client SDK for driving a DeepSeek Harness runtime as a subprocess over stdio JSON-RPC — the design twin of the [Python SDK](../../../python/README.md) (`deepseek-harness`), sharing the same runtime peer, protocol, and layering: `DeepSeekHarness` is the high-level owned-run API, `HarnessClient` the lower-level protocol client. The package root enumerates the consumer interface: the two client layers, caller-facing types, and `JsonRpcResponseError`; source modules, normalization helpers, and subscription-delivery machinery are not consumer imports. A pure library: it registers nothing on a Cordis context; the runtime process it spawns is a complete harness whose composition its own `cordis.yml` decides.

Unlike the Python SDK, the launch spec is fully explicit (`command`/`args`): this package is for repo-adjacent TypeScript consumers — including the [`dsh-subagent-dsh-sdk`](../../subagent/subagent-dsh-sdk/README.md) backend and automation — that know which runtime they are launching. Bundled-runtime resolution (finding a packaged executable) remains the Python distribution's concern.

## DeepSeekHarness

```ts
import { readFile } from 'node:fs/promises'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

await using harness = new DeepSeekHarness({
  launch: { command: 'node', args: ['lib/bin.js', 'cordis.yml'] },
  provider: 'configured-image-provider',
  model: 'configured-image-model',
  maxTokens: 49_152,
})
const attachment = await harness.saveImage(await readFile('diagram.png'), 'image/png', 'diagram.png')
const result = await harness.run([
  { type: 'text', text: 'Describe this image.' },
  { type: 'image', attachment },
])
console.log(result.finalResponse)
```

`configured-image-provider` and `configured-image-model` are placeholders for a route backed by an image-capable adapter. Replace them with configured ids only when that model's runtime catalog entry has `inputModalities` containing `image`; an absent `image` gates the route out, while the declaration itself does not verify endpoint support. Durable attachment storage alone does not add image support.

The subprocess starts lazily on first use and stays owned by the instance across `run()` calls; `close()` (or `await using`) is required so the child is always reaped. `start()` memoizes the `initialize` handshake (the workspace cwd — resolved absolute before it crosses the wire — plus the provider/model route and optional positive `maxTokens` output cap); a failed handshake reaps the runtime and swaps in a fresh client, so a later call retries with a new subprocess (until `close()`, which is terminal). The cap applies to each root-agent request and is inherited by in-process descendants; compaction plugins own their separate summary limits. `session(id?)` opens a named or fresh session handle. `imageLimits()` reads the runtime's active upload policy, and `saveImage(bytes, mediaType, name?)` returns a validated durable reference for later image content blocks.

`run(input, { sessionId?, onNotification? })` owns one activity interval: it queues the prompt, waits until its `MessageId` appears in a durable `agent/inbox/spliced` receipt, then collects through the next whole-agent `idle`. It returns `RunResult { sessionId, finalResponse, events, notifications }`. `finalResponse` is the last committed root-session assistant text in that interval, not a response causally assigned to the prompt; steering, injected context, and other queued work may contribute before idle. `events` contains root-session events, while `notifications` also contains descendants discovered from `subagent.started`, all in wire order. The result carries no prompt-level status or turn reason. Transport loss, timeout, and protocol violations reject; model outcomes remain observable in the event stream without being attributed to one input.

## HarnessClient

The protocol client under the owned-run API: explicit `start()`/`initialize()`/`catalog()`/`imageLimits()`/`saveImage()`/`listSessions()`/`sessionHistory()`/`resumeSession()`/`selectModel()`/`prompt()`/`cancelSession()`/`closeSession()`/`listCommands()`/`executeCommand()`/interaction response/`request()`/`close()`, plus notification subscriptions. Every named method validates its runtime response before returning typed data. Catalog results preserve healthy providers beside per-provider failures and validate optional adapter-owned reasoning efforts for each model. Selection affects subsequent step assembly, cancellation only acknowledges a request while preserving queued work, session close awaits runtime quiescence, and command execution stays outside model-visible user messages. `prompt()` returns the queued message id as soon as the runtime accepts it; it never waits for agent activity. `subscribe(filter?)` returns a `NotificationSubscription` (awaitable `next()`, non-blocking `tryNext()`, async iteration); `subscribeSessionTree(id)` scopes to one session and the descendants discovered from `subagent.started` lineage edges — the runtime notifies for every session in its context, and scoping is client-side, exactly like the Python SDK. Error surfaces are typed and exported from this package: `JsonRpcResponseError` (wire error response, code/data preserved), `RequestTimeoutError` (a configured bound elapsed), `SdkProtocolError` (a response outside the documented protocol), `TransportClosedError` (the runtime is gone — message carries the exit code and a bounded stderr tail).

Provider-native authentication uses `providerAuthInfo()`, `startProviderAuth()`, `respondProviderAuth()`, `cancelProviderAuth()`, and `logoutProvider()`. Subscribe before starting so an immediate prompt cannot race the UI. Auth result and notification shapes receive strict runtime validation; submitted key/code values travel only in `provider/authRespond` and are never returned.

`close()` requests protocol `shutdown` (bounded by `shutdownTimeoutMs`, default 1000 ms), then walks a stdin-EOF → SIGTERM → SIGKILL ladder (`disposeEofGraceMs` default 6000, `disposeGraceMs` default 3000) until the process has actually exited. The ladder is private to this client: it runs outside any harness context, so it cannot ride the [`dsh-subprocess`](../../subprocess/README.md) service — the seam's documented exception for SDK-managed transports. It is idempotent, and a closed client refuses reuse.

`HarnessClientOptions.env` replaces the child environment entirely when given (`undefined` inherits the parent's); callers own credential policy — `scrubbedParentEnv` from `dsh-subprocess` is the shared scrub base for isolation-minded launches.

## Model Experience

None, as this is a client-process library; the model runs in the spawned runtime, whose experience is owned by the plugins its `cordis.yml` composes.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No bundled-runtime resolution** — callers name the runtime executable explicitly; packaged-executable discovery stays Python-side until a TypeScript distribution consumer exists.
- **No per-prompt result or cancellation identity** — low-level `prompt()` returns only an enqueue receipt; `cancelSession()` targets current whole-agent activity and `run()` still owns receipt-to-idle collection.
- **Interactions are notification-correlated** — callers consume `interaction.requested` from a subscription and answer with `respondApproval()`, `respondQuestion()`, or `cancelQuestion()`; they are not ordinary server→client JSON-RPC requests.
