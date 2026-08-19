/**
 * Low-level JSON-RPC client for a DeepSeek Harness SDK runtime subprocess.
 * {@link HarnessClient} owns the child process: it spawns the runtime, speaks
 * the `@deepseek-ai/dsh-sdk-protocol` wire over the child's stdio, fans
 * server notifications out to subscriptions, and tears the child down to
 * quiescence through a private EOF → SIGTERM → SIGKILL ladder. The design
 * twin is the Python SDK's `HarnessClient` (`python/sdk`); both drive the
 * same runtime protocol. This client runs OUTSIDE any harness context, so it
 * spawns directly rather than through the `dsh-subprocess` service — the
 * seam's documented exception for SDK-managed transports.
 *
 * @module @deepseek-ai/dsh-sdk-client/client
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import {
  JsonRpcLineTransport,
  JsonRpcResponseError,
  type AgentPresetsListResult,
  type CommandExecuteResult,
  type CommandListResult,
  type InitializeParams,
  type InitializeResult,
  type InteractionRespondParams,
  type InteractionRespondResult,
  type ModelCatalogResult,
  type ProviderAuthCancelResult,
  type ProviderAuthInfoResult,
  type ProviderAuthLogoutResult,
  type ProviderAuthRespondResult,
  type ProviderAuthStartResult,
  type SessionHistoryResult,
  type SessionListResult,
  type SessionPromptParams,
  type SessionResumeResult,
  type SessionSelectModelResult,
  type SettingsGetResult,
  type SettingsNamespaceWire,
  type SettingsSetParams,
  type SettingsSetResult,
  type SkillsListResult,
} from '@deepseek-ai/dsh-sdk-protocol'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { disposeRuntimeProcess } from './dispose.ts'
import type { HarnessClientOptions, HarnessNotification, NotificationFilter } from './types.ts'

/** Retained stderr lines used to diagnose an unexpected runtime death. */
const STDERR_TAIL_LIMIT = 400

/** Grace for the runtime's stdio streams to settle after its exit edge. */
const STREAM_SETTLE_MS = 100

/**
 * The runtime subprocess is gone or unusable: it exited, its stdio closed, or
 * it was never launchable. The message carries the exit code and a stderr
 * tail when available.
 */
export class TransportClosedError extends Error {
  /** @param message - the failure description, including any stderr tail. */
  constructor(message: string) {
    super(message)
    this.name = 'TransportClosedError'
  }
}

/** A request exceeded {@link HarnessClientOptions.requestTimeoutMs}. */
export class RequestTimeoutError extends Error {
  /** @param message - which method timed out. */
  constructor(message: string) {
    super(message)
    this.name = 'RequestTimeoutError'
  }
}

/**
 * The runtime answered outside its documented protocol (for example a
 * `session/prompt` response without `accepted: true`).
 */
export class SdkProtocolError extends Error {
  /** @param message - the protocol violation description. */
  constructor(message: string) {
    super(message)
    this.name = 'SdkProtocolError'
  }
}

interface SubscriptionState {
  readonly queue: HarnessNotification[]
  readonly waiters: { resolve: (item: HarnessNotification) => void; reject: (error: Error) => void }[]
  readonly filter: NotificationFilter | undefined
  failure: Error | undefined
}

/** One client-side notification stream returned by {@link HarnessClient.subscribe}. */
export interface NotificationSubscription extends AsyncIterable<HarnessNotification> {
  /**
   * Await the next matching notification.
   * @returns the notification; after the runtime died, drains what was
   * already delivered and then rejects; after {@link close}, rejects
   * immediately (the queue is dropped).
   */
  next(): Promise<HarnessNotification>

  /**
   * Drain one already-delivered notification without waiting.
   * @returns the next queued notification, or `undefined` when none is queued.
   */
  tryNext(): HarnessNotification | undefined

  /** Detach from the client; queued items drop and pending waiters reject. */
  close(): void
}

/** Internal producer side of a public notification subscription. */
class NotificationSubscriptionImpl implements NotificationSubscription {
  constructor(
    private readonly state: SubscriptionState,
    private readonly unsubscribe: () => void,
  ) {}

  /**
   * Await the next matching notification.
   * @returns the notification; after the runtime died, drains what was
   * already delivered and then rejects; after {@link close}, rejects
   * immediately (the queue is dropped).
   */
  next(): Promise<HarnessNotification> {
    const queued = this.state.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.state.failure !== undefined) return Promise.reject(this.state.failure)
    return new Promise((resolve, reject) => {
      this.state.waiters.push({ resolve, reject })
    })
  }

  /**
   * Drain one already-delivered notification without waiting.
   * @returns the next queued notification, or `undefined` when none is queued.
   */
  tryNext(): HarnessNotification | undefined {
    return this.state.queue.shift()
  }

  /** Detach from the client; queued items drop and pending waiters reject. */
  close(): void {
    this.unsubscribe()
    // The drop is part of this method's contract; a runtime-death fail() keeps
    // the queue so already-delivered notifications remain drainable.
    this.state.queue.length = 0
    this.fail(new TransportClosedError('notification subscription closed'))
  }

  /**
   * Reject pending and future waits (delivery stops; the first failure wins).
   * Already-queued notifications remain drainable via {@link next}/{@link tryNext}.
   * @param error - the terminal failure delivered to waiters.
   */
  fail(error: Error): void {
    this.state.failure ??= error
    for (const waiter of this.state.waiters.splice(0)) waiter.reject(this.state.failure)
  }

  /**
   * Deliver one notification to a waiter or the queue when the filter
   * matches. A throwing filter fails only THIS subscription (detached, the
   * throw becomes its terminal error) — it never disturbs sibling
   * subscriptions or the transport's read loop, mirroring the Python client.
   * @param notification - the wire notification to deliver.
   */
  push(notification: HarnessNotification): void {
    let matches: boolean
    try {
      matches = this.state.filter === undefined || this.state.filter(notification)
    } catch (error) {
      this.unsubscribe()
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (!matches) return
    const waiter = this.state.waiters.shift()
    if (waiter !== undefined) waiter.resolve(notification)
    else this.state.queue.push(notification)
  }

  /**
   * Iterate notifications until the subscription or runtime closes (the
   * terminating rejection propagates).
   * @returns an async iterator over {@link next} results.
   */
  async * [Symbol.asyncIterator](): AsyncIterator<HarnessNotification> {
    for (;;) yield await this.next()
  }
}

