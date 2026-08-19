/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import { foldRequestHeader, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-user-approval'
import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type {
  AgentPresetsListResult,
  AttachmentSaveImageParams,
  CommandExecuteParams,
  CommandExecuteResult,
  CommandListResult,
  InitializeParams,
  InitializeResult,
  InteractionRespondParams,
  InteractionRespondResult,
  JsonRpcTransportPeer,
  ModelCatalogResult,
  ProviderAuthCancelResult,
  ProviderAuthInfoResult,
  ProviderAuthLogoutResult,
  ProviderAuthRespondResult,
  ProviderAuthStartResult,
  SessionEventNotification,
  SessionHistoryResult,
  SessionListResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionSelectModelParams,
  SessionSelectModelResult,
  SettingsGetResult,
  SettingsNamespaceWire,
  SettingsSetResult,
  SkillsListResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'

const MAX_AUTH_RESPONSE_CHARS = 65_536

interface PendingInteraction {
  readonly kind: 'approval' | 'question'
  readonly sessionId: string
  readonly approvalId?: string
  readonly questions?: readonly AskUserQuestionItem[]
  readonly settle: (response: InteractionRespondParams | undefined) => void
}

interface PendingAuthPrompt {
  readonly settle: (value: string | undefined) => void
}

interface AuthFlow {
  readonly provider: string
  readonly controller: AbortController
  readonly prompts: Map<string, PendingAuthPrompt>
  readonly done: Promise<void>
}

interface CommandOperation {
  controller: AbortController
  done: Promise<CommandExecuteResult>
}

interface SessionRecord {
  handle: AgentHandle
  selection: ModelSelectionRef
  commands: Set<CommandOperation>
  closing: boolean
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

function nonEmptyStringParam(params: Record<string, unknown> | undefined, name: string): string {
  const value = params?.[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function sessionIdParam(params: Record<string, unknown> | undefined): string {
  return nonEmptyStringParam(params, 'sessionId')
}

function assertExactFields(
  params: Record<string, unknown> | undefined,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts params is Record<string, unknown> {
  if (params === undefined) throw new TypeError(`params must contain ${required.join(', ')}`)
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !(key in params)) || Object.keys(params).some(key => !allowed.has(key))) {
    throw new TypeError(`params fields must be exactly ${[...required, ...optional].join(', ')}`)
  }
}

function saveImageParams(
  params: Record<string, unknown> | undefined,
  limits: ImageAttachmentLimits,
): AttachmentSaveImageParams & { decoded: Uint8Array } {
  assertExactFields(params, ['data', 'mediaType'], ['name'])
  const data = params.data
  if (typeof data !== 'string' || data.length === 0) {
    throw new TypeError('data must be a non-empty canonical base64 string')
  }
  const maxEncodedLength = Math.ceil(limits.maxImageBytes / 3) * 4
  if (data.length > maxEncodedLength) {
    throw new RangeError('image base64 exceeds the active attachment byte limit')
  }
  const mediaType = params.mediaType
  if (typeof mediaType !== 'string' || !limits.mediaTypes.includes(mediaType as ImageMediaType)) {
    throw new TypeError('mediaType must be accepted by the active attachment service')
  }
  const name = params.name
  if (name !== undefined && typeof name !== 'string') {
    throw new TypeError('name must be a string when provided')
  }
  const decoded = Buffer.from(data, 'base64')
  if (decoded.toString('base64') !== data) {
    throw new TypeError('data must be canonical padded base64 without whitespace')
  }
  if (decoded.byteLength > limits.maxImageBytes) {
    throw new RangeError('image exceeds the active attachment byte limit')
  }
  return {
    data,
    mediaType: mediaType as ImageMediaType,
    ...name === undefined ? {} : { name },
    decoded: new Uint8Array(decoded),
  }
}

function selectModelParams(params: Record<string, unknown> | undefined): SessionSelectModelParams {
  const reasoningEffort = params?.reasoningEffort
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) {
    throw new TypeError('reasoningEffort must be a non-empty string when provided')
  }
  return {
    sessionId: sessionIdParam(params),
    provider: nonEmptyStringParam(params, 'provider'),
    model: nonEmptyStringParam(params, 'model'),
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}

function commandExecuteParams(params: Record<string, unknown> | undefined): CommandExecuteParams {
  return {
    sessionId: sessionIdParam(params),
    line: nonEmptyStringParam(params, 'line'),
  }
}

function authTypeParam(params: Record<string, unknown> | undefined): 'api_key' | 'oauth' {
  const type = params?.type
  if (type !== 'api_key' && type !== 'oauth') throw new TypeError('type must be "api_key" or "oauth"')
  return type
}

function interactionRespondParams(params: Record<string, unknown> | undefined): InteractionRespondParams {
  const requestId = nonEmptyStringParam(params, 'requestId')
  const kind = params?.kind
  if (kind === 'approval') {
    const outcome = params?.outcome
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      throw new TypeError('approval outcome must be "allowed-once" or "rejected"')
    }
    return { requestId, kind, outcome }
  }
  if (kind === 'question-cancelled') return { requestId, kind }
  if (kind !== 'question') throw new TypeError('interaction kind is invalid')
  const answer = params?.answer
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    throw new TypeError('question answer must be an object')
  }
  const answers = (answer as Record<string, unknown>).answers
  if (!Array.isArray(answers) || !answers.every((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
    const record = item as Record<string, unknown>
    return typeof record.id === 'string'
      && Array.isArray(record.selected) && record.selected.every(value => typeof value === 'string')
      && (record.custom === undefined || typeof record.custom === 'string')
  })) throw new TypeError('question answers are invalid')
  return { requestId, kind, answer: answer as AskUserQuestionAnswer }
}

function matchesQuestions(answer: AskUserQuestionAnswer, questions: readonly AskUserQuestionItem[]): boolean {
  if (answer.answers.length !== questions.length) return false
  return answer.answers.every((item, index) => {
    const question = questions[index]
    if (question === undefined || item.id !== question.id) return false
    if (new Set(item.selected).size !== item.selected.length) return false
    const custom = item.custom?.trim()
    if (custom !== undefined && custom.length === 0) return false
    if (question.multiSelect !== true && (item.selected.length > 1 || (custom !== undefined && item.selected.length > 0))) {
      return false
    }
    const labels = new Set(question.options?.map(option => option.label) ?? [])
    return item.selected.every(label => labels.has(label))
  })
}

function collectImageRefs(content: SessionPromptParams['contentBlocks'], refs: ImageAttachmentRef[] = []): ImageAttachmentRef[] {
  for (const block of content) {
    if (block.type === 'image') refs.push(block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
  return refs
}

function sameImageRef(left: ImageAttachmentRef, right: ImageAttachmentRef): boolean {
  const fields = new Set(['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name'])
  const expectedFieldCount = left.name === undefined ? 5 : 6
  return Object.keys(left).length === expectedFieldCount
    && Object.keys(left).every(field => fields.has(field))
    && left.attachmentId === right.attachmentId
    && left.mediaType === right.mediaType
    && left.bytes === right.bytes
    && left.width === right.width
    && left.height === right.height
    && left.name === right.name
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, { kind: 'create' | 'resume'; promise: Promise<SessionRecord> }>()
  private readonly sessionClosures = new Map<string, Promise<void>>()
  private readonly interactions = new Map<string, PendingInteraction>()
  private readonly authFlows = new Map<string, AuthFlow>()
  private readonly authFlowByProvider = new Map<string, string>()
  private readonly optionalServiceFibers: { dispose(): Promise<void> }[] = []
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
      }
      transport.notify('subagent.finished', payload)
    }))

    this.optionalServiceFibers.push(ctx.inject(['userQuestions'], (serviceCtx) => {
      const userQuestions = serviceCtx.get('userQuestions')
      if (userQuestions === undefined) throw new Error('user-questions service disappeared during SDK binding')
      serviceCtx.effect(
        () => userQuestions.registerProvider({ ask: request => this.requestQuestion(request) }),
        'sdkJsonRpc.userQuestionsProvider',
      )
    }))
    this.optionalServiceFibers.push(ctx.inject(['approval'], (serviceCtx) => {
      serviceCtx.on('approval/request', (request, next) => {
        if (request.signal?.aborted === true) return Promise.resolve('cancelled')
        const decided = new Set<string>()
        let approvalId: string | undefined
        for (let index = request.agent.session.events.length - 1; index >= 0; index -= 1) {
          const event = request.agent.session.events[index] as SessionEvent
          if (event.type === 'approval/decided') decided.add(event.data.id)
          if (event.type !== 'approval/asked' || decided.has(event.data.id)) continue
          if ((request.callId ?? null) !== (event.data.callId ?? null)) continue
          if ([...this.interactions.values()].some(entry => entry.approvalId === event.data.id)) continue
          approvalId = event.data.id
          break
        }
        if (approvalId === undefined) return next()
        return this.requestApproval(request.agent.session.id, approvalId, request.toolName, request.callId, request.reason, request.signal)
      })
    }))
  }

  /**
   * Configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    this.cwd = resolve(params.cwd)
    this.provider = params.provider
    this.model = params.model
    this.maxTokens = params.maxTokens
    if (!this.hasAdapterFor(this.provider)) {
      if (this.provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${this.provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek, {})
    }
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
  }

  /**
   * List every registered provider independently so one failed model lookup
   * cannot hide healthy routes.
   * @returns provider/model display metadata plus per-provider failures.
   */
  async catalog(): Promise<ModelCatalogResult> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) return { providers: [], failures: [] }
    const entries = await Promise.all(llm.listProviders().map(async (provider) => {
      try {
        const listed = await llm.listModels(provider.id)
        const models = await Promise.all(listed.map(async (model) => {
          const resolved = await llm.resolveModelInfo(provider.id, model.id)
          return {
            id: model.id,
            name: model.name,
            ...model.description === undefined ? {} : { description: model.description },
            ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
            ...resolved.reasoning === undefined ? {} : {
              reasoning: {
                efforts: resolved.reasoning.efforts.map(effort => ({
                  id: String(effort.id),
                  name: effort.name,
                  ...effort.description === undefined ? {} : { description: effort.description },
                })),
                ...resolved.reasoning.defaultEffort === undefined
                  ? {}
                  : { defaultEffort: String(resolved.reasoning.defaultEffort) },
              },
            },
          }
        }))
        return {
          kind: 'provider' as const,
          provider: { id: provider.id, name: provider.name, models },
        }
      } catch (error: unknown) {
        return {
          kind: 'failure' as const,
          failure: {
            id: provider.id,
            name: provider.name,
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }))
    return {
      providers: entries.flatMap(entry => entry.kind === 'provider' ? [entry.provider] : []),
      failures: entries.flatMap(entry => entry.kind === 'failure' ? [entry.failure] : []),
    }
  }

  /**
   * Read deployment-resolved image attachment limits.
   * @returns active upload policy.
   */
  imageLimits(): ImageAttachmentLimits {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      throw new Error('image attachments are unavailable: this runtime mounts no attachment service')
    }
    return {
      ...attachments.imageLimits,
      mediaTypes: [...attachments.imageLimits.mediaTypes],
    }
  }

  /**
   * Validate, decode, and durably save one canonical base64 image.
   * @param params - untrusted JSON-RPC upload fields.
   * @returns verified durable image reference.
   */
  async saveImage(params: Record<string, unknown> | undefined): Promise<ImageAttachmentRef> {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      throw new Error('image attachments are unavailable: this runtime mounts no attachment service')
    }
    const input = saveImageParams(params, attachments.imageLimits)
    return attachments.saveImage({
      data: input.decoded,
      mediaType: input.mediaType,
      ...input.name === undefined ? {} : { name: input.name },
    })
  }

  /**
   * List logical sessions through the configured query service.
   * @returns live-preferred durable records.
   */
  async listSessions(): Promise<SessionListResult> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) throw new Error('session listing is unavailable: this runtime mounts no session-query service')
    const sessions = await query.listSessions()
    return { sessions }
  }

  /**
   * Read one complete validated logical session without resuming it.
   * @param sessionId - logical session identity.
   * @returns detached header and complete event log.
   */
  async sessionHistory(sessionId: string): Promise<SessionHistoryResult> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) throw new Error('session history is unavailable: this runtime mounts no session-query service')
    return query.readSession(SessionId(sessionId))
  }

  /**
   * Explicitly resume one persisted session as a live SDK-owned agent.
   * @param sessionId - persisted session identity.
   * @returns resumed identity.
   */
  async resumeSession(sessionId: string): Promise<{ sessionId: string }> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    if (this.sessions.has(sessionId) || this.sessionClosures.has(sessionId)) {
      throw new Error(`SDK session is already live or closing: ${sessionId}`)
    }
    const pending = this.sessionCreations.get(sessionId)
    if (pending !== undefined) {
      if (pending.kind !== 'resume') throw new Error(`SDK session creation is already in progress: ${sessionId}`)
      await pending.promise
      return { sessionId }
    }
    const promise = this.resumePersistedSession(sessionId)
    this.trackSessionCreation(sessionId, 'resume', promise)
    await promise
    return { sessionId }
  }

  /**
   * Claim one pending interaction; synchronous removal makes first response win.
   * @param params - correlated approval or question response.
   * @returns accepted or rejected response receipt.
   */
  respondInteraction(params: InteractionRespondParams): InteractionRespondResult {
    const pending = this.interactions.get(params.requestId)
    if (pending === undefined) return { accepted: false, reason: 'not-pending' }
    if ((pending.kind === 'approval') !== (params.kind === 'approval')) {
      return { accepted: false, reason: 'bad-response' }
    }
    if (params.kind === 'question'
      && (pending.questions === undefined || !matchesQuestions(params.answer, pending.questions))) {
      return { accepted: false, reason: 'bad-response' }
    }
    pending.settle(params)
    return { accepted: true }
  }

  /**
   * Select a validated route for subsequent steps without mutating fixed Agent options.
   * @param params - target session and complete route selection.
   * @returns the adapter-resolved selection.
   */
  async selectModel(params: SessionSelectModelParams): Promise<SessionSelectModelResult> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) throw new Error('model selection is unavailable: this runtime mounts no LLM service')
    const rec = await this.getOrCreateSession(params.sessionId)
    const resolved = await llm.resolveCallConfig({
      provider: params.provider,
      model: params.model,
      ...params.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(params.reasoningEffort) },
    })
    if (rec.closing) throw new Error(`SDK session is closing: ${params.sessionId}`)
    const selected = {
      provider: resolved.provider,
      model: resolved.model,
      ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
    }
    rec.selection.current = selected
    return selected
  }

  /**
   * Request cancellation of current activity while preserving queued inbox work.
   * @param sessionId - existing SDK session id.
   * @returns acknowledgement only; `session.status` reports later convergence.
   */
  cancel(sessionId: string): { requested: boolean } {
    const rec = this.sessions.get(sessionId)
    if (rec === undefined || rec.closing) return { requested: false }
    const requested = rec.handle.agent.status === 'running'
    if (requested) rec.handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { requested }
  }

  /**
   * Close one SDK-owned agent to quiescence. Concurrent callers share ownership.
   * @param sessionId - existing SDK session id.
   * @returns whether a live or creating session was closed.
   */
  async closeSession(sessionId: string): Promise<{ closed: boolean }> {
    const existingClosure = this.sessionClosures.get(sessionId)
    if (existingClosure !== undefined) {
      await existingClosure
      return { closed: true }
    }
    const pending = this.sessionCreations.get(sessionId)
    const existing = this.sessions.get(sessionId)
    const target = existing ?? pending?.promise
    if (target === undefined) return { closed: false }
    if (existing !== undefined) existing.closing = true
    const closure = (async () => {
      const rec = await target
      rec.closing = true
      this.sessions.delete(sessionId)
      for (const pending of [...this.interactions.values()]) {
        if (pending.sessionId === sessionId) pending.settle(undefined)
      }
      await this.disposeSession(rec)
    })()
    this.sessionClosures.set(sessionId, closure)
    try {
      await closure
    } finally {
      this.sessionClosures.delete(sessionId)
    }
    return { closed: true }
  }

  /**
   * List effective commands for one session, or report capability absence.
   * @param sessionId - target SDK session.
   * @returns capability availability and effective descriptors.
   */
  async listCommands(sessionId: string): Promise<CommandListResult> {
    const commands = this.ctx.get('commands')
    if (commands === undefined) return { available: false, commands: [] }
    const rec = await this.getOrCreateSession(sessionId)
    if (rec.closing) throw new Error(`SDK session is closing: ${sessionId}`)
    return { available: true, commands: commands.list(rec.handle.agent).map(command => ({ ...command })) }
  }

  /**
   * Execute one registered slash command without submitting a user message.
   * @param params - target session and complete slash-command line.
   * @returns structured dispatch outcome.
   */
  async executeCommand(params: CommandExecuteParams): Promise<CommandExecuteResult> {
    const commands = this.ctx.get('commands')
    if (commands === undefined) {
      return { outcome: 'unavailable', message: 'command execution is unavailable: this runtime mounts no command registry' }
    }
    const rec = await this.getOrCreateSession(params.sessionId)
    if (rec.closing) return { outcome: 'error', message: `SDK session is closing: ${params.sessionId}` }
    const controller = new AbortController()
    const done = (async (): Promise<CommandExecuteResult> => {
      try {
        const execution = await commands.execute(rec.handle.agent, params.line, controller.signal)
        if (execution === undefined) {
          return { outcome: 'unknown-command', message: `unknown or invalid command: ${params.line}` }
        }
        if (execution.result.kind === 'error') {
          return { outcome: 'error', commandId: execution.commandId, message: execution.result.text }
        }
        return {
          outcome: 'success',
          commandId: execution.commandId,
          ...execution.result.text === undefined ? {} : { text: execution.result.text },
          ...execution.result.sourceEventSeq === undefined ? {} : { sourceEventSeq: execution.result.sourceEventSeq },
        }
      } catch (error: unknown) {
        return { outcome: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    })()
    const operation = { controller, done }
    rec.commands.add(operation)
    try {
      return await done
    } finally {
      rec.commands.delete(operation)
    }
  }

  /**
   * List the skill catalog for one lookup.
   * @param params - optional working directory for local skill discovery.
   * @returns the skill catalog.
   */
  async skillsList(params: Record<string, unknown> | undefined): Promise<SkillsListResult> {
    const skills = this.ctx.get('skills')
    if (skills === undefined) return { skills: [] }
    const cwd = params?.cwd
    const summaries: SkillSummary[] = await skills.list({ cwd: typeof cwd === 'string' ? cwd : undefined })
    return {
      skills: summaries.map((s: SkillSummary) => ({
        name: s.name,
        description: s.description,
        ...(s.whenToUse === undefined ? {} : { whenToUse: s.whenToUse }),
        source: s.source,
        provider: s.provider,
        modelInvocable: s.invocation.modelInvocable,
        userInvocable: s.invocation.userInvocable,
      })),
    }
  }

  /**
   * List the agent preset roster.
   * @returns the agent preset roster with the user's chosen default.
   */
  async agentPresetsList(): Promise<AgentPresetsListResult> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return { presets: [] }
    const roster: AgentPreset[] = await presets.list()
    return {
      presets: roster.map((p: AgentPreset) => ({
        id: p.id,
        trust: p.trust,
        path: p.path,
        ...(p.name === undefined ? {} : { name: p.name }),
        ...(p.description === undefined ? {} : { description: p.description }),
        ...(p.order === undefined ? {} : { order: p.order }),
        ...(p.broken === undefined ? {} : { broken: p.broken }),
      })),
      defaultId: presets.defaultId,
    }
  }

  /**
   * Describe every registered settings namespace for a configuration client.
   * @returns the redacted namespace descriptors.
   */
  async settingsGet(): Promise<SettingsGetResult> {
    const settings = this.ctx.get('settings') as SettingsProvider | undefined
    if (settings === undefined) return { namespaces: [] }
    const namespaces: SettingsNamespaceWire[] = settings
      .describe({ redactSecrets: true })
      .map(descriptor => ({
        ns: String(descriptor.ns),
        value: descriptor.value,
        revision: descriptor.revision,
        applies: descriptor.applies,
        ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
      }))
    return { namespaces }
  }

  /**
   * Write one registered settings namespace, then report its next state.
   * @param params - the namespace and the patch or wholesale section to apply.
   * @returns the namespace's resolved value and revision after the write.
   */
  async settingsSet(params: Record<string, unknown> | undefined): Promise<SettingsSetResult> {
    const settings = this.ctx.get('settings') as SettingsProvider | undefined
    if (settings === undefined) throw new Error('no settings provider is mounted')
    const namespace = settingsNamespace(nonEmptyStringParam(params, 'namespace'))
    const patch = params?.patch
    const replace = params?.replace
    const expectedRevision = params?.expectedRevision
    if (patch !== undefined && replace !== undefined) {
      throw new TypeError('settings/set: provide exactly one of patch or replace')
    }
    if (patch === undefined && replace === undefined) {
      throw new TypeError('settings/set: provide patch or replace')
    }
    let revision: number | undefined
    if (expectedRevision !== undefined) {
      if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new TypeError('settings/set: expectedRevision must be a non-negative safe integer')
      }
      revision = expectedRevision
    }
    if (patch !== undefined) {
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new TypeError('settings/set: patch must be a plain object')
      }
      await settings.update(namespace, patch, revision)
    } else {
      if (typeof replace !== 'object' || replace === null || Array.isArray(replace)) {
        throw new TypeError('settings/set: replace must be a plain object')
      }
      await settings.replace(namespace, replace, revision)
    }
    const descriptor = settings
      .describe({ redactSecrets: true })
      .find(candidate => String(candidate.ns) === String(namespace))
    if (descriptor === undefined) throw new Error(`settings namespace "${String(namespace)}" disappeared after write`)
    return { ns: String(descriptor.ns), value: descriptor.value, revision: descriptor.revision }
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    await this.validatePromptImages(params.contentBlocks)
    const rec = await this.getOrCreateSession(params.sessionId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery (as the ACP bridge does).
    if (rec.closing) throw new Error(`SDK session is closing: ${params.sessionId}`)
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${params.sessionId}`)
    }
    const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Read non-secret provider authentication methods and current state.
   * @param provider - registered provider route.
   * @returns method labels and configured state without credential values.
   */
  authInfo(provider: string): Promise<ProviderAuthInfoResult> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) throw new Error('provider authentication is unavailable: this runtime mounts no LLM service')
    return llm.authInfo(provider)
  }

  /**
   * Start one server-owned provider authentication flow.
   * @param provider - registered provider route.
   * @param type - exact provider-offered method.
   * @returns opaque flow identity before login work completes.
   */
  async startAuth(provider: string, type: 'api_key' | 'oauth'): Promise<ProviderAuthStartResult> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    if (this.authFlowByProvider.has(provider)) throw new Error(`authentication already active for provider "${provider}"`)
    const flowId = randomUUID()
    this.authFlowByProvider.set(provider, flowId)
    let info: ProviderAuthInfoResult
    try {
      info = await this.authInfo(provider)
      if (!info.methods.some(method => method.type === type)) {
        throw new Error(`provider "${provider}" does not offer ${type} authentication`)
      }
      // authInfo() is asynchronous. Shutdown may have started while it was in
      // flight, before this flow had entered authFlows and become quiesceable.
      if (this.shutdownTask !== undefined) throw new Error('SDK server is shutting down')
    } catch (error) {
      this.authFlowByProvider.delete(provider)
      throw error
    }
    const controller = new AbortController()
    const prompts = new Map<string, PendingAuthPrompt>()
    const done = Promise.resolve().then(async () => {
      let outcome: 'success' | 'cancelled' | 'error' = 'success'
      try {
        const llm = this.ctx.get('llm')
        if (llm === undefined) throw new Error('provider authentication is unavailable')
        await llm.login(provider, type, {
          signal: controller.signal,
          notify: (event) => { this.transport.notify('provider.auth.event', { flowId, provider, event }) },
          prompt: prompt => new Promise<string>((resolvePrompt, rejectPrompt) => {
            const promptId = randomUUID()
            let settled = false
            const promptSignal = prompt.signal
            const finish = (value: string | undefined): void => {
              if (settled) return
              settled = true
              prompts.delete(promptId)
              promptSignal?.removeEventListener('abort', onAbort)
              this.transport.notify('provider.auth.promptResolved', { flowId, promptId })
              if (value === undefined) rejectPrompt(new Error('authentication prompt cancelled'))
              else resolvePrompt(value)
            }
            const onAbort = (): void => { finish(undefined) }
            prompts.set(promptId, { settle: finish })
            promptSignal?.addEventListener('abort', onAbort, { once: true })
            if (promptSignal?.aborted === true || controller.signal.aborted) {
              finish(undefined)
              return
            }
            const { signal: _signal, ...wirePrompt } = prompt
            try {
              this.transport.notify('provider.auth.prompt', { flowId, provider, promptId, prompt: wirePrompt })
            } catch (error) {
              prompts.delete(promptId)
              promptSignal?.removeEventListener('abort', onAbort)
              rejectPrompt(error instanceof Error ? error : new Error('authentication prompt transport failed', { cause: error }))
            }
          }),
        })
      } catch (_error: unknown) {
        outcome = controller.signal.aborted ? 'cancelled' : 'error'
      } finally {
        for (const prompt of [...prompts.values()]) prompt.settle(undefined)
        this.authFlows.delete(flowId)
        this.authFlowByProvider.delete(provider)
        this.transport.notify('provider.auth.finished', {
          flowId,
          provider,
          outcome,
          ...outcome === 'error' ? { message: 'Provider authentication failed.' } : {},
        })
      }
    })
    const flow: AuthFlow = { provider, controller, prompts, done }
    this.authFlows.set(flowId, flow)
    return { flowId }
  }

  /**
   * Claim one pending authentication prompt; first response wins.
   * @param flowId - owning authentication flow.
   * @param promptId - exact pending prompt.
   * @param value - user response, never emitted back to clients.
   * @returns accepted or correlation-failure receipt.
   */
  respondAuth(flowId: string, promptId: string, value: string): ProviderAuthRespondResult {
    const flow = this.authFlows.get(flowId)
    if (flow === undefined) return { accepted: false, reason: 'bad-flow' }
    const prompt = flow.prompts.get(promptId)
    if (prompt === undefined) return { accepted: false, reason: 'not-pending' }
    flow.prompts.delete(promptId)
    prompt.settle(value)
    return { accepted: true }
  }

  /**
   * Cancel one active auth flow and every pending provider prompt.
   * @param flowId - flow to abort.
   * @returns whether an active flow received cancellation.
   */
  cancelAuth(flowId: string): ProviderAuthCancelResult {
    const flow = this.authFlows.get(flowId)
    if (flow === undefined) return { requested: false }
    flow.controller.abort(new Error('provider authentication cancelled'))
    for (const prompt of [...flow.prompts.values()]) prompt.settle(undefined)
    return { requested: true }
  }

  /**
   * Disconnect one provider-owned stored credential.
   * @param provider - registered provider route.
   * @returns confirmed disconnect result.
   */
  async logoutAuth(provider: string): Promise<ProviderAuthLogoutResult> {
    if (this.authFlowByProvider.has(provider)) throw new Error(`authentication active for provider "${provider}"`)
    const llm = this.ctx.get('llm')
    if (llm === undefined) throw new Error('provider authentication is unavailable: this runtime mounts no LLM service')
    await llm.logout(provider)
    return { disconnected: true }
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    for (const pending of [...this.interactions.values()]) pending.settle(undefined)
    for (const flow of [...this.authFlows.values()]) {
      flow.controller.abort(new Error('SDK server shutting down'))
      for (const prompt of [...flow.prompts.values()]) prompt.settle(undefined)
    }
    await Promise.allSettled([...this.authFlows.values()].map(flow => flow.done))
    const pendingCreations = [...this.sessionCreations.values()].map(entry => entry.promise)
    await Promise.allSettled(pendingCreations)
    await Promise.allSettled([...this.sessionClosures.values()])
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled([
      ...this.optionalServiceFibers.map(fiber => fiber.dispose()),
      ...records.map(rec => Promise.resolve().then(() => this.disposeSession(rec))),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.optionalServiceFibers.length = 0
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'llm/catalog':
        return this.catalog()
      case 'provider/authInfo':
        assertExactFields(params, ['provider'])
        return this.authInfo(nonEmptyStringParam(params, 'provider'))
      case 'provider/authStart':
        assertExactFields(params, ['provider', 'type'])
        return this.startAuth(nonEmptyStringParam(params, 'provider'), authTypeParam(params))
      case 'provider/authRespond': {
        assertExactFields(params, ['flowId', 'promptId', 'value'])
        const value = params.value
        if (typeof value !== 'string') throw new TypeError('value must be a string')
        if (value.length > MAX_AUTH_RESPONSE_CHARS) {
          throw new TypeError(`value must not exceed ${MAX_AUTH_RESPONSE_CHARS} characters`)
        }
        return this.respondAuth(nonEmptyStringParam(params, 'flowId'), nonEmptyStringParam(params, 'promptId'), value)
      }
      case 'provider/authCancel':
        assertExactFields(params, ['flowId'])
        return this.cancelAuth(nonEmptyStringParam(params, 'flowId'))
      case 'provider/authLogout':
        assertExactFields(params, ['provider'])
        return this.logoutAuth(nonEmptyStringParam(params, 'provider'))
      case 'attachment/imageLimits':
        return this.imageLimits()
      case 'attachment/saveImage':
        return this.saveImage(params)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'session/list':
        return this.listSessions()
      case 'session/history':
        return this.sessionHistory(sessionIdParam(params))
      case 'session/resume':
        return this.resumeSession(sessionIdParam(params))
      case 'session/selectModel':
        return this.selectModel(selectModelParams(params))
      case 'session/cancel':
        return this.cancel(sessionIdParam(params))
      case 'session/close':
        return this.closeSession(sessionIdParam(params))
      case 'command/list':
        return this.listCommands(sessionIdParam(params))
      case 'command/execute':
        return this.executeCommand(commandExecuteParams(params))
      case 'interaction/respond':
        return this.respondInteraction(interactionRespondParams(params))
      case 'skills/list':
        return this.skillsList(params)
      case 'agent-presets/list':
        return this.agentPresetsList()
      case 'settings/get':
        return this.settingsGet()
      case 'settings/set':
        assertExactFields(params, ['namespace'], ['patch', 'replace', 'expectedRevision'])
        return this.settingsSet(params)
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    if (this.sessionClosures.has(sessionId)) throw new Error(`SDK session is closing: ${sessionId}`)
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending.promise
    const creation = this.createSession(sessionId)
    this.trackSessionCreation(sessionId, 'create', creation)
    return creation
  }

  private trackSessionCreation(
    sessionId: string,
    kind: 'create' | 'resume',
    promise: Promise<SessionRecord>,
  ): void {
    this.sessionCreations.set(sessionId, { kind, promise })
    void promise.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
  }

  private async createSession(sessionId: string): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
    const selection: ModelSelectionRef = {
      current: { provider: this.provider, model: this.model },
      assembled: undefined,
    }
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: this.cwd },
      agentOptions: {
        provider: this.provider,
        model: this.model,
        ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
      },
      setup: (agentCtx) => { installModelSelection(agentCtx, selection) },
    })
    const rec: SessionRecord = { handle, selection, commands: new Set(), closing: false }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private async resumePersistedSession(sessionId: string): Promise<SessionRecord> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) throw new Error('session resume is unavailable: this runtime mounts no session-query service')
    const snapshot = await query.readSession(SessionId(sessionId))
    if (snapshot.session.agentPreset !== undefined) {
      throw new Error(`session resume does not support preset-backed session: ${sessionId}`)
    }
    const config = foldRequestHeader(snapshot.events)?.config
    const provider = config?.provider ?? this.provider
    const model = config?.model ?? this.model
    const selection: ModelSelectionRef = {
      current: {
        provider,
        model,
        ...config?.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
      },
      assembled: undefined,
    }
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: {
        provider,
        model,
        ...config?.maxTokens === undefined
          ? (this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens })
          : { maxTokens: config.maxTokens },
      },
      setup: (agentCtx) => { installModelSelection(agentCtx, selection) },
    })
    const rec: SessionRecord = { handle, selection, commands: new Set(), closing: false }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private async disposeSession(rec: SessionRecord): Promise<void> {
    for (const operation of rec.commands) operation.controller.abort(new Error('SDK session closed'))
    await Promise.allSettled([...rec.commands].map(operation => operation.done))
    await rec.handle.dispose()
  }

  private async validatePromptImages(content: SessionPromptParams['contentBlocks']): Promise<void> {
    const refs = collectImageRefs(content)
    if (refs.length === 0) return
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      throw new Error('image attachments are unavailable: this runtime mounts no attachment service')
    }
    if (refs.length > attachments.imageLimits.maxImagesPerMessage) {
      throw new AttachmentError('Prompt exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
    }
    let totalBytes = 0
    for (const ref of refs) {
      const stored = await attachments.readImage(ref)
      if (!sameImageRef(ref, stored.ref) || stored.data.byteLength !== stored.ref.bytes) {
        throw new AttachmentError('Prompt image reference does not match the stored image.', 'INVALID_ATTACHMENT_REF')
      }
      totalBytes += stored.data.byteLength
      if (totalBytes > attachments.imageLimits.maxMessageImageBytes) {
        throw new AttachmentError('Prompt exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
      }
    }
  }

  private requestApproval(
    sessionId: SessionId,
    approvalId: string,
    toolName: string,
    callId: string | undefined,
    reason: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<'allowed-once' | 'rejected' | 'cancelled'> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const onAbort = (): void => { pending.settle(undefined) }
      const pending: PendingInteraction = {
        kind: 'approval', sessionId, approvalId,
        settle: (response) => {
          if (!this.interactions.delete(requestId)) return
          signal?.removeEventListener('abort', onAbort)
          const outcome = response?.kind === 'approval' ? response.outcome : 'cancelled'
          this.notifyInteractionResolved(requestId, sessionId, outcome)
          resolve(outcome)
        },
      }
      this.interactions.set(requestId, pending)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted === true) {
        pending.settle(undefined)
        return
      }
      try {
        this.transport.notify('interaction.requested', {
          kind: 'approval', requestId, sessionId, approvalId, toolName,
          ...callId === undefined ? {} : { callId },
          ...reason === undefined ? {} : { reason },
        })
      } catch (error: unknown) {
        this.interactions.delete(requestId)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private requestQuestion(request: {
    questions: AskUserQuestionItem[]
    agent?: Agent
    signal?: AbortSignal
  }): Promise<AskUserQuestionAnswer> {
    const sessionId = request.agent?.session.id
    if (sessionId === undefined) {
      return Promise.reject(new UserQuestionError('SDK user interaction requires an agent-owned session', 'ASK_MISSING_AGENT'))
    }
    const questions = structuredClone(request.questions)
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const onAbort = (): void => { pending.settle(undefined) }
      const pending: PendingInteraction = {
        kind: 'question', sessionId, questions,
        settle: (response) => {
          if (!this.interactions.delete(requestId)) return
          request.signal?.removeEventListener('abort', onAbort)
          if (response?.kind === 'question' && matchesQuestions(response.answer, questions)) {
            this.notifyInteractionResolved(requestId, sessionId, 'answered')
            resolve(response.answer)
            return
          }
          this.notifyInteractionResolved(requestId, sessionId, 'cancelled')
          reject(new UserQuestionError('the SDK user question was cancelled or answered incorrectly', 'ASK_CANCELLED'))
        },
      }
      this.interactions.set(requestId, pending)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      if (request.signal?.aborted === true) {
        pending.settle(undefined)
        return
      }
      try {
        this.transport.notify('interaction.requested', {
          kind: 'question', requestId, sessionId, questions,
        })
      } catch (error: unknown) {
        this.interactions.delete(requestId)
        request.signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private notifyInteractionResolved(
    requestId: string,
    sessionId: string,
    outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'answered',
  ): void {
    try {
      this.transport.notify('interaction.resolved', { requestId, sessionId, outcome })
    } catch {
      // A failed terminal notification cannot reverse or strand the owned interaction settlement.
    }
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}
