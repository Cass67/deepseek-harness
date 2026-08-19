/**
 * Named wire types for the DeepSeek Harness SDK runtime protocol: every
 * request/result pair and the server-to-client notification payloads
 * exchanged over the newline-delimited JSON-RPC stdio transport. The server
 * plugin (`@deepseek-ai/dsh-sdk-jsonrpc-server`) and SDK clients share these shapes;
 * `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/types
 */

import type { ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {
  ContentBlock,
  LlmAuthEvent,
  LlmProviderAuthInfo,
  LlmProviderAuthMethod,
  ModelModality,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SurfaceOp } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

/** Parameters for the process-wide SDK handshake. */
export interface InitializeParams {
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Provider route every SDK-created agent runs on. */
  provider: string
  /** Model name every SDK-created agent runs on (the server may mount a fallback adapter; see `HarnessSdkJsonRpcServer.initialize`). */
  model: string
  /** Optional positive output-token cap inherited by SDK-created agents and their in-process descendants. */
  maxTokens?: number
}

/** Wire-stable server identity returned by initialization. */
export interface InitializeResult {
  /** Wire-stable server identity (`deepseek-harness-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
}

/** Canonical base64 upload for one durable image attachment. */
export interface AttachmentSaveImageParams {
  /** Canonical padded base64 with no data-URL prefix or whitespace. */
  data: string
  /** Caller-declared media type, verified against decoded bytes by the attachment service. */
  mediaType: ImageMediaType
  /** Optional display name; storage providers remove local path information. */
  name?: string
}

/** Active deployment image admission limits. */
export type AttachmentImageLimitsResult = ImageAttachmentLimits

/** Durable image reference returned after verified storage. */
export type AttachmentSaveImageResult = ImageAttachmentRef

/** One user turn on one SDK session. */
export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: ContentBlock[]
}

/** Durable enqueue receipt for one prompt. */
export interface SessionPromptResult {
  /** Identity of the queued user message. */
  messageId: string
}

/** One adapter-owned reasoning effort offered by a catalog model. */
export interface ModelCatalogReasoningEffort {
  /** Stable value accepted by model selection. */
  id: string
  /** Human-readable selector label. */
  name: string
  /** Optional user-facing distinction from adjacent efforts. */
  description?: string
}

/** Selectable reasoning metadata for one catalog model. */
export interface ModelCatalogReasoning {
  /** Supported efforts in adapter-preferred display order. */
  efforts: ModelCatalogReasoningEffort[]
  /** Adapter-configured default; absence preserves provider behavior. */
  defaultEffort?: string
}

/** One model advertised by a registered provider route. */
export interface ModelCatalogEntry {
  /** Provider-owned model id used for selection. */
  id: string
  /** Human-readable model name. */
  name: string
  /** Optional user-facing model description. */
  description?: string
  /** Accepted input modalities when the adapter declares them. */
  inputModalities?: ModelModality[]
  /** Adapter-owned reasoning levels when exact model resolution exposes them. */
  reasoning?: ModelCatalogReasoning
}

/** One healthy registered provider and its advertised models. */
export interface ModelProviderCatalog {
  /** Provider route id used for selection. */
  id: string
  /** Human-readable provider name. */
  name: string
  /** Models returned by this provider. */
  models: ModelCatalogEntry[]
}

/** One provider whose model listing failed without hiding healthy providers. */
export interface ModelCatalogFailure {
  /** Provider route whose listing failed. */
  id: string
  /** Human-readable provider name. */
  name: string
  /** Rendered listing failure. */
  message: string
}

/** Provider/model catalog with independent provider failures. */
export interface ModelCatalogResult {
  /** Healthy provider groups, including groups with no advertised models. */
  providers: ModelProviderCatalog[]
  /** Failed provider lookups. */
  failures: ModelCatalogFailure[]
}

/** Non-secret authentication information for one provider route. */
export interface ProviderAuthInfoParams { provider: string }
/** Non-secret provider-native authentication state. */
export type ProviderAuthInfoResult = LlmProviderAuthInfo
/** One provider-native authentication method offered to a client. */
export type ProviderAuthMethod = LlmProviderAuthMethod

/** Start one asynchronous provider-owned login flow. */
export interface ProviderAuthStartParams { provider: string; type: 'api_key' | 'oauth' }
/** Opaque identity returned before provider login work completes. */
export interface ProviderAuthStartResult { flowId: string }

/** Respond to one still-pending provider auth prompt. */
export interface ProviderAuthRespondParams { flowId: string; promptId: string; value: string }
/** First-response-wins authentication prompt receipt. */
export interface ProviderAuthRespondResult { accepted: boolean; reason?: 'not-pending' | 'bad-flow' }

/** Cancel one provider auth flow. */
export interface ProviderAuthCancelParams { flowId: string }
/** Whether a live provider authentication flow received cancellation. */
export interface ProviderAuthCancelResult { requested: boolean }

/** Remove one provider's stored native credential. */
export interface ProviderAuthLogoutParams { provider: string }
/** Confirmed provider disconnect result. */
export interface ProviderAuthLogoutResult { disconnected: boolean }

/** Provider login prompt detached from process-local abort signals. */
export type ProviderAuthPrompt =
  | { type: 'text' | 'secret' | 'manual_code'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: { id: string; label: string; description?: string }[] }

/** Provider-native non-secret progress for one correlated flow. */
export interface ProviderAuthEventNotification { flowId: string; provider: string; event: LlmAuthEvent }
/** One correlated provider login prompt awaiting a client response. */
export interface ProviderAuthPromptNotification {
  flowId: string
  provider: string
  promptId: string
  prompt: ProviderAuthPrompt
}
/** Terminal settlement of one provider login prompt. */
export interface ProviderAuthPromptResolvedNotification { flowId: string; promptId: string }
/** Terminal outcome of one provider authentication flow. */
export interface ProviderAuthFinishedNotification {
  flowId: string
  provider: string
  outcome: 'success' | 'cancelled' | 'error'
  message?: string
}

/** Select one route for a session's subsequent steps. */
export interface SessionSelectModelParams {
  /** Target SDK session; an unknown id creates an idle session. */
  sessionId: string
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Optional adapter-owned reasoning effort. */
  reasoningEffort?: string
}

/** Route accepted for subsequent session steps. */
export interface SessionSelectModelResult {
  /** Fully resolved provider route. */
  provider: string
  /** Fully resolved model id. */
  model: string
  /** Fully resolved reasoning effort when one applies. */
  reasoningEffort?: string
}

/** Target for session cancellation or closure. */
export interface SessionControlParams {
  /** Existing SDK session id. */
  sessionId: string
}

/** Cancellation acknowledgement; idle convergence remains observable through `session.status`. */
export interface SessionCancelResult {
  /** Whether a running activity received a cancellation request. */
  requested: boolean
}

/** Session-close result after the server-owned agent reaches quiescence. */
export interface SessionCloseResult {
  /** Whether an SDK-owned live session was found and closed. */
  closed: boolean
}

/** Immutable human-command metadata. */
export interface CommandDescriptor {
  /** Lowercase command name without a slash. */
  name: string
  /** Human-readable command summary. */
  description: string
  /** Optional free-form input hint. */
  input?: { hint: string }
}

/** Command discovery for one session. */
export interface CommandListResult {
  /** Whether this runtime composes the command registry capability. */
  available: boolean
  /** Effective global and session-scoped commands. */
  commands: CommandDescriptor[]
}

/** Execute one complete slash-command line against an existing session. */
export interface CommandExecuteParams {
  /** Existing SDK session id. */
  sessionId: string
  /** Complete slash-command line. */
  line: string
}

/** Structured command dispatch outcome. */
export type CommandExecuteResult =
  | { outcome: 'unavailable'; message: string }
  | { outcome: 'unknown-command'; message: string }
  | { outcome: 'success'; commandId: string; text?: string; sourceEventSeq?: number }
  | { outcome: 'error'; commandId?: string; message: string }

/** One logical session visible through the configured session-query service. */
export interface SessionListEntry {
  /** Detached durable header. */
  header: SessionHeader
  /** Whether the session is currently attached to this runtime. */
  live: boolean
  /** Whether persistence currently materializes the session. */
  persisted: boolean
}

/** Complete logical session list, newest first. */
export interface SessionListResult {
  /** Live-preferred records returned by `ctx.sessionQuery`. */
  sessions: SessionListEntry[]
}

/** Validated durable event envelope with an extension-owned JSON object payload. */
export interface SessionHistoryEvent {
  /** Non-empty session event type; extension-owned values remain open. */
  type: string
  /** Zero-based contiguous event sequence. */
  seq: number
  /** Safe-integer Unix epoch milliseconds. */
  time: number
  /** Event payload; owning plugins define fields within this JSON object. */
  data: object
  /** Optional surface mutation metadata. */
  surfaceOp?: SurfaceOp
  /** Optional earlier event sequences used by surface projection. */
  sourceEventSeqs?: readonly number[]
  /** Unknown readers may skip this event when true. */
  ignorable?: true
}

/** Exact validated durable history for one logical session. */
export interface SessionHistoryResult {
  /** Detached durable header and full raw event log from one observation. */
  session: SessionHeader
  /** Complete contiguous event envelopes with JSON object payloads. */
  events: SessionHistoryEvent[]
}

/** Result of explicitly resuming one persisted session. */
export interface SessionResumeResult {
  /** Resumed session identity. */
  sessionId: string
}

/** Stable request id echoed by an interaction response. */
export type InteractionRequestId = string

/** One pending approval or user-question request. */
export type InteractionRequestedNotification =
  | {
    kind: 'approval'
    requestId: InteractionRequestId
    sessionId: string
    approvalId: ApprovalRequestId
    toolName: string
    callId?: string
    reason?: string
  }
  | {
    kind: 'question'
    requestId: InteractionRequestId
    sessionId: string
    questions: AskUserQuestionItem[]
  }

/** Terminal state for a previously requested interaction. */
export interface InteractionResolvedNotification {
  /** Stable request id from `interaction.requested`. */
  requestId: InteractionRequestId
  /** Request owner. */
  sessionId: string
  /** Terminal outcome. */
  outcome: ApprovalOutcome | 'answered'
}

/** Answer one still-pending SDK interaction. */
export type InteractionRespondParams = {
  /** Stable request id from `interaction.requested`. */
  requestId: InteractionRequestId
} & (
  | { kind: 'approval'; outcome: 'allowed-once' | 'rejected' }
  | { kind: 'question'; answer: AskUserQuestionAnswer }
  | { kind: 'question-cancelled' }
)

/** First-response-wins acknowledgement. */
export interface InteractionRespondResult {
  /** True only when this response claimed the pending request. */
  accepted: boolean
  /** Rejection reason for malformed correlation or a settled id. */
  reason?: 'not-pending' | 'bad-response'
}

/** Deployment-mapped SDK outcome: `ok` for an accepted result, `error` otherwise. */
export type SdkRunStatus = 'ok' | 'error'

/** `session.event` payload: one session-log event, streamed as it is recorded. */
export interface SessionEventNotification {
  /** Session the event belongs to (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** Whole-agent lifecycle state for one session. */
export interface SessionStatusNotification {
  /** Session whose live agent changed status. */
  sessionId: string
  /** The whole-agent state after the transition. */
  status: 'idle' | 'running'
}

/** `subagent.started` payload: an in-runtime child session was created. */
export interface SubagentStartedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The new child session. */
  childSessionId: string
}

/** `subagent.finished` payload: an in-process subagent run ended (remote runs are not reported). */
export interface SubagentFinishedNotification {
  /** Subagent provider name that ran the child. */
  provider: string
  /** The child agent's id (equals {@link childSessionId} for local runs). */
  agentId: string
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** Deployment-mapped run outcome. */
  status: SdkRunStatus
  /** The provider-reported stop reason. */
  stopReason: SubagentStopReason
  /** The child's selected assistant output; absent when the child produced none. */
  lastAssistantMessage?: ContentBlock[]
}

/** Parameters for the skill catalog query. */
export interface SkillsListParams {
  /** Optional working directory for local skill discovery. */
  cwd?: string
}

/** One skill in the catalog, as seen by a discovery consumer. */
export interface SkillSummaryWire {
  /** Kebab-case identifier used to address the skill. */
  name: string
  /** Short routing description shown by discovery consumers. */
  description: string
  /** Optional extra routing guidance. */
  whenToUse?: string
  /** Discovery source that produced this winning skill. */
  source: string
  /** Provider that owns this skill body. */
  provider: string
  /** Whether model-facing catalogs include this skill. */
  modelInvocable: boolean
  /** Whether human-facing command catalogs include this skill. */
  userInvocable: boolean
}

/** The skill catalog for one lookup. */
export interface SkillsListResult {
  skills: SkillSummaryWire[]
}

/** One agent preset in the roster. */
export interface AgentPresetWire {
  /** Stable identifier; the preset directory's name. */
  id: string
  /** Trust recorded from the root this preset was discovered under. */
  trust: string
  /** Absolute path of the preset's agent composition file. */
  path: string
  /** Display name from the preset's own metadata; absent falls back to id. */
  name?: string
  /** One sentence on what this preset is for, when it published one. */
  description?: string
  /** Declared position within its group. */
  order?: number
  /** Why this preset cannot compose a session, absent when it can. */
  broken?: string
}

/** The agent preset roster. */
export interface AgentPresetsListResult {
  presets: AgentPresetWire[]
  /** The user's chosen default preset, when one is set. */
  defaultId?: string
}

/** One registered settings namespace as surfaced to a configuration client. */
export interface SettingsNamespaceWire {
  /** The registered namespace (lowercase kebab-case). */
  ns: string
  /** Current resolved value: schema defaults, then base, then the user layer. */
  value: unknown
  /**
   * Monotonic revision of the raw user section this was read at; send it back
   * as `expectedRevision` on a write to refuse a stale one.
   */
  revision: number
  /** Whether changes take effect live or require a restart. */
  applies: 'live' | 'restart'
  /** Raw user section, when one exists and is well-formed. */
  user?: unknown
}

/** Every registered settings namespace. */
export interface SettingsGetResult {
  namespaces: SettingsNamespaceWire[]
}

/** Write one registered settings namespace. */
export interface SettingsSetParams {
  /** The registered namespace to write. */
  namespace: string
  /** Merge this partial patch into the user layer (mutually exclusive with `replace`). */
  patch?: Record<string, unknown>
  /** Replace the user section wholesale (mutually exclusive with `patch`). */
  replace?: Record<string, unknown>
  /** The revision the caller read; a namespace that moved past it refuses the write. */
  expectedRevision?: number
}

/** The namespace after a successful write. */
export interface SettingsSetResult {
  ns: string
  value: unknown
  revision: number
}

/** Server-to-client notifications by JSON-RPC method name. */
export interface HarnessSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'interaction.requested': InteractionRequestedNotification
  'interaction.resolved': InteractionResolvedNotification
  'provider.auth.event': ProviderAuthEventNotification
  'provider.auth.prompt': ProviderAuthPromptNotification
  'provider.auth.promptResolved': ProviderAuthPromptResolvedNotification
  'provider.auth.finished': ProviderAuthFinishedNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
}