/**
 * JSON-RPC client for the DeepSeek Harness SDK runtime over subprocess stdio.
 *
 * The subprocess starts lazily on {@link start} and is owned by this instance
 * until {@link close}, which requests protocol `shutdown` and then walks the
 * shared EOF → SIGTERM → SIGKILL dispose ladder to quiescence. There is no
 * wire-level cancel: a timed-out request stays running server-side until the
 * runtime is closed.
 */
export class HarnessClient {
  private child: ChildProcess | undefined
  private transport: JsonRpcLineTransport | undefined
  private readonly stderrTail: string[] = []
  private readonly subscriptions = new Map<string, NotificationSubscriptionImpl>()
  private readonly sessionParents = new Map<string, string>()
  private subscriptionSerial = 0
  private exitCode: number | null | undefined
  private spawnError: Error | undefined
  private streamsSettled: Promise<void> = Promise.resolve()
  private closeTask: Promise<void> | undefined

  /** @param options - launch spec, complete child environment, and timeouts. */
  constructor(readonly options: HarnessClientOptions) {}

  /**
   * Spawn the runtime subprocess and start reading frames. Idempotent while
   * the process is live; rejects reuse after {@link close}.
   */
  start(): void {
    if (this.closeTask !== undefined) throw new TransportClosedError('DeepSeek Harness runtime client is closed')
    if (this.child !== undefined) return
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.once('error', (error) => {
      this.spawnError = error
      // A spawn failure destroys the pipes without an input 'end' edge, so the
      // transport's pending requests must be failed here.
      this.transport?.close()
      this.failSubscriptions(this.closedError('DeepSeek Harness runtime failed to start'))
    })
    // Writes racing the runtime's death EPIPE on stdin; the exit edge below is
    // the real signal, so the stream-level error only needs to be non-fatal.
    // The timing of that race is not deterministically reproducible.
    /* v8 ignore next */
    child.stdin.on('error', () => {})
    let stderrBuffer = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
      const newline = stderrBuffer.lastIndexOf('\n')
      if (newline >= 0) {
        this.appendStderr(stderrBuffer.slice(0, newline).split('\n'))
        stderrBuffer = stderrBuffer.slice(newline + 1)
      }
    })
    let signalStreamsSettled!: () => void
    this.streamsSettled = new Promise((resolve) => { signalStreamsSettled = resolve })
    const settled = { stderr: false, exited: false }
    const maybeSettle = (): void => {
      if (settled.stderr && settled.exited) signalStreamsSettled()
    }
    child.stderr.once('close', () => {
      if (stderrBuffer.length > 0) this.appendStderr([stderrBuffer])
      settled.stderr = true
      maybeSettle()
    })
    child.once('exit', (code) => {
      this.exitCode = code
      settled.exited = true
      maybeSettle()
      this.failSubscriptions(this.closedError('DeepSeek Harness runtime exited'))
    })
    child.once('close', () => {
      // All stdio has settled: stdout 'end' already drained every tail frame,
      // so closing now cannot drop responses — it only fails requests that
      // will never be answered.
      this.transport?.close()
    })
    const transport = new JsonRpcLineTransport(child.stdout, child.stdin)
    transport.onNotification((method, params) => {
      const notification = { method, params }
      if (!validProviderAuthNotification(notification)) {
        this.failSubscriptions(new SdkProtocolError(`malformed ${method} notification`))
        return
      }
      this.dispatchNotification(notification)
    })
    transport.start()
    this.transport = transport
  }

  /**
   * Perform the process-wide handshake.
   * @param params - workspace cwd plus the provider/model route.
   * @returns the runtime's wire identity.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    const result = await this.request('initialize', { ...params })
    if (!isRecord(result) || !isRecord(result.serverInfo)
      || typeof result.serverInfo.name !== 'string' || typeof result.serverInfo.version !== 'string') {
      throw new SdkProtocolError(`initialize returned no server identity: ${JSON.stringify(result)}`)
    }
    return { serverInfo: { name: result.serverInfo.name, version: result.serverInfo.version } }
  }

  /**
   * List registered provider/model routes, preserving independent lookup failures.
   * @returns healthy provider catalogs plus per-provider failures.
   */
  async catalog(): Promise<ModelCatalogResult> {
    const result = await this.request('llm/catalog')
    if (!isRecord(result) || !Array.isArray(result.providers) || !Array.isArray(result.failures)
      || !result.providers.every(validProviderCatalog) || !result.failures.every(validCatalogFailure)) {
      throw new SdkProtocolError(`llm/catalog returned malformed catalog: ${JSON.stringify(result)}`)
    }
    return result as unknown as ModelCatalogResult
  }

  /**
   * Read non-secret native authentication methods and status for one provider.
   * @param provider - registered provider route.
   * @returns method labels and configured state without credential values.
   */
  async providerAuthInfo(provider: string): Promise<ProviderAuthInfoResult> {
    const result = await this.request('provider/authInfo', { provider })
    if (!validProviderAuthInfo(result) || result.provider !== provider) {
      throw new SdkProtocolError(`provider/authInfo returned malformed info: ${JSON.stringify(result)}`)
    }
    return result
  }

  /**
   * Start one asynchronous provider-native authentication flow.
   * @param provider - registered provider route.
   * @param type - provider-offered authentication method.
   * @returns opaque flow identity used to correlate notifications.
   */
  async startProviderAuth(provider: string, type: 'api_key' | 'oauth'): Promise<ProviderAuthStartResult> {
    const result = await this.request('provider/authStart', { provider, type })
    if (!isRecord(result) || !exactKeys(result, ['flowId'])
      || typeof result.flowId !== 'string' || result.flowId.length === 0) {
      throw new SdkProtocolError(`provider/authStart returned malformed flow: ${JSON.stringify(result)}`)
    }
    return { flowId: result.flowId }
  }

  /**
   * Respond to one pending provider auth prompt.
   * @param flowId - owning authentication flow.
   * @param promptId - exact pending prompt.
   * @param value - user response, sent only in this request.
   * @returns first-response-wins receipt.
   */
  async respondProviderAuth(flowId: string, promptId: string, value: string): Promise<ProviderAuthRespondResult> {
    const result = await this.request('provider/authRespond', { flowId, promptId, value })
    const valid = isRecord(result) && (
      (exactKeys(result, ['accepted']) && result.accepted === true)
      || (exactKeys(result, ['accepted', 'reason']) && result.accepted === false
        && (result.reason === 'not-pending' || result.reason === 'bad-flow'))
    )
    if (!valid) {
      throw new SdkProtocolError(`provider/authRespond returned malformed receipt: ${JSON.stringify(result)}`)
    }
    return result as unknown as ProviderAuthRespondResult
  }

  /**
   * Cancel one provider authentication flow.
   * @param flowId - flow to abort.
   * @returns whether an active flow received cancellation.
   */
  async cancelProviderAuth(flowId: string): Promise<ProviderAuthCancelResult> {
    const result = await this.request('provider/authCancel', { flowId })
    if (!isRecord(result) || !exactKeys(result, ['requested']) || typeof result.requested !== 'boolean') {
      throw new SdkProtocolError(`provider/authCancel returned malformed result: ${JSON.stringify(result)}`)
    }
    return { requested: result.requested }
  }

  /**
   * Remove one provider's stored native credential.
   * @param provider - registered provider route to disconnect.
   * @returns confirmed disconnect result.
   */
  async logoutProvider(provider: string): Promise<ProviderAuthLogoutResult> {
    const result = await this.request('provider/authLogout', { provider })
    if (!isRecord(result) || !exactKeys(result, ['disconnected']) || result.disconnected !== true) {
      throw new SdkProtocolError(`provider/authLogout returned malformed result: ${JSON.stringify(result)}`)
    }
    return { disconnected: true }
  }

  /**
   * Query deployment-resolved image upload limits.
   * @returns active attachment admission policy.
   */
  async imageLimits(): Promise<ImageAttachmentLimits> {
    const result = await this.request('attachment/imageLimits')
    if (!validImageLimits(result)) {
      throw new SdkProtocolError(`attachment/imageLimits returned malformed limits: ${JSON.stringify(result)}`)
    }
    return result
  }

  /**
   * Save one image as a durable attachment.
   * @param data - encoded image bytes.
   * @param mediaType - declared media type, verified by the runtime.
   * @param name - optional display name.
   * @returns verified durable image reference.
   */
  async saveImage(data: Uint8Array, mediaType: ImageMediaType, name?: string): Promise<ImageAttachmentRef> {
    const result = await this.request('attachment/saveImage', {
      data: Buffer.from(data).toString('base64'),
      mediaType,
      ...name === undefined ? {} : { name },
    })
    if (!validImageRef(result) || result.bytes !== data.byteLength || result.mediaType !== mediaType) {
      throw new SdkProtocolError(`attachment/saveImage returned malformed or mismatched reference: ${JSON.stringify(result)}`)
    }
    return result
  }

  /**
   * List all logical sessions visible to the runtime query service.
   * @returns live-preferred durable session records.
   */
  async listSessions(): Promise<SessionListResult> {
    const result = await this.request('session/list')
    if (!isRecord(result) || !Array.isArray(result.sessions) || !result.sessions.every(validSessionListEntry)) {
      throw new SdkProtocolError(`session/list returned malformed records: ${JSON.stringify(result)}`)
    }
    return result as unknown as SessionListResult
  }

  /**
   * Read one complete durable session log without making it live.
   * @param sessionId - logical session identity.
   * @returns detached header and complete event log.
   */
  async sessionHistory(sessionId: string): Promise<SessionHistoryResult> {
    const result = await this.request('session/history', { sessionId })
    if (!isRecord(result) || !validSessionHeader(result.session) || result.session.id !== sessionId
      || !Array.isArray(result.events) || !validSessionEventLog(result.events)) {
      throw new SdkProtocolError(`session/history returned malformed history: ${JSON.stringify(result)}`)
    }
    return result as unknown as SessionHistoryResult
  }

  /**
   * Explicitly resume one persisted session.
   * @param sessionId - persisted session identity.
   * @returns resumed identity.
   */
  async resumeSession(sessionId: string): Promise<SessionResumeResult> {
    const result = await this.request('session/resume', { sessionId })
    if (!isRecord(result) || result.sessionId !== sessionId) {
      throw new SdkProtocolError(`session/resume returned malformed identity: ${JSON.stringify(result)}`)
    }
    return { sessionId }
  }

  /**
   * Answer one pending approval request.
   * @param requestId - stable pending interaction id.
   * @param outcome - one-shot grant or rejection.
   * @returns first-response-wins receipt.
   */
  respondApproval(requestId: string, outcome: 'allowed-once' | 'rejected'): Promise<InteractionRespondResult> {
    return this.respondInteraction({ requestId, kind: 'approval', outcome })
  }

  /**
   * Answer one pending user-question batch.
   * @param requestId - stable pending interaction id.
   * @param answer - exact ordered answers.
   * @returns first-response-wins receipt.
   */
  respondQuestion(
    requestId: string,
    answer: { answers: { id: string; selected: string[]; custom?: string }[] },
  ): Promise<InteractionRespondResult> {
    return this.respondInteraction({ requestId, kind: 'question', answer })
  }

  /**
   * Cancel one pending user-question batch.
   * @param requestId - stable pending interaction id.
   * @returns first-response-wins receipt.
   */
  cancelQuestion(requestId: string): Promise<InteractionRespondResult> {
    return this.respondInteraction({ requestId, kind: 'question-cancelled' })
  }

  private async respondInteraction(params: InteractionRespondParams): Promise<InteractionRespondResult> {
    const result = await this.request('interaction/respond', params)
    if (!isRecord(result) || typeof result.accepted !== 'boolean'
      || (result.reason !== undefined && result.reason !== 'not-pending' && result.reason !== 'bad-response')) {
      throw new SdkProtocolError(`interaction/respond returned malformed receipt: ${JSON.stringify(result)}`)
    }
    return result as unknown as InteractionRespondResult
  }

  /**
   * Select a validated route for subsequent steps of one session.
   * @param sessionId - target SDK session.
   * @param provider - registered provider route.
   * @param model - provider-owned model id.
   * @param reasoningEffort - optional adapter-owned reasoning effort.
   * @returns adapter-resolved route selection.
   */
  async selectModel(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: string,
  ): Promise<SessionSelectModelResult> {
    const result = await this.request('session/selectModel', {
      sessionId,
      provider,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
    if (!isRecord(result) || typeof result.provider !== 'string' || typeof result.model !== 'string'
      || (result.reasoningEffort !== undefined && typeof result.reasoningEffort !== 'string')) {
      throw new SdkProtocolError(`session/selectModel returned malformed selection: ${JSON.stringify(result)}`)
    }
    return result as unknown as SessionSelectModelResult
  }

  /**
   * Request current activity cancellation without waiting for idle convergence.
   * @param sessionId - existing SDK session.
   * @returns whether running activity received the request.
   */
  async cancelSession(sessionId: string): Promise<boolean> {
    const result = await this.request('session/cancel', { sessionId })
    if (!isRecord(result) || typeof result.requested !== 'boolean') {
      throw new SdkProtocolError(`session/cancel returned malformed acknowledgement: ${JSON.stringify(result)}`)
    }
    return result.requested
  }

  /**
   * Close one runtime-owned session after its agent reaches quiescence.
   * @param sessionId - existing SDK session.
   * @returns whether a live or creating session was closed.
   */
  async closeSession(sessionId: string): Promise<boolean> {
    const result = await this.request('session/close', { sessionId })
    if (!isRecord(result) || typeof result.closed !== 'boolean') {
      throw new SdkProtocolError(`session/close returned malformed result: ${JSON.stringify(result)}`)
    }
    return result.closed
  }

  /**
   * List commands effective for one session.
   * @param sessionId - target SDK session.
   * @returns capability availability and effective descriptors.
   */
  async listCommands(sessionId: string): Promise<CommandListResult> {
    const result = await this.request('command/list', { sessionId })
    if (!isRecord(result) || typeof result.available !== 'boolean' || !Array.isArray(result.commands)
      || !result.commands.every(validCommandDescriptor)) {
      throw new SdkProtocolError(`command/list returned malformed result: ${JSON.stringify(result)}`)
    }
    return result as unknown as CommandListResult
  }

  /**
   * Execute one slash command outside the model-message plane.
   * @param sessionId - target SDK session.
   * @param line - complete slash-command line.
   * @returns structured dispatch outcome.
   */
  async executeCommand(sessionId: string, line: string): Promise<CommandExecuteResult> {
    const result = await this.request('command/execute', { sessionId, line })
    if (!validCommandResult(result)) {
      throw new SdkProtocolError(`command/execute returned malformed result: ${JSON.stringify(result)}`)
    }
    return result
  }

  /**
   * List the skill catalog for one lookup.
   * @param cwd - optional working directory for local skill discovery.
   * @returns the skill catalog.
   */
  async listSkills(cwd?: string): Promise<SkillsListResult> {
    const result = await this.request('skills/list', cwd === undefined ? {} : { cwd })
    if (!validSkillsListResult(result)) {
      throw new SdkProtocolError(`skills/list returned malformed result: ${JSON.stringify(result)}`)
    }
    return result
  }

  /**
   * List the agent preset roster.
   * @returns the agent preset roster with the user's chosen default.
   */
  async listAgentPresets(): Promise<AgentPresetsListResult> {
    const result = await this.request('agent-presets/list', {})
    if (!validAgentPresetsListResult(result)) {
      throw new SdkProtocolError(`agent-presets/list returned malformed result: ${JSON.stringify(result)}`)
    }
    return result
  }

  /**
   * Describe every registered settings namespace.
   * @returns the redacted namespace descriptors.
   */
  async getSettings(): Promise<SettingsGetResult> {
    const result = await this.request('settings/get', {})
    if (!validSettingsGetResult(result)) {
      throw new SdkProtocolError(`settings/get returned malformed result: ${JSON.stringify(result)}`)
    }
    return result
  }

  /**
   * Write one registered settings namespace.
   * @param params - the namespace and the patch or wholesale section to apply.
   * @returns the namespace's resolved value and revision after the write.
   */
  async setSettings(params: SettingsSetParams): Promise<SettingsSetResult> {
    const result = await this.request('settings/set', { ...params })
    if (!validSettingsSetResult(result)) {
      throw new SdkProtocolError(`settings/set returned malformed result: ${JSON.stringify(result)}`)
    }
    return result
  }

  /**
   * Queue one prompt and return its durable inbox identity.
   * @param sessionId - target session; an unknown id creates it.
   * @param contentBlocks - the user message, sent verbatim.
   * @returns the queued message id.
   */
  async prompt(sessionId: string, contentBlocks: ContentBlock[]): Promise<string> {
    const params: SessionPromptParams = { sessionId, contentBlocks }
    const result = await this.request('session/prompt', { ...params })
    if (!isRecord(result) || typeof result.messageId !== 'string') {
      throw new SdkProtocolError(`session/prompt returned no message id: ${JSON.stringify(result)}`)
    }
    return result.messageId
  }

  /**
   * Send one JSON-RPC request and await its result.
   * @param method - the wire method name.
   * @param params - the params object; omitted params send `{}`.
   * @param timeoutMs - per-call override of {@link HarnessClientOptions.requestTimeoutMs}.
   * @returns the raw result; rejects with {@link JsonRpcResponseError} on a
   * protocol error response, {@link RequestTimeoutError} on timeout, and
   * {@link TransportClosedError} when the runtime is gone.
   */
  async request(method: string, params?: object, timeoutMs?: number): Promise<unknown> {
    this.start()
    // A dead runtime cannot answer; fail with process context instead of
    // writing into a destroyed pipe and hanging until the timeout.
    if (this.exitCode !== undefined || this.spawnError !== undefined) {
      await this.settleStreams()
      throw this.closedError('DeepSeek Harness runtime is not running')
    }
    const transport = this.transport
    /* v8 ignore next -- start() either sets the transport or throws */
    if (transport === undefined) throw new TransportClosedError('DeepSeek Harness runtime is not running')
    const timeout = timeoutMs ?? this.options.requestTimeoutMs
    try {
      if (timeout === undefined) return await transport.request(method, params ?? {})
      // The abort signal makes the timeout an abandonment: the transport drops
      // its pending entry, so repeated bounded requests against a hung method
      // retain no per-call state (the server-side work still runs to close).
      const abandon = new AbortController()
      const timer = setTimeout(() => {
        abandon.abort(new RequestTimeoutError(`${method} timed out after ${timeout}ms waiting for the DeepSeek Harness runtime`))
      }, timeout)
      try {
        return await transport.request(method, params ?? {}, abandon.signal)
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      if (error instanceof JsonRpcResponseError || error instanceof RequestTimeoutError) throw error
      // Transport-level failures gain process context: exit code + stderr tail.
      await this.settleStreams()
      throw this.closedError(errorMessage(error))
    }
  }

  /**
   * Subscribe to server notifications.
   * @param filter - optional predicate; omitted means every notification.
   * @returns the subscription handle; close it to stop delivery. After
   * {@link close} or runtime death the handle is born failed — there is no
   * producer left, so `next()` rejects instead of waiting forever.
   */
  subscribe(filter?: NotificationFilter): NotificationSubscription {
    const id = String(this.subscriptionSerial++)
    const state: SubscriptionState = { queue: [], waiters: [], filter, failure: undefined }
    const subscription = new NotificationSubscriptionImpl(state, () => { this.subscriptions.delete(id) })
    if (this.closeTask !== undefined || this.exitCode !== undefined || this.spawnError !== undefined) {
      subscription.fail(this.closedError('DeepSeek Harness runtime closed'))
      return subscription
    }
    this.subscriptions.set(id, subscription)
    return subscription
  }

  /**
   * Subscribe to one session and the descendants discovered from
   * `subagent.started` lineage edges (the runtime notifies for every session
   * in its context; scoping is client-side, mirroring the Python SDK).
   * @param sessionId - the root session id.
   * @returns the filtered subscription handle.
   */
  subscribeSessionTree(sessionId: string): NotificationSubscription {
    return this.subscribe((notification) => {
      const params = notification.params
      if (notification.method === 'subagent.started' || notification.method === 'subagent.finished') {
        const parentId = params.parentSessionId
        if (typeof parentId === 'string' && this.isDescendantOf(parentId, sessionId)) return true
        return params.childSessionId === sessionId
      }
      const relatedId = params.sessionId
      return typeof relatedId === 'string' && this.isDescendantOf(relatedId, sessionId)
    })
  }

  /**
   * Shut the runtime down and reap it: a best-effort protocol `shutdown`
   * bounded by `shutdownTimeoutMs`, then the shared stdin-EOF → SIGTERM →
   * SIGKILL ladder until the process actually exited. Idempotent.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void> {
    this.closeTask ??= this.performClose()
    return this.closeTask
  }

  private async performClose(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    try {
      await this.request('shutdown', undefined, this.options.shutdownTimeoutMs ?? 1_000)
    } catch (error) {
      // Diagnostic only: the dispose ladder below is the authoritative teardown
      // for a runtime that cannot answer shutdown anymore.
      this.appendStderr([`shutdown request failed: ${errorMessage(error)}`])
    }
    await disposeRuntimeProcess(child, {
      disposeEofGraceMs: this.options.disposeEofGraceMs ?? 6_000,
      disposeGraceMs: this.options.disposeGraceMs ?? 3_000,
    })
    this.transport?.close()
    this.failSubscriptions(this.closedError('DeepSeek Harness runtime closed'))
  }

  private dispatchNotification(notification: HarnessNotification): void {
    this.recordSessionRelationship(notification)
    for (const subscription of this.subscriptions.values()) subscription.push(notification)
  }

  private recordSessionRelationship(notification: HarnessNotification): void {
    if (notification.method !== 'subagent.started') return
    const parentId = notification.params.parentSessionId
    const childId = notification.params.childSessionId
    if (typeof parentId === 'string' && parentId !== '' && typeof childId === 'string' && childId !== '' && parentId !== childId) {
      this.sessionParents.set(childId, parentId)
    }
  }

  private isDescendantOf(sessionId: string, rootSessionId: string): boolean {
    const visited = new Set<string>()
    let current = sessionId
    while (!visited.has(current)) {
      if (current === rootSessionId) return true
      visited.add(current)
      const parent = this.sessionParents.get(current)
      if (parent === undefined) return false
      current = parent
    }
    // The parent map only ever extends chains upward, so a cycle cannot form.
    /* v8 ignore next */
    return false
  }

  private failSubscriptions(error: Error): void {
    for (const subscription of this.subscriptions.values()) subscription.fail(error)
  }

  private appendStderr(lines: string[]): void {
    const kept = lines.filter(line => line.length > 0)
    this.stderrTail.push(...kept)
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LIMIT)
    }
  }

  private settleStreams(): Promise<void> {
    return Promise.race([
      this.streamsSettled,
      new Promise<void>((resolve) => { setTimeout(resolve, STREAM_SETTLE_MS) }),
    ])
  }

  private closedError(reason: string): TransportClosedError {
    const parts = [reason]
    if (this.spawnError !== undefined) parts.push(`spawn error: ${this.spawnError.message}`)
    if (this.exitCode !== undefined) parts.push(`exit code: ${String(this.exitCode)}`)
    if (this.stderrTail.length > 0) parts.push(`stderr tail:\n${this.stderrTail.join('\n')}`)
    return new TransportClosedError(parts.join('\n'))
  }
}

