#!/usr/bin/env node
/**
 * Scripted stand-in for the DeepSeek Harness SDK runtime, driven entirely by
 * env vars — no model, no network, no harness imports. Speaks the runtime's
 * newline-delimited JSON-RPC protocol on stdio: answers `initialize`,
 * `session/prompt` (streaming scripted `session.event` notifications, then
 * `session.finished`, then the response), and `shutdown`.
 *
 * Script vocabulary (all optional):
 * - `FAKE_TEXT`: assistant text for each turn (default `hello from fake runtime`).
 * - `FAKE_STATUS`: the `session.finished` status (default `ok`).
 * - `FAKE_REASON_KIND`: the `session.finished` reason kind (default `completed`; `none` omits the reason).
 * - `FAKE_SUBAGENT`: also emit a child session (subagent.started + child event + subagent.finished).
 * - `FAKE_ECHO_CWD`: prefix the assistant text with the process cwd.
 * - `FAKE_ECHO_ENV`: comma-separated env names to echo as `name=value` lines in the assistant text.
 * - `FAKE_MALFORMED`: `initialize` returns `{}` (no serverInfo); `prompt` returns `{}` (no accepted).
 * - `FAKE_MALFORMED_PROMPT`: `initialize` is normal; only `prompt` returns `{}` (no accepted).
 * - `FAKE_INIT_ERROR`: `initialize` answers a JSON-RPC error response with code 7.
 * - `FAKE_INIT_ERROR_ONCE_FILE`: fail `initialize` (code 7) only when this
 *   marker file does NOT exist yet, creating it — so the first runtime
 *   process fails the handshake and a respawned one succeeds (retry probe).
 * - `FAKE_ECHO_CWD_IN_INIT`: reply `serverInfo.version` = this process's cwd
 *   (wire-visible spawn-cwd probe).
 * - `FAKE_MALFORMED_EVENT`: the turn's `session.event` carries a number as
 *   the event; `FAKE_MALFORMED_MESSAGE`: assistant/message content is not an
 *   array; `FAKE_MESSAGE_WITHOUT_DATA`: assistant/message with no data
 *   member; `FAKE_MALFORMED_REASON`: `session.finished` reason is a bare
 *   string (wire-validation probes).
 * - `FAKE_EMPTY_MESSAGE`: the turn streams a text chunk, then records an empty
 *   assistant/message for a usage-only max-tokens step.
 * - `FAKE_HANG_INIT`: never answer `initialize` (mid-handshake cancel probe).
 * - `FAKE_INIT_READY` + `FAKE_INIT_GO`: touch the READY file when `initialize`
 *   arrives, then poll for the GO file before answering (deterministic
 *   cancel-during-handshake window).
 * - `FAKE_HANG_PROMPT`: never answer `session/prompt` (for timeout/dispose tests).
 * - `FAKE_STREAM_THEN_MALFORMED`: stream a text chunk for the prompt, then
 *   answer `{}` (no accepted) — same-pipe ordering makes the chunk arrive
 *   before the protocol failure (partial-output retention probe).
 * - `FAKE_IGNORE_EOF` + `FAKE_SIGTERM_FILE`: keep running after stdin EOF; touch the file on SIGTERM (ladder probe).
 * - `FAKE_TRAP_SIGTERM`: with `FAKE_IGNORE_EOF`, survive SIGTERM too (SIGKILL-rung probe).
 * - `FAKE_EXIT_BEFORE_INIT`: exit 3 immediately (spawn-then-die probe).
 * - `FAKE_STDERR`: write this line to stderr at boot (diagnostics-tail probe).
 * - `FAKE_STDERR_NO_NEWLINE`: write this to stderr WITHOUT a newline (buffer-flush probe).
 * - `FAKE_RECORD_INIT`: append each `initialize` params JSON to this file (handshake probe).
 */

import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { createInterface } from 'node:readline'

const env = process.env

if (env.FAKE_STDERR !== undefined) process.stderr.write(`${env.FAKE_STDERR}\n`)
if (env.FAKE_STDERR_NO_NEWLINE !== undefined) process.stderr.write(env.FAKE_STDERR_NO_NEWLINE)
if (env.FAKE_EXIT_BEFORE_INIT !== undefined) process.exit(3)