/** Client-to-server request methods with their param and result shapes. */
export interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'llm/catalog': { params: undefined; result: ModelCatalogResult }
  'provider/authInfo': { params: ProviderAuthInfoParams; result: ProviderAuthInfoResult }
  'provider/authStart': { params: ProviderAuthStartParams; result: ProviderAuthStartResult }
  'provider/authRespond': { params: ProviderAuthRespondParams; result: ProviderAuthRespondResult }
  'provider/authCancel': { params: ProviderAuthCancelParams; result: ProviderAuthCancelResult }
  'provider/authLogout': { params: ProviderAuthLogoutParams; result: ProviderAuthLogoutResult }
  'attachment/imageLimits': { params: undefined; result: AttachmentImageLimitsResult }
  'attachment/saveImage': { params: AttachmentSaveImageParams; result: AttachmentSaveImageResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'session/list': { params: undefined; result: SessionListResult }
  'session/history': { params: SessionControlParams; result: SessionHistoryResult }
  'session/resume': { params: SessionControlParams; result: SessionResumeResult }
  'session/selectModel': { params: SessionSelectModelParams; result: SessionSelectModelResult }
  'session/cancel': { params: SessionControlParams; result: SessionCancelResult }
  'session/close': { params: SessionControlParams; result: SessionCloseResult }
  'command/list': { params: SessionControlParams; result: CommandListResult }
  'command/execute': { params: CommandExecuteParams; result: CommandExecuteResult }
  'interaction/respond': { params: InteractionRespondParams; result: InteractionRespondResult }
  'skills/list': { params: SkillsListParams; result: SkillsListResult }
  'agent-presets/list': { params: undefined; result: AgentPresetsListResult }
  'settings/get': { params: undefined; result: SettingsGetResult }
  'settings/set': { params: SettingsSetParams; result: SettingsSetResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}