/**
 * Whether `value` is a plain JSON object (the wire-boundary shape probe).
 * @param value - the wire value to probe.
 * @returns `true` iff `value` is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validAuthEvent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'progress') return exactKeys(value, ['type', 'message']) && typeof value.message === 'string'
  if (value.type === 'auth_url') return exactKeys(value, ['type', 'url'], ['instructions'])
    && typeof value.url === 'string' && value.url.length > 0
    && (value.instructions === undefined || typeof value.instructions === 'string')
  if (value.type === 'device_code') return exactKeys(value, ['type', 'userCode', 'verificationUri'], ['intervalSeconds', 'expiresInSeconds'])
    && typeof value.userCode === 'string' && value.userCode.length > 0
    && typeof value.verificationUri === 'string' && value.verificationUri.length > 0
    && (value.intervalSeconds === undefined || positiveSafeInteger(value.intervalSeconds))
    && (value.expiresInSeconds === undefined || positiveSafeInteger(value.expiresInSeconds))
  return value.type === 'info' && exactKeys(value, ['type', 'message'], ['links']) && typeof value.message === 'string'
    && (value.links === undefined || (Array.isArray(value.links) && value.links.every(link => isRecord(link)
      && exactKeys(link, ['url'], ['label']) && typeof link.url === 'string' && link.url.length > 0
      && (link.label === undefined || typeof link.label === 'string'))))
}

function validAuthPrompt(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.message !== 'string') return false
  if (value.type === 'select') return exactKeys(value, ['type', 'message', 'options']) && Array.isArray(value.options)
    && value.options.length > 0 && value.options.every(option => isRecord(option)
      && exactKeys(option, ['id', 'label'], ['description']) && typeof option.id === 'string' && option.id.length > 0
      && typeof option.label === 'string' && option.label.length > 0
      && (option.description === undefined || typeof option.description === 'string'))
  return (value.type === 'text' || value.type === 'secret' || value.type === 'manual_code')
    && exactKeys(value, ['type', 'message'], ['placeholder'])
    && (value.placeholder === undefined || typeof value.placeholder === 'string')
}

function validProviderAuthNotification(notification: HarnessNotification): boolean {
  if (!notification.method.startsWith('provider.auth.')) return true
  const value = notification.params
  if (!isRecord(value) || typeof value.flowId !== 'string' || value.flowId.length === 0) return false
  if (notification.method === 'provider.auth.event') return exactKeys(value, ['flowId', 'provider', 'event'])
    && typeof value.provider === 'string' && value.provider.length > 0 && validAuthEvent(value.event)
  if (notification.method === 'provider.auth.prompt') return exactKeys(value, ['flowId', 'provider', 'promptId', 'prompt'])
    && typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.promptId === 'string' && value.promptId.length > 0 && validAuthPrompt(value.prompt)
  if (notification.method === 'provider.auth.promptResolved') return exactKeys(value, ['flowId', 'promptId'])
    && typeof value.promptId === 'string' && value.promptId.length > 0
  if (notification.method === 'provider.auth.finished') return exactKeys(value, ['flowId', 'provider', 'outcome'], ['message'])
    && typeof value.provider === 'string' && value.provider.length > 0
    && (value.outcome === 'success' || value.outcome === 'cancelled' || value.outcome === 'error')
    && (value.message === undefined || typeof value.message === 'string')
  return false
}

function validProviderAuthInfo(value: unknown): value is ProviderAuthInfoResult {
  if (!isRecord(value) || !exactKeys(value, ['provider', 'methods', 'configured'], ['credentialType', 'source'])
    || typeof value.provider !== 'string' || value.provider.length === 0
    || typeof value.configured !== 'boolean' || !Array.isArray(value.methods)
    || !value.methods.every(method => isRecord(method) && exactKeys(method, ['type', 'label'])
      && (method.type === 'api_key' || method.type === 'oauth')
      && typeof method.label === 'string' && method.label.length > 0)
    || (value.credentialType !== undefined && value.credentialType !== 'api_key' && value.credentialType !== 'oauth')
    || (value.source !== undefined && (typeof value.source !== 'string' || value.source.length === 0))) return false
  const types = value.methods.map(method => (method as Record<string, unknown>).type)
  return new Set(types).size === types.length
}

function validCatalogReasoning(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.efforts) || value.efforts.length === 0
    || (value.defaultEffort !== undefined && typeof value.defaultEffort !== 'string')) return false
  if (!value.efforts.every(effort => isRecord(effort)
    && typeof effort.id === 'string' && effort.id.length > 0
    && typeof effort.name === 'string' && effort.name.length > 0
    && (effort.description === undefined || typeof effort.description === 'string'))) return false
  const ids = value.efforts.map(effort => (effort as Record<string, unknown>).id as string)
  return new Set(ids).size === ids.length
    && (value.defaultEffort === undefined || ids.includes(value.defaultEffort))
}

function validProviderCatalog(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
    && Array.isArray(value.models) && value.models.every(model => isRecord(model)
      && typeof model.id === 'string' && typeof model.name === 'string'
      && (model.description === undefined || typeof model.description === 'string')
      && (model.inputModalities === undefined
        || (Array.isArray(model.inputModalities) && model.inputModalities.every(item => typeof item === 'string')))
      && (model.reasoning === undefined || validCatalogReasoning(model.reasoning)))
}

function validCatalogFailure(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
    && typeof value.message === 'string'
}

const IMAGE_MEDIA_TYPES = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value)
  return required.every(key => key in value)
    && keys.every(key => required.includes(key) || optional.includes(key))
}

function positiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function validImageLimits(value: unknown): value is ImageAttachmentLimits {
  if (!isRecord(value) || !exactKeys(value, [
    'maxImageBytes', 'maxImagesPerMessage', 'maxMessageImageBytes', 'maxImagePixels', 'mediaTypes',
  ])) return false
  return positiveSafeInteger(value.maxImageBytes)
    && positiveSafeInteger(value.maxImagesPerMessage)
    && positiveSafeInteger(value.maxMessageImageBytes)
    && positiveSafeInteger(value.maxImagePixels)
    && Array.isArray(value.mediaTypes) && value.mediaTypes.length > 0
    && value.mediaTypes.every(item => typeof item === 'string' && IMAGE_MEDIA_TYPES.has(item as ImageMediaType))
    && new Set(value.mediaTypes).size === value.mediaTypes.length
}

function validImageRef(value: unknown): value is ImageAttachmentRef {
  return isRecord(value)
    && exactKeys(value, ['attachmentId', 'mediaType', 'bytes', 'width', 'height'], ['name'])
    && typeof value.attachmentId === 'string' && value.attachmentId.length > 0
    && typeof value.mediaType === 'string' && IMAGE_MEDIA_TYPES.has(value.mediaType as ImageMediaType)
    && positiveSafeInteger(value.bytes) && positiveSafeInteger(value.width) && positiveSafeInteger(value.height)
    && (value.name === undefined || (typeof value.name === 'string' && value.name.length > 0))
}

function validSessionHeader(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.version === 0 && typeof value.id === 'string'
    && Number.isSafeInteger(value.createdAt) && Number(value.createdAt) >= 0
    && (value.cwd === undefined || typeof value.cwd === 'string')
    && (value.parentSession === undefined || typeof value.parentSession === 'string')
    && (value.seedLength === undefined
      || (Number.isSafeInteger(value.seedLength) && Number(value.seedLength) >= 0))
    && (value.origin === undefined || value.origin === 'subagent')
    && (value.delegationDepth === undefined
      || (Number.isSafeInteger(value.delegationDepth) && Number(value.delegationDepth) >= 0))
    && (value.agentPreset === undefined || typeof value.agentPreset === 'string')
}

function validJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(validJsonValue)
  return isRecord(value) && Object.values(value).every(validJsonValue)
}

function validSurfaceOp(value: unknown): boolean {
  return value === 'append' || (isRecord(value)
    && Object.keys(value).length === 3
    && value.op === 'replace'
    && Number.isSafeInteger(value.start) && Number(value.start) >= 0
    && Number.isSafeInteger(value.end) && Number(value.end) >= 0)
}

function validSessionEventLog(values: unknown[]): boolean {
  return values.every((value, index) => isRecord(value)
    && Object.keys(value).every(key => [
      'type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable',
    ].includes(key))
    && typeof value.type === 'string' && value.type.length > 0
    && value.seq === index
    && Number.isSafeInteger(value.time)
    && isRecord(value.data) && validJsonValue(value.data)
    && (value.surfaceOp === undefined || validSurfaceOp(value.surfaceOp))
    && (value.sourceEventSeqs === undefined || (Array.isArray(value.sourceEventSeqs)
      && value.sourceEventSeqs.every(seq => Number.isSafeInteger(seq) && Number(seq) >= 0)))
    && (value.ignorable === undefined || value.ignorable === true))
}

function validSessionListEntry(value: unknown): boolean {
  return isRecord(value) && validSessionHeader(value.header)
    && typeof value.live === 'boolean' && typeof value.persisted === 'boolean'
}

function validCommandDescriptor(value: unknown): boolean {
  return isRecord(value) && typeof value.name === 'string' && typeof value.description === 'string'
    && (value.input === undefined || (isRecord(value.input) && typeof value.input.hint === 'string'))
}

function validCommandResult(value: unknown): value is CommandExecuteResult {
  if (!isRecord(value) || typeof value.outcome !== 'string') return false
  switch (value.outcome) {
    case 'unavailable':
    case 'unknown-command':
      return typeof value.message === 'string'
    case 'error':
      return typeof value.message === 'string' && (value.commandId === undefined || typeof value.commandId === 'string')
    case 'success':
      return typeof value.commandId === 'string'
        && (value.text === undefined || typeof value.text === 'string')
        && (value.sourceEventSeq === undefined || (Number.isSafeInteger(value.sourceEventSeq) && Number(value.sourceEventSeq) >= 0))
    default:
      return false
  }
}

function validSkillSummary(value: unknown): boolean {
  return isRecord(value) && typeof value.name === 'string' && typeof value.description === 'string'
    && (value.whenToUse === undefined || typeof value.whenToUse === 'string')
    && typeof value.source === 'string' && typeof value.provider === 'string'
    && typeof value.modelInvocable === 'boolean' && typeof value.userInvocable === 'boolean'
}

function validSkillsListResult(value: unknown): value is SkillsListResult {
  return isRecord(value) && Array.isArray(value.skills) && value.skills.every(validSkillSummary)
}

function validAgentPreset(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && typeof value.trust === 'string'
    && typeof value.path === 'string'
    && (value.name === undefined || typeof value.name === 'string')
    && (value.description === undefined || typeof value.description === 'string')
    && (value.order === undefined || Number.isSafeInteger(value.order))
    && (value.broken === undefined || typeof value.broken === 'string')
}

function validAgentPresetsListResult(value: unknown): value is AgentPresetsListResult {
  return isRecord(value) && Array.isArray(value.presets) && value.presets.every(validAgentPreset)
    && (value.defaultId === undefined || typeof value.defaultId === 'string')
}

function validSettingsNamespace(value: unknown): value is SettingsNamespaceWire {
  return isRecord(value) && typeof value.ns === 'string'
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0
    && (value.applies === 'live' || value.applies === 'restart')
}

function validSettingsGetResult(value: unknown): value is SettingsGetResult {
  return isRecord(value) && Array.isArray(value.namespaces) && value.namespaces.every(validSettingsNamespace)
}

function validSettingsSetResult(value: unknown): value is SettingsSetResult {
  return isRecord(value) && typeof value.ns === 'string'
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0
}

/** The message of a thrown value (the transport only throws `Error`s; `String` covers the rest). */
function errorMessage(error: unknown): string {
  /* v8 ignore next -- the transport and dispose ladder reject only with Errors */
  return error instanceof Error ? error.message : String(error)
}