if (env.FAKE_IGNORE_EOF !== undefined) {
  // Simulate a runtime that never quiesces from EOF so the dispose ladder
  // must escalate; record which rung fired.
  process.stdin.resume()
  process.stdin.on('end', () => { setInterval(() => {}, 1_000) })
  process.on('SIGTERM', () => {
    if (env.FAKE_SIGTERM_FILE !== undefined) writeFileSync(env.FAKE_SIGTERM_FILE, 'sigterm\n')
    if (env.FAKE_TRAP_SIGTERM === undefined) process.exit(0)
  })
}

function write(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function notify(method: string, params: object): void {
  write({ jsonrpc: '2.0', method, params })
}

let authFlow: { flowId: string; promptId: string; provider: string } | undefined
let seq = 0
function event(sessionId: string, type: string, data: object): void {
  notify('session.event', { sessionId, event: { type, seq: seq++, time: 0, data } })
}

function assistantText(): string {
  const parts: string[] = []
  if (env.FAKE_ECHO_CWD !== undefined) parts.push(`cwd=${process.cwd()}`)
  for (const name of (env.FAKE_ECHO_ENV ?? '').split(',').filter(entry => entry.length > 0)) {
    parts.push(`${name}=${env[name] ?? ''}`)
  }
  parts.push(env.FAKE_TEXT ?? 'hello from fake runtime')
  return parts.join('\n')
}

function runTurn(sessionId: string): void {
  const text = assistantText()
  if (env.FAKE_MALFORMED_EVENT !== undefined) {
    notify('session.event', { sessionId, event: 42 })
    return
  }
  event(sessionId, 'turn/start', { turn: 0 })
  event(sessionId, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text } })
  if (env.FAKE_MALFORMED_MESSAGE !== undefined) {
    event(sessionId, 'assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: 'fake-malformed-message',
        role: 'assistant',
        content: 'not-an-array',
        source: { kind: 'model', provider: 'fake', model: 'fake' },
      },
    })
    return
  }
  if (env.FAKE_MESSAGE_WITHOUT_DATA !== undefined) {
    notify('session.event', { sessionId, event: { type: 'assistant/message', seq: seq++, time: 0 } })
    return
  }
  event(sessionId, 'assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: `fake-assistant-${seq}`,
      role: 'assistant',
      // Model the usage-only message recorded after a max-tokens step that
      // assembled no output blocks.
      content: env.FAKE_EMPTY_MESSAGE !== undefined ? [] : [{ type: 'text', text }],
      source: { kind: 'model', provider: 'fake', model: 'fake' },
    },
  })
  const reasonKind = env.FAKE_REASON_KIND ?? 'completed'
  event(sessionId, 'turn/end', { turn: 0, reason: { kind: reasonKind } })
  if (env.FAKE_SUBAGENT !== undefined) {
    const childId = `${sessionId}-child`
    notify('subagent.started', { parentSessionId: sessionId, childSessionId: childId })
    event(childId, 'assistant/message', {
      turn: 0,
      step: 0,
      content: [{ type: 'text', text: 'child says hi' }],
      provenance: { provider: 'fake', model: 'fake' },
    })
    notify('subagent.finished', {
      provider: 'spawn',
      agentId: childId,
      parentSessionId: sessionId,
      childSessionId: childId,
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'child says hi' }],
    })
  }
}

function sessionIdOf(params: Record<string, unknown> | undefined): string {
  const value = params?.sessionId
  return typeof value === 'string' ? value : ''
}

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  if (line.trim().length === 0) return
  const frame = JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, unknown> }
  if (frame.method === undefined || frame.id === undefined) return
  const respond = (result: object): void => { write({ jsonrpc: '2.0', id: frame.id, result }) }
  switch (frame.method) {
    case 'initialize':
      if (env.FAKE_RECORD_INIT !== undefined) appendFileSync(env.FAKE_RECORD_INIT, `${JSON.stringify(frame.params)}\n`)
      if (env.FAKE_HANG_INIT !== undefined) return
      if (env.FAKE_INIT_READY !== undefined && env.FAKE_INIT_GO !== undefined) {
        writeFileSync(env.FAKE_INIT_READY, 'ready\n')
        const go = env.FAKE_INIT_GO
        const id = frame.id
        const poll = setInterval(() => {
          if (!existsSync(go)) return
          clearInterval(poll)
          write({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } })
        }, 5)
        return
      }
      if (env.FAKE_INIT_ERROR !== undefined) {
        write({ jsonrpc: '2.0', id: frame.id, error: { code: 7, message: 'scripted init failure', data: { hint: 'fake' } } })
        return
      }
      if (env.FAKE_INIT_ERROR_ONCE_FILE !== undefined && !existsSync(env.FAKE_INIT_ERROR_ONCE_FILE)) {
        writeFileSync(env.FAKE_INIT_ERROR_ONCE_FILE, 'failed-once\n')
        write({ jsonrpc: '2.0', id: frame.id, error: { code: 7, message: 'scripted first-boot failure' } })
        return
      }
      if (env.FAKE_MALFORMED !== undefined) {
        respond({})
        return
      }
      if (env.FAKE_ECHO_CWD_IN_INIT !== undefined) {
        respond({ serverInfo: { name: 'deepseek-harness-sdk-runtime', version: process.cwd() } })
        return
      }
      respond({ serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } })
      return
    case 'llm/catalog':
      respond(env.FAKE_MALFORMED_CONTROLS === undefined ? {
        providers: [{ id: 'fake', name: 'Fake Provider', models: [{
          id: 'fake-model',
          name: 'Fake Model',
          inputModalities: ['text'],
          reasoning: process.env.FAKE_MALFORMED_REASONING === '1'
            ? { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'high' }
            : { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
        }] }],
        failures: [{ id: 'offline', name: 'Offline', message: 'offline' }],
      } : { providers: 'invalid', failures: [] })
      return
    case 'provider/authInfo':
      respond(env.FAKE_MALFORMED_AUTH === undefined ? {
        provider: frame.params?.provider,
        methods: [{ type: 'api_key', label: 'API key' }, { type: 'oauth', label: 'Subscription login' }],
        configured: false,
      } : { provider: '', methods: [{ type: 'wat', label: '' }], configured: 'no' })
      return
    case 'provider/authStart': {
      const flowId = 'auth-flow'
      const promptId = 'auth-prompt'
      const provider = String(frame.params?.provider)
      authFlow = { flowId, promptId, provider }
      notify('provider.auth.prompt', {
        flowId, provider, promptId,
        prompt: env.FAKE_MALFORMED_AUTH === undefined
          ? { type: 'secret', message: 'Enter key' }
          : { type: 'secret', message: 7 },
      })
      respond(env.FAKE_MALFORMED_AUTH_RESULTS === undefined ? { flowId } : { flowId, extra: true })
      return
    }
    case 'provider/authRespond':
      if (authFlow) {
        notify('provider.auth.promptResolved', { flowId: authFlow.flowId, promptId: authFlow.promptId })
        notify('provider.auth.finished', { flowId: authFlow.flowId, provider: authFlow.provider, outcome: 'success' })
        authFlow = undefined
      }
      respond(env.FAKE_MALFORMED_AUTH_RESULTS === undefined
        ? { accepted: true }
        : { accepted: true, value: 'must-not-pass-validation' })
      return
    case 'provider/authCancel':
      respond(env.FAKE_MALFORMED_AUTH_RESULTS === undefined ? { requested: true } : { requested: true, extra: true })
      return
    case 'provider/authLogout':
      respond(env.FAKE_MALFORMED_AUTH_RESULTS === undefined ? { disconnected: true } : { disconnected: true, extra: true })
      return
    case 'attachment/imageLimits':
      respond(env.FAKE_MALFORMED_ATTACHMENTS === undefined ? {
        maxImageBytes: 1024,
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 4096,
        maxImagePixels: 1_000_000,
        mediaTypes: ['image/png', 'image/jpeg'],
      } : { maxImageBytes: 'large', mediaTypes: ['image/png'] })
      return
    case 'attachment/saveImage': {
      const data = frame.params?.data
      const decoded = Buffer.from(typeof data === 'string' ? data : '', 'base64')
      respond(env.FAKE_MALFORMED_ATTACHMENTS === undefined ? {
        attachmentId: 'fake:attachment-1',
        mediaType: frame.params?.mediaType,
        bytes: decoded.byteLength + (env.FAKE_MISMATCH_ATTACHMENT === undefined ? 0 : 1),
        width: 1,
        height: 1,
        ...(frame.params?.name === undefined ? {} : { name: frame.params.name }),
      } : {
        attachmentId: '', mediaType: frame.params?.mediaType, bytes: decoded.byteLength + 1, width: 0, height: 1,
      })
      return
    }
    case 'session/list':
      respond({ sessions: [{
        header: { version: 0, id: 'saved', createdAt: 7, cwd: '/tmp' },
        live: false,
        persisted: true,
      }] })
      return
    case 'session/history': {
      const sessionId = sessionIdOf(frame.params)
      respond({
        session: {
          version: 0,
          id: sessionId,
          createdAt: 7,
          cwd: '/tmp',
          ...env.FAKE_OPTIONAL_SESSION_HEADER === undefined ? {} : {
            parentSession: 'parent', seedLength: 0, origin: 'subagent', delegationDepth: 1, agentPreset: 'worker',
          },
        },
        events: env.FAKE_MALFORMED_HISTORY !== undefined || env.FAKE_MALFORMED_HISTORY_TYPE !== undefined
          ? [{
            type: env.FAKE_MALFORMED_HISTORY_TYPE === undefined ? 'turn/start' : 7,
            seq: 0,
            time: 8,
            data: env.FAKE_MALFORMED_HISTORY === undefined ? { turn: 1 } : null,
          }]
          : env.FAKE_GAPPED_HISTORY !== undefined || env.FAKE_DUPLICATE_HISTORY !== undefined
            ? [
              { type: 'turn/start', seq: 0, time: 8, data: { turn: 1 } },
              {
                type: 'turn/end',
                seq: env.FAKE_GAPPED_HISTORY === undefined ? 0 : 2,
                time: 9,
                data: { turn: 1, reason: { kind: 'completed' } },
              },
            ]
            : [{ type: 'turn/start', seq: 0, time: 8, data: { turn: 1 } }],
      })
      return
    }
    case 'session/resume':
      respond({ sessionId: env.FAKE_MISMATCH_RESUME === undefined ? sessionIdOf(frame.params) : 'other' })
      return
    case 'interaction/respond':
      respond({ accepted: true })
      return
    case 'session/selectModel':
      respond(env.FAKE_MALFORMED_CONTROLS === undefined ? {
        provider: frame.params?.provider,
        model: frame.params?.model,
        ...(frame.params?.reasoningEffort === undefined ? {} : { reasoningEffort: frame.params.reasoningEffort }),
      } : { provider: 7, model: null })
      return
    case 'session/cancel':
      respond(env.FAKE_MALFORMED_CONTROLS === undefined ? { requested: true } : { requested: 'yes' })
      return
    case 'session/close':
      respond(env.FAKE_MALFORMED_CONTROLS === undefined ? { closed: true } : {})
      return
    case 'command/list':
      respond(env.FAKE_MALFORMED_CONTROLS === undefined ? {
        available: true,
        commands: [{ name: 'compact', description: 'Compact context', input: { hint: 'instructions' } }],
      } : { available: true, commands: [{ name: 3 }] })
      return
    case 'command/execute':
      respond(env.FAKE_MALFORMED_CONTROLS === undefined ? {
        outcome: 'success', commandId: 'cmd-fake-1', text: 'done',
      } : { outcome: 'success' })
      return
    case 'session/prompt': {
      const sessionId = sessionIdOf(frame.params)
      const messageId = `fake-user-${seq}`
      event(sessionId, 'agent/inbox/spliced', {
        target: 'next-turn',
        start: 0,
        inserted: [{
          id: messageId,
          role: 'user',
          content: [],
          source: { kind: 'user' },
        }],
      })
      notify('session.status', { sessionId, status: 'running' })
      if (env.FAKE_STREAM_THEN_MALFORMED !== undefined) {
        event(sessionId, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'streamed then cut short' } })
        respond({})
        return
      }
      if (env.FAKE_HANG_PROMPT !== undefined) return
      if (env.FAKE_MALFORMED !== undefined || env.FAKE_MALFORMED_PROMPT !== undefined) {
        respond({})
        return
      }
      runTurn(sessionId)
      notify('session.status', { sessionId, status: 'idle' })
      respond({ messageId })
      return
    }
    case 'shutdown':
      respond({})
      // An EOF-ignoring fake also refuses the protocol exit, so the client's
      // dispose ladder (not this cooperative path) must reap it.
      if (env.FAKE_IGNORE_EOF === undefined) setImmediate(() => process.exit(0))
      return
    default:
      write({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: `unknown method: ${frame.method}` } })
  }
})
