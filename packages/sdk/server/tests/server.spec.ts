import { createUserMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type AttachmentStore from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore, { DEFAULT_MAX_IMAGE_BYTES } from '@deepseek-ai/dsh-attachment-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'

import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SubagentRuntime, { type SubagentResult, type SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { HarnessSdkJsonRpcServer } from '../src/index.ts'

class FakeTransport implements JsonRpcTransportPeer {
  notifications: { method: string; params?: Record<string, unknown> }[] = []

  async request(method: string, params: object): Promise<unknown> {
    throw new Error(`the SDK server should not call host JSON-RPC method ${method} with ${JSON.stringify(params)}`)
  }

  notify(method: string, params?: object): void {
    this.notifications.push(params === undefined ? { method } : { method, params: params as Record<string, unknown> })
  }
}

class ThrowingTransport extends FakeTransport {
  constructor(private readonly rejectedMethod: 'interaction.requested' | 'interaction.resolved') {
    super()
  }

  override notify(method: string, params?: object): void {
    if (method === this.rejectedMethod) throw new Error(`${method} write failed`)
    super.notify(method, params)
  }
}

function mockContext(value: { get(name: string): unknown } & Record<string, unknown>): Context {
  const context = value as unknown as Context
  context.effect = ((callback: () => (() => void)) => callback()) as Context['effect']
  context.inject = ((deps: string[], callback: (ctx: Context) => void) => {
    if (deps.every(name => context.get(name) !== undefined)) callback(context)
    return { dispose: () => Promise.resolve() }
  }) as Context['inject']
  return context
}

const servers: Server[] = []
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function settleCordis(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function imageRef(id: string, bytes: number): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(id),
    mediaType: 'image/png',
    bytes,
    width: 1,
    height: 1,
  }
}

function promptTestServer(attachments: AttachmentStore | undefined): {
  server: HarnessSdkJsonRpcServer
  create: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
} {
  const followup = vi.fn<Agent['followup']>()
  const agent = ({ id: SessionId('images'), followup } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
  const create = vi.fn(() => Promise.resolve({ agent, dispose: () => Promise.resolve() }))
  const ctx = mockContext({
    on: vi.fn(() => () => undefined),
    inject: vi.fn(() => ({ dispose: () => Promise.resolve() })),
    agents: { create, get: () => agent },
    get: (name: string) => name === 'attachments' ? attachments : undefined,
  })
  const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
  ;(server as unknown as { initialized: boolean }).initialized = true
  return { server, create, followup }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
})

async function mockCompletionServer(): Promise<{ url: string; requests: unknown[]; headers: IncomingMessage['headers'][] }> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      headers.push(request.headers)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n')
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requests, headers }
}

async function pendingCompletionServer(): Promise<{ url: string; requestReceived: Promise<undefined> }> {
  const requestReceived = Promise.withResolvers<undefined>()
  const server = createServer((request: IncomingMessage) => {
    request.resume()
    request.on('end', () => { requestReceived.resolve(undefined) })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requestReceived: requestReceived.promise }
}

async function makeHarness(storageDir: string) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: storageDir })
  await new Promise(resolve => setTimeout(resolve, 50))
  return ctx
}

/** Drive the owning service so test lifecycle events carry the real parent scope. */
async function settleSubagent(
  ctx: Context,
  parent: Agent,
  info: Omit<SubagentRunEndInfo, 'runId' | 'local'> & { localAgent: Agent | undefined },
  beforeSettle?: () => Promise<void>,
): Promise<void> {
  const result = Promise.withResolvers<SubagentResult>()
  const disposeProvider = ctx.subagents.registerProvider({
    name: info.provider,
    capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    async start() {
      return {
        id: info.id,
        localAgent: info.localAgent,
        result: result.promise,
        dispose: () => Promise.resolve(),
      }
    },
  })
  try {
    const run = await ctx.subagents.start(info.provider, {
      parent,
      prompt: [],
      signal: new AbortController().signal,
    })
    await beforeSettle?.()
    if (info.lastAssistantMessage === undefined) {
      result.reject(new Error('synthetic infrastructure failure'))
    } else {
      result.resolve({ output: info.lastAssistantMessage, stopReason: info.stopReason })
    }
    await run.result.then(() => undefined, () => undefined)
    await run.dispose()
  } finally {
    disposeProvider()
  }
}

describe('HarnessSdkJsonRpcServer', () => {
  it('queries limits and saves canonical base64 with optional display names', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-attachments-'))
    const ctx = new Context()
    await ctx.plugin(LocalAttachmentStore, { dshHome: home })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    try {
      await expect(server.handleRequest('attachment/imageLimits', undefined)).resolves.toMatchObject({
        maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      })
      const named = await server.handleRequest('attachment/saveImage', {
        data: PNG_BASE64,
        mediaType: 'image/png',
        name: '/private/pixel.png',
      })
      expect(named).toMatchObject({ mediaType: 'image/webp', bytes: 44, width: 1, height: 1, name: 'pixel.png' })
      const unnamed = await server.handleRequest('attachment/saveImage', {
        data: PNG_BASE64,
        mediaType: 'image/png',
      })
      expect(unnamed).not.toHaveProperty('name')
      expect((unnamed as { attachmentId: string }).attachmentId)
        .toBe((named as { attachmentId: string }).attachmentId)
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects invalid upload fields, noncanonical base64, and detected media mismatch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-attachments-'))
    const ctx = new Context()
    await ctx.plugin(LocalAttachmentStore, { dshHome: home })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    try {
      await expect(server.handleRequest('attachment/saveImage', {
        data: '!!!!', mediaType: 'image/png',
      })).rejects.toThrow(/canonical padded base64/)
      await expect(server.handleRequest('attachment/saveImage', {
        data: 'YQ', mediaType: 'image/png',
      })).rejects.toThrow(/canonical padded base64/)
      await expect(server.handleRequest('attachment/saveImage', {
        data: PNG_BASE64, mediaType: 'image/jpeg',
      })).rejects.toMatchObject({ code: 'IMAGE_TYPE_MISMATCH' })
      await expect(server.handleRequest('attachment/saveImage', {
        data: PNG_BASE64, mediaType: 'image/bmp',
      })).rejects.toThrow(/mediaType must be accepted/)
      await expect(server.handleRequest('attachment/saveImage', {
        data: PNG_BASE64, mediaType: 'image/png', name: 3,
      })).rejects.toThrow(/name must be a string/)
      await expect(server.handleRequest('attachment/saveImage', {
        data: PNG_BASE64, mediaType: 'image/png', extra: true,
      })).rejects.toThrow(/params fields/)
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects oversized encoded input before base64 decoding or storage', async () => {
    const saveImage = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('attachments', {
      imageLimits: {
        maxImageBytes: 1,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1,
        maxImagePixels: 1,
        mediaTypes: ['image/png'],
      },
      saveImage,
    } as unknown as AttachmentStore)
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    await expect(server.handleRequest('attachment/saveImage', {
      data: '!!!!!', mediaType: 'image/png',
    })).rejects.toThrow(/base64 exceeds the active attachment byte limit/)
    expect(saveImage).not.toHaveBeenCalled()
    await server.shutdown()
    await ctx.fiber.dispose()
  })

  it('fails image operations clearly when no attachment service is composed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    await expect(server.handleRequest('attachment/imageLimits', undefined))
      .rejects.toThrow(/mounts no attachment service/)
    await expect(server.handleRequest('attachment/saveImage', {
      data: PNG_BASE64, mediaType: 'image/png',
    })).rejects.toThrow(/mounts no attachment service/)
    await server.shutdown()
    await ctx.fiber.dispose()
  })

  it('admits recursively nested prompt images at the exact active count and aggregate byte limits', async () => {
    const refs = [imageRef('image-1', 3), imageRef('image-2', 3)]
    const readImage = vi.fn(async (ref: ImageAttachmentRef) => ({ ref, data: Uint8Array.of(1, 2, 3) }))
    const attachments = {
      imageLimits: {
        maxImageBytes: 3,
        maxImagesPerMessage: 2,
        maxMessageImageBytes: 6,
        maxImagePixels: 1,
        mediaTypes: ['image/png'],
      },
      readImage,
    } as unknown as AttachmentStore
    const { server, create, followup } = promptTestServer(attachments)

    await expect(server.handleRequest('session/prompt', {
      sessionId: 'images',
      contentBlocks: [
        { type: 'image', attachment: refs[0] },
        {
          type: 'tool-result', toolCallId: 'call-1',
          content: [{ type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'image', attachment: refs[1] }] }],
        },
      ],
    })).resolves.toHaveProperty('messageId')
    expect(readImage).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledOnce()
    await server.shutdown()
  })

  it.each([
    {
      name: 'over-count',
      limits: { maxImagesPerMessage: 1, maxMessageImageBytes: 6 },
      submitted: [imageRef('image-1', 3), imageRef('image-2', 3)],
      canonical: [imageRef('image-1', 3), imageRef('image-2', 3)],
      message: /image-count limit/,
      expectedReads: 0,
    },
    {
      name: 'aggregate-overflow',
      limits: { maxImagesPerMessage: 2, maxMessageImageBytes: 5 },
      submitted: [imageRef('image-1', 3), imageRef('image-2', 3)],
      canonical: [imageRef('image-1', 3), imageRef('image-2', 3)],
      message: /aggregate image-byte limit/,
      expectedReads: 2,
    },
    {
      name: 'forged-metadata',
      limits: { maxImagesPerMessage: 1, maxMessageImageBytes: 3 },
      submitted: [imageRef('image-1', 2)],
      canonical: [imageRef('image-1', 3)],
      message: /does not match the stored image/,
      expectedReads: 1,
    },
  ])('rejects $name before any durable prompt enqueue', async ({
    limits, submitted, canonical, message, expectedReads,
  }) => {
    const byId = new Map(canonical.map(ref => [ref.attachmentId, ref]))
    const readImage = vi.fn(async (ref: ImageAttachmentRef) => {
      const storedRef = byId.get(ref.attachmentId)
      if (storedRef === undefined) throw new Error('missing test attachment')
      return { ref: storedRef, data: new Uint8Array(storedRef.bytes) }
    })
    const attachments = {
      imageLimits: {
        maxImageBytes: 3,
        ...limits,
        maxImagePixels: 1,
        mediaTypes: ['image/png'],
      },
      readImage,
    } as unknown as AttachmentStore
    const { server, create, followup } = promptTestServer(attachments)

    await expect(server.handleRequest('session/prompt', {
      sessionId: 'images',
      contentBlocks: submitted.map(attachment => ({ type: 'image', attachment })),
    })).rejects.toThrow(message)
    expect(readImage).toHaveBeenCalledTimes(expectedReads)
    expect(create).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
    await server.shutdown()
  })

  it('rejects prompt image references without a service before creating or enqueueing a session', async () => {
    const { server, create, followup } = promptTestServer(undefined)
    await expect(server.handleRequest('session/prompt', {
      sessionId: 'images',
      contentBlocks: [{ type: 'image', attachment: imageRef('image-1', 3) }],
    })).rejects.toThrow(/mounts no attachment service/)
    expect(create).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
    await server.shutdown()
  })

  it('creates a harness agent and calls the configured OpenAI-compatible endpoint', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)

      const init = await server.handleRequest('initialize', {
        cwd: storageDir,
        provider: 'deepseek-official',
        model: 'dsagent-model',
        reasoningEffort: 'max',
        maxTokens: 321,
      }) as { serverInfo: { name: string } }
      expect(init.serverInfo.name).toBe('deepseek-harness-sdk-runtime')

      const receipt = await server.handleRequest('session/prompt', {
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'fix it' }],
      })
      expect((receipt as { messageId?: unknown }).messageId).toBeTypeOf('string')

      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(1) })
      const body = llmServer.requests[0] as {
        model: string
        messages: { role: string }[]
        reasoning_effort?: string
        max_tokens?: number
      }
      expect(body.model).toBe('dsagent-model')
      expect(body.reasoning_effort).toBe('max')
      expect(body.max_tokens).toBe(321)
      expect(body.messages[0]?.role).toBe('system')
      expect(body.messages.at(-1)?.role).toBe('user')
      expect(llmServer.headers[0]?.authorization).toBe('Bearer test-key')
      expect(transport.notifications.some(n => n.method === 'session.event')).toBe(true)
      await vi.waitFor(() => {
        expect(transport.notifications.findLast(n => n.method === 'session.status')).toEqual({
          method: 'session.status',
          params: { sessionId: 'main', status: 'idle' },
        })
      })

      await expect(server.selectModel({
        sessionId: 'main',
        provider: 'deepseek-official',
        model: 'selected-next-model',
      })).resolves.toMatchObject({ provider: 'deepseek-official', model: 'selected-next-model' })
      await server.handleRequest('session/prompt', {
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'again' }],
      })
      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(2) })
      expect((llmServer.requests[1] as { model: string }).model).toBe('selected-next-model')
      const selectedHeader = ctx.sessions.get(SessionId('main'))?.events.findLast(event => event.type === 'request/header')
      expect(selectedHeader?.type === 'request/header' && selectedHeader.data.header.config.model).toBe('selected-next-model')

      const orphanHandle = await ctx.agents.create({
        sessionId: SessionId('orphan-session'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'dsagent-model' },
      })
      orphanHandle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'outside the sdk session map' }], source: { kind: 'user' } }))
      await orphanHandle.agent.whenIdle()
      await orphanHandle.dispose()
      expect(llmServer.requests).toHaveLength(3)

      await server.handleRequest('shutdown', undefined)
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('queues overlapping prompts for one session without blocking other sessions', async () => {
    const mainFollowup = vi.fn<Agent['followup']>()
    const mainAgent = ({
      id: SessionId('main'),
      followup: mainFollowup,
    } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const otherFollowup = vi.fn<Agent['followup']>()
    const otherAgent = ({
      id: SessionId('other'),
      followup: otherFollowup,
    } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const mainHandle = { agent: mainAgent, dispose: vi.fn(() => Promise.resolve()) }
    const otherHandle = { agent: otherAgent, dispose: vi.fn(() => Promise.resolve()) }
    const create = vi.fn(async (options: { sessionId: SessionId }) =>
      String(options.sessionId) === 'main' ? mainHandle : otherHandle)
    const liveAgents = new Map<string, Agent>([['main', mainAgent], ['other', otherAgent]])
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      agents: { create, get: (id: SessionId) => liveAgents.get(String(id)) },
      get: () => undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    ;(server as unknown as { initialized: boolean }).initialized = true
    const prompt = (sessionId: string, text: string) => server.prompt({
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    })

    expect((await prompt('main', 'first')).messageId).toBeTypeOf('string')
    expect((await prompt('main', 'overlap')).messageId).toBeTypeOf('string')
    expect((await prompt('other', 'independent')).messageId).toBeTypeOf('string')

    expect(mainFollowup).toHaveBeenCalledTimes(2)
    expect(otherFollowup).toHaveBeenCalledOnce()
    await server.shutdown()
    expect(mainHandle.dispose).toHaveBeenCalledOnce()
    expect(otherHandle.dispose).toHaveBeenCalledOnce()
  })

  it('acknowledges cancellation before idle convergence and preserves queued work', async () => {
    const cancel = vi.fn<Agent['cancel']>()
    const idle = Promise.withResolvers<undefined>()
    const agent = ({
      status: 'running',
      cancel,
      whenIdle: () => idle.promise,
    } satisfies Pick<Agent, 'status' | 'cancel' | 'whenIdle'>) as unknown as Agent
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      agents: { create: vi.fn(), get: vi.fn() },
      get: () => undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
      sessions: Map<string, { handle: AgentHandle; selection: object; commands: Set<never>; closing: boolean }>
      cancel(sessionId: string): { requested: boolean }
      shutdown(): Promise<Record<string, never>>
    }
    server.sessions.set('main', {
      handle: { agent, dispose: () => Promise.resolve() },
      selection: {},
      commands: new Set(),
      closing: false,
    })

    let converged = false
    void agent.whenIdle().then(() => { converged = true })
    expect(server.cancel('main')).toEqual({ requested: true })
    expect(converged).toBe(false)
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    idle.resolve(undefined)
    await agent.whenIdle()
    expect(converged).toBe(true)
    expect(server.cancel('missing')).toEqual({ requested: false })
    await server.shutdown()
  })

  it('cancels a real active model request and converges the agent to idle', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-active-cancel-'))
    const llmServer = await pendingCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    try {
      await server.initialize({
        cwd: storageDir,
        provider: 'deepseek-official',
        model: 'cancel-model',
      })
      await server.prompt({
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'wait' }],
      })
      await llmServer.requestReceived

      expect(server.cancel('main')).toEqual({ requested: true })
      const agent = ctx.agents.get(SessionId('main'))
      expect(agent).toBeDefined()
      await agent?.whenIdle()
      expect(agent?.status).toBe('idle')
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('coalesces close ownership, awaits disposal, and permits later clean creation', async () => {
    const disposed = Promise.withResolvers<undefined>()
    const first = { agent: {} as Agent, dispose: vi.fn(() => disposed.promise) }
    const second = { agent: {} as Agent, dispose: vi.fn(() => Promise.resolve()) }
    const create = vi.fn<(options: unknown) => Promise<AgentHandle>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      agents: { create, get: vi.fn() },
      get: () => undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
      getOrCreateSession(sessionId: string): Promise<unknown>
      closeSession(sessionId: string): Promise<{ closed: boolean }>
      shutdown(): Promise<Record<string, never>>
    }
    await server.getOrCreateSession('main')
    const close = server.closeSession('main')
    const concurrentClose = server.closeSession('main')
    await expect(server.getOrCreateSession('main')).rejects.toThrow('SDK session is closing: main')
    disposed.resolve(undefined)
    await expect(Promise.all([close, concurrentClose])).resolves.toEqual([{ closed: true }, { closed: true }])
    expect(first.dispose).toHaveBeenCalledOnce()
    await expect(server.getOrCreateSession('main')).resolves.toBeDefined()
    expect(create).toHaveBeenCalledTimes(2)
    await server.shutdown()
  })

  it('keeps healthy catalog providers when another provider model lookup fails', async () => {
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      agents: { create: vi.fn(), get: vi.fn() },
      get: (name: string) => name === 'llm' ? {
        listProviders: () => [{ id: 'healthy', name: 'Healthy' }, { id: 'broken', name: 'Broken' }],
        listModels: (provider: string) => provider === 'healthy'
          ? Promise.resolve([{ provider, id: 'm1', name: 'Model One', inputModalities: ['text'] }])
          : Promise.reject(new Error('catalog offline')),
        resolveModelInfo: (provider: string, model: string) => Promise.resolve({
          provider,
          id: model,
          name: 'Model One',
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
        }),
      } : undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

    await expect(server.catalog()).resolves.toEqual({
      providers: [{
        id: 'healthy',
        name: 'Healthy',
        models: [{
          id: 'm1',
          name: 'Model One',
          inputModalities: ['text'],
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
        }],
      }],
      failures: [{ id: 'broken', name: 'Broken', message: 'catalog offline' }],
    })
    await server.shutdown()
  })

  it('lets concurrent close win over model selection without resurrecting the session', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-selection-close-'))
    const ctx = await makeHarness(storageDir)
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    try {
      await server.initialize({
        cwd: storageDir,
        provider: 'deepseek-official',
        model: 'initial-model',
      })
      const resolutionEntered = Promise.withResolvers<undefined>()
      const allowResolution = Promise.withResolvers<undefined>()
      const resolveCallConfig = ctx.llm.resolveCallConfig.bind(ctx.llm)
      vi.spyOn(ctx.llm, 'resolveCallConfig').mockImplementation(async (request) => {
        resolutionEntered.resolve(undefined)
        await allowResolution.promise
        return resolveCallConfig(request)
      })

      const selection = server.selectModel({
        sessionId: 'main', provider: 'deepseek-official', model: 'selected-model',
      })
      await resolutionEntered.promise
      await expect(server.closeSession('main')).resolves.toEqual({ closed: true })
      allowResolution.resolve(undefined)

      await expect(selection).rejects.toThrow('SDK session is closing: main')
      expect(ctx.agents.get(SessionId('main'))).toBeUndefined()
      await expect(server.closeSession('main')).resolves.toEqual({ closed: false })
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('lists and executes registered commands without creating a user message', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-commands-'))
    const ctx = await makeHarness(storageDir)
    await ctx.plugin(CommandRuntime)
    ctx.commands.register({
      name: 'probe',
      description: 'Run command probe',
      input: { hint: 'value' },
      handler: ({ rawInput }) => ({ kind: 'success', text: rawInput.trim() }),
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    try {
      const listed = await server.listCommands('main')
      expect(listed).toEqual({
        available: true,
        commands: [{ name: 'probe', description: 'Run command probe', input: { hint: 'value' } }],
      })
      await expect(server.executeCommand({ sessionId: 'main', line: '/probe value' }))
        .resolves.toMatchObject({ outcome: 'success', text: 'value' })
      expect(ctx.sessions.get(SessionId('main'))?.events.map(event => event.type)).toEqual([
        'command/run', 'command/done',
      ])
      await expect(server.executeCommand({ sessionId: 'main', line: '/missing' }))
        .resolves.toMatchObject({ outcome: 'unknown-command' })
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('aborts and settles an active command before session close returns', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-command-close-'))
    const ctx = await makeHarness(storageDir)
    await ctx.plugin(CommandRuntime)
    ctx.commands.register({
      name: 'wait',
      description: 'Wait for cancellation',
      handler: () => new Promise(() => {}),
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    try {
      const execution = server.executeCommand({ sessionId: 'main', line: '/wait' })
      await vi.waitFor(() => {
        expect(ctx.sessions.get(SessionId('main'))?.events.some(event => event.type === 'command/run')).toBe(true)
      })
      await expect(Promise.all([execution, server.closeSession('main')])).resolves.toEqual([
        { outcome: 'error', message: 'SDK session closed' },
        { closed: true },
      ])
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('returns structured command capability absence', async () => {
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      agents: { create: vi.fn(), get: vi.fn() },
      get: () => undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    await expect(server.listCommands('main')).resolves.toEqual({ available: false, commands: [] })
    await expect(server.executeCommand({ sessionId: 'main', line: '/compact' }))
      .resolves.toMatchObject({ outcome: 'unavailable' })
  })

  it('admits inline SDK images before the user message enters the session', async () => {
    const followup = vi.fn<Agent['followup']>()
    const agent = ({ id: SessionId('image'), followup } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    const ref = {
      attachmentId: 'sha256:image',
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const saveImages = vi.fn(async () => [ref])
    const ctx = {
      on: vi.fn(() => () => undefined),
      inject: vi.fn(() => ({ dispose: () => Promise.resolve() })),
      agents: { create: vi.fn(async () => handle), get: () => agent },
      get: (name: string) => name === 'attachments' ? { saveImages } : undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    ;(server as unknown as { initialized: boolean }).initialized = true

    await server.prompt({
      sessionId: 'image',
      contentBlocks: [
        { type: 'text', text: 'inspect' },
        { type: 'image', data: 'AQ==', mimeType: 'image/png' },
      ],
    })

    expect(saveImages).toHaveBeenCalledWith([{ data: Uint8Array.of(1), mediaType: 'image/png' }])
    expect(followup.mock.calls[0]?.[0].content).toEqual([
      { type: 'text', text: 'inspect' },
      { type: 'image', attachment: ref },
    ])
    await server.shutdown()
  })

  it('rejects inline SDK images when the composition has no attachment store', async () => {
    const followup = vi.fn<Agent['followup']>()
    const agent = ({ id: SessionId('image'), followup } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    const ctx = {
      on: vi.fn(() => () => undefined),
      inject: vi.fn(() => ({ dispose: () => Promise.resolve() })),
      agents: { create: vi.fn(async () => handle), get: () => agent },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    ;(server as unknown as { initialized: boolean }).initialized = true

    await expect(server.prompt({
      sessionId: 'image',
      contentBlocks: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })).rejects.toThrow('SDK image prompt requires an attachment store')
    expect(followup).not.toHaveBeenCalled()
    await server.shutdown()
  })

  it('rechecks agent liveness after asynchronous image admission', async () => {
    const followup = vi.fn<Agent['followup']>()
    const agent = ({ id: SessionId('image-race'), followup } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    const admitted = Promise.withResolvers<Array<{
      attachmentId: string
      mediaType: string
      bytes: number
    }>>()
    const saveImages = vi.fn(() => admitted.promise)
    let live = true
    const ctx = {
      on: vi.fn(() => () => undefined),
      inject: vi.fn(() => ({ dispose: () => Promise.resolve() })),
      agents: {
        create: vi.fn(async () => handle),
        get: () => live ? agent : undefined,
      },
      get: (name: string) => name === 'attachments' ? { saveImages } : undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    ;(server as unknown as { initialized: boolean }).initialized = true

    const prompting = server.prompt({
      sessionId: 'image-race',
      contentBlocks: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    live = false
    admitted.resolve([{ attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 1 }])

    await expect(prompting).rejects.toThrow('session agent was disposed outside the server: image-race')
    expect(followup).not.toHaveBeenCalled()
    await server.shutdown()
  })

  it('rejects a prompt for a session whose agent was disposed outside the server', async () => {
    const followup = vi.fn<Agent['followup']>()
    const agent = ({
      id: SessionId('zombie'),
      followup,
      whenIdle: vi.fn(() => Promise.resolve()),
    } satisfies Pick<Agent, 'id' | 'followup' | 'whenIdle'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    // The registry drops the agent after creation, modelling an agent-loop-only
    // reload that leaves the server's SessionRecord pointing at a detached agent.
    let live = true
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      agents: {
        create: vi.fn(async () => handle),
        get: (id: SessionId) => (live && String(id) === 'zombie' ? agent : undefined),
      },
      get: () => undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    ;(server as unknown as { initialized: boolean }).initialized = true
    const prompt = (text: string) => server.prompt({
      sessionId: 'zombie',
      contentBlocks: [{ type: 'text', text }],
    })

    expect((await prompt('while live')).messageId).toBeTypeOf('string')
    live = false
    await expect(prompt('after detach')).rejects.toThrow('session agent was disposed outside the server: zombie')
    // The detached agent was never driven by the rejected prompt.
    expect(followup).toHaveBeenCalledOnce()
    await server.shutdown()
  })

  it('forwards whole-agent status without attributing a turn outcome', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    const session = ctx.sessions.create(SessionId('message-outcome'))
    const agent = ({
      id: SessionId('message-outcome'),
      session,
    } satisfies Pick<Agent, 'id' | 'session'>) as Agent

    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('agent/status', { agent, status: 'idle' })

    expect(transport.notifications.filter(notification => notification.method === 'session.status'))
      .toEqual([
        { method: 'session.status', params: { sessionId: 'message-outcome', status: 'running' } },
        { method: 'session.status', params: { sessionId: 'message-outcome', status: 'idle' } },
      ])
    await server.shutdown()
    await ctx.fiber.dispose()
  })

  it('notifies the host when a child session is created with parent lineage', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)

      ctx.sessions.create(SessionId('root-session'), {
        meta: { cwd: storageDir },
      })
      ctx.sessions.create(SessionId('child-session'), {
        meta: { cwd: storageDir, parentSession: SessionId('main') },
      })

      expect(transport.notifications).toContainEqual({
        method: 'subagent.started',
        params: {
          parentSessionId: 'main',
          childSessionId: 'child-session',
        },
      })

      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('creates an SDK session without an optional system prompt', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-no-system-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'plain-model' })
      await server.prompt({
        sessionId: 'plain',
        contentBlocks: [{ type: 'text', text: 'hello' }],
      })

      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(1) })
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('notifies the host when a subagent run settles', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-end-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)

      const parentHandle = await ctx.agents.create({
        sessionId: SessionId('main'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      // A custom in-process provider may own its child at the provider/root
      // scope while preserving durable parent lineage.
      const handle = await ctx.agents.create({
        sessionId: SessionId('child-session'),
        meta: { cwd: storageDir, parentSession: SessionId('main') },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      expect(ctx.agents.roots()).toContain(handle.agent)
      const parentlessHandle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('parentless-child-session'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'spawn',
        id: SessionId('child-session'),
        localAgent: handle.agent,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'child done' }],
      }, () => handle.dispose())
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'spawn',
        id: SessionId('parentless-child-session'),
        localAgent: parentlessHandle.agent,
        stopReason: 'error',
      }, () => parentlessHandle.dispose())

      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'spawn',
          agentId: 'child-session',
          parentSessionId: 'main',
          childSessionId: 'child-session',
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: 'child done' }],
        },
      })
      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'spawn',
          agentId: 'parentless-child-session',
          parentSessionId: 'main',
          childSessionId: 'parentless-child-session',
          status: 'error',
          stopReason: 'error',
        },
      })

      await parentHandle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('ignores a remote run id that collides with a local child of the same parent', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-remote-collision-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const parentHandle = await ctx.agents.create({
        sessionId: SessionId('collision-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const collidingChild = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('remote-run-id'),
        meta: { cwd: storageDir, parentSession: SessionId('collision-parent') },
        agentOptions: { model: 'deepseek-official' },
      })

      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'remote',
        id: SessionId('remote-run-id'),
        localAgent: undefined,
        stopReason: 'completed',
        lastAssistantMessage: [],
      })

      expect(transport.notifications.some(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.agentId === 'remote-run-id',
      )).toBe(false)

      await collidingChild.dispose()
      await parentHandle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('retains locality across continuation runs on one live child', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-continuation-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const parentHandle = await ctx.agents.create({
        sessionId: SessionId('continuation-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const childHandle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('continuation-child'),
        meta: { cwd: storageDir, parentSession: SessionId('continuation-parent') },
        agentOptions: { model: 'deepseek-official' },
      })

      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'continuation',
        id: SessionId('continuation-child'),
        localAgent: childHandle.agent,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'first' }],
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'continuation',
        id: SessionId('continuation-child'),
        localAgent: childHandle.agent,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'second' }],
      }, () => childHandle.dispose())

      expect(transport.notifications.filter(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.childSessionId === 'continuation-child',
      )).toHaveLength(2)

      await parentHandle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('correlates reused local ids by parent scope when runs settle out of order', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-reuse-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const oldParent = await ctx.agents.create({
        sessionId: SessionId('old-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const oldChild = await oldParent.agent.ctx.agents.create({
        sessionId: SessionId('reused-child'),
        meta: { cwd: storageDir, parentSession: SessionId('old-parent') },
        agentOptions: { model: 'deepseek-official' },
      })
      const first = Promise.withResolvers<SubagentResult>()
      const sameLifetime = Promise.withResolvers<SubagentResult>()
      const replacement = Promise.withResolvers<SubagentResult>()
      const results = [first.promise, sameLifetime.promise, replacement.promise]
      let starts = 0
      let currentLocalAgent = oldChild.agent
      const disposeProvider = ctx.subagents.registerProvider({
        name: 'reused',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start() {
          const result = results[starts]
          starts += 1
          if (result === undefined) throw new Error('unexpected fourth reused-id run')
          return Promise.resolve({ id: SessionId('reused-child'), localAgent: currentLocalAgent, result, dispose: () => Promise.resolve() })
        },
      })

      const firstRun = await ctx.subagents.start('reused', {
        parent: oldParent.agent,
        prompt: [],
        signal: new AbortController().signal,
      })
      const sameLifetimeRun = await ctx.subagents.start('reused', {
        parent: oldParent.agent,
        prompt: [],
        signal: new AbortController().signal,
      })
      sameLifetime.resolve({ output: [{ type: 'text', text: 'same lifetime' }], stopReason: 'completed' })
      await sameLifetimeRun.result
      await oldChild.dispose()
      const newParent = await ctx.agents.create({
        sessionId: SessionId('new-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const newChild = await newParent.agent.ctx.agents.create({
        sessionId: SessionId('reused-child'),
        meta: { cwd: storageDir, parentSession: SessionId('new-parent') },
        agentOptions: { model: 'deepseek-official' },
      })
      currentLocalAgent = newChild.agent
      const secondRun = await ctx.subagents.start('reused', {
        parent: newParent.agent,
        prompt: [],
        signal: new AbortController().signal,
      })

      replacement.resolve({ output: [{ type: 'text', text: 'new lifetime' }], stopReason: 'completed' })
      await secondRun.result
      first.resolve({ output: [{ type: 'text', text: 'old lifetime' }], stopReason: 'completed' })
      await firstRun.result
      await Promise.resolve()

      const finished = transport.notifications.filter(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.childSessionId === 'reused-child',
      )
      expect(finished.map(notification => notification.params?.lastAssistantMessage)).toEqual([
        [{ type: 'text', text: 'same lifetime' }],
        [{ type: 'text', text: 'new lifetime' }],
        [{ type: 'text', text: 'old lifetime' }],
      ])
      expect(finished.map(notification => notification.params?.parentSessionId)).toEqual([
        'old-parent',
        'new-parent',
        'old-parent',
      ])

      await firstRun.dispose()
      await sameLifetimeRun.dispose()
      await secondRun.dispose()
      disposeProvider()
      await newChild.dispose()
      await oldParent.dispose()
      await newParent.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('keeps locality bound to the accepted run across provider re-registration', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-provider-reuse-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const parent = await ctx.agents.create({
        sessionId: SessionId('provider-reuse-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const child = await parent.agent.ctx.agents.create({
        sessionId: SessionId('provider-reuse-child'),
        meta: { cwd: storageDir, parentSession: SessionId('provider-reuse-parent') },
        agentOptions: { model: 'deepseek-official' },
      })
      const localResult = Promise.withResolvers<SubagentResult>()
      const remoteResult = Promise.withResolvers<SubagentResult>()
      const unregisterLocal = ctx.subagents.registerProvider({
        name: 'reused-provider',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start: () => Promise.resolve({
          id: SessionId('provider-reuse-child'),
          localAgent: child.agent,
          result: localResult.promise,
          dispose: () => Promise.resolve(),
        }),
      })
      const localRun = await ctx.subagents.start('reused-provider', {
        parent: parent.agent,
        prompt: [],
        signal: new AbortController().signal,
      })
      unregisterLocal()

      const unregisterRemote = ctx.subagents.registerProvider({
        name: 'reused-provider',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start: () => Promise.resolve({
          id: SessionId('provider-reuse-child'),
          localAgent: undefined,
          result: remoteResult.promise,
          dispose: () => Promise.resolve(),
        }),
      })
      const remoteRun = await ctx.subagents.start('reused-provider', {
        parent: parent.agent,
        prompt: [],
        signal: new AbortController().signal,
      })

      remoteResult.resolve({ output: [{ type: 'text', text: 'remote' }], stopReason: 'completed' })
      await remoteRun.result
      await Promise.resolve()
      expect(transport.notifications.some(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.lastAssistantMessage !== undefined,
      )).toBe(false)

      await child.dispose()
      localResult.resolve({ output: [{ type: 'text', text: 'local' }], stopReason: 'completed' })
      await localRun.result
      await Promise.resolve()
      expect(transport.notifications.filter(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.childSessionId === 'provider-reuse-child',
      )).toEqual([{
        method: 'subagent.finished',
        params: {
          provider: 'reused-provider',
          agentId: 'provider-reuse-child',
          parentSessionId: 'provider-reuse-parent',
          childSessionId: 'provider-reuse-child',
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: 'local' }],
        },
      }])

      await localRun.dispose()
      await remoteRun.dispose()
      unregisterRemote()
      await parent.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('uses the recorded local flag when start was missed and ignores remote runs', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-fallback-'))
    const ctx = await makeHarness(storageDir)
    let parentHandle: AgentHandle | undefined
    let handle: AgentHandle | undefined
    let failedHandle: AgentHandle | undefined
    try {
      parentHandle = await ctx.agents.create({
        sessionId: SessionId('fallback-parent'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      handle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('fallback-child-session'),
        meta: { cwd: storageDir, parentSession: SessionId('fallback-parent') },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      const fallbackChild = handle.agent
      failedHandle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('failed-child-session'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      const missedStartResult = Promise.withResolvers<SubagentResult>()
      const disposeMissedStartProvider = ctx.subagents.registerProvider({
        name: 'fork',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: true,
        start: () => Promise.resolve({
          id: SessionId('fallback-child-session'),
          localAgent: fallbackChild,
          result: missedStartResult.promise,
          dispose: () => Promise.resolve(),
        }),
      })
      // Start before the server subscribes. The terminal payload still carries
      // this run's exact local child without reconstructing it from ids.
      const missedStartRun = await ctx.subagents.start('fork', {
        parent: parentHandle.agent,
        prompt: [],
        signal: new AbortController().signal,
      })
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport, { maxTokensAsSuccess: true })

      missedStartResult.resolve({ output: [], stopReason: 'max-tokens' })
      await missedStartRun.result
      await Promise.resolve()
      await missedStartRun.dispose()
      disposeMissedStartProvider()
      // The server also missed this agent's creation but sees the exact child
      // on the run lifecycle payload.
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork-live-fallback',
        id: SessionId('fallback-child-session'),
        localAgent: fallbackChild,
        stopReason: 'completed',
        lastAssistantMessage: [],
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork',
        id: SessionId('failed-child-session'),
        localAgent: failedHandle.agent,
        stopReason: 'error',
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork',
        id: SessionId('missing-child-agent'),
        localAgent: undefined,
        stopReason: 'error',
      })

      // A result without output omits lastAssistantMessage from the wire; it
      // never sends `[]`.
      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'fork',
          agentId: 'fallback-child-session',
          parentSessionId: 'fallback-parent',
          childSessionId: 'fallback-child-session',
          status: 'ok',
          stopReason: 'max-tokens',
        },
      })
      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'fork',
          agentId: 'failed-child-session',
          parentSessionId: 'fallback-parent',
          childSessionId: 'failed-child-session',
          status: 'error',
          stopReason: 'error',
        },
      })
      expect(transport.notifications.some(n =>
        n.method === 'subagent.finished'
        && n.params?.agentId === 'missing-child-agent',
      )).toBe(false)

      await server.shutdown()
    } finally {
      await handle?.dispose()
      await failedHandle?.dispose()
      await parentHandle?.dispose()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('does not re-register an LLM adapter whose provider already has an owner', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-existing-llm-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmDeepSeek)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      const inspect = server as unknown as { hasAdapterFor(provider: string): boolean }

      expect(inspect.hasAdapterFor('deepseek-official')).toBe(true)
      expect(inspect.hasAdapterFor('missing-provider')).toBe(false)
      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'preinstalled-model' })

      expect(ctx.get('llm')?.listProviders().filter(provider => provider.id === 'deepseek-official')).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('rejects a missing non-DeepSeek provider when an LLM service already exists', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-new-llm-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmDeepSeek)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

      await expect(server.initialize({ cwd: storageDir, provider: 'private', model: 'new-model' }))
        .rejects.toThrow('no adapter registered for provider "private"')

      expect(ctx.get('llm')?.listProviders()).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it.each([
    ['session/selectModel', undefined, 'sessionId must be a non-empty string'],
    ['session/selectModel', { sessionId: '', provider: 'p', model: 'm' }, 'sessionId must be a non-empty string'],
    ['session/selectModel', { sessionId: 's', provider: 1, model: 'm' }, 'provider must be a non-empty string'],
    ['session/selectModel', { sessionId: 's', provider: 'p', model: '' }, 'model must be a non-empty string'],
    ['session/selectModel', { sessionId: 's', provider: 'p', model: 'm', reasoningEffort: null }, 'reasoningEffort must be a non-empty string when provided'],
    ['session/selectModel', { sessionId: 's', provider: 'p', model: 'm', reasoningEffort: '' }, 'reasoningEffort must be a non-empty string when provided'],
    ['command/execute', { sessionId: [], line: '/probe' }, 'sessionId must be a non-empty string'],
    ['command/execute', { sessionId: 's', line: '' }, 'line must be a non-empty string'],
    ['command/execute', { sessionId: 's', line: false }, 'line must be a non-empty string'],
  ] as const)('rejects invalid %s wire params %#', async (method, params, message) => {
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      agents: { create: vi.fn(), get: vi.fn() },
      get: () => undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    await expect(server.handleRequest(method, params)).rejects.toThrow(message)
    await server.shutdown()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid initialize maxTokens %s at the wire boundary',
    async (maxTokens) => {
      const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-invalid-max-tokens-'))
      const ctx = await makeHarness(storageDir)
      try {
        const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
        await expect(server.initialize({
          cwd: storageDir,
          provider: 'deepseek-official',
          model: 'model',
          maxTokens,
        })).rejects.toThrow('initialize maxTokens must be a positive safe integer')
        await server.shutdown()
      } finally {
        await ctx.fiber.dispose()
        await rm(storageDir, { recursive: true, force: true })
      }
    },
  )

  it('rejects malformed initialize reasoningEffort values at the wire boundary', async () => {
    const ctx = new Context()
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    try {
      for (const reasoningEffort of ['', 42]) {
        await expect(server.handleRequest('initialize', {
          cwd: '.',
          provider: 'deepseek-official',
          model: 'model',
          reasoningEffort,
        })).rejects.toThrow('initialize reasoningEffort must be a non-empty string')
      }
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an unavailable exact model during initialize', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-invalid-route-'))
    const ctx = await makeHarness(storageDir)
    class RejectingAdapter extends LlmAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.reject(new Error(`model unavailable: ${provider}/${model}`))
      }

      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        throw new Error('unreachable')
      }
    }
    const disposeAdapter = ctx.llm.registerAdapter(['private'], new RejectingAdapter())
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      await expect(server.initialize({ cwd: storageDir, provider: 'private', model: 'missing' }))
        .rejects.toThrow('model unavailable: private/missing')
      await expect(server.prompt({
        sessionId: 'invalid-route',
        contentBlocks: [{ type: 'text', text: 'must not run' }],
      })).rejects.toThrow('SDK server is not initialized')
      expect((server as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
      await server.shutdown()
    } finally {
      disposeAdapter()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('rejects prompts while exact-route initialization is pending', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-pending-route-'))
    const ctx = await makeHarness(storageDir)
    const resolution = Promise.withResolvers<LlmResolvedModelInfo>()
    const resolvedModel = { provider: 'private', id: 'selected', name: 'Selected' }
    let resolveModelCalled = false
    class PendingAdapter extends LlmAdapter {
      override resolveModel(): Promise<LlmResolvedModelInfo> {
        resolveModelCalled = true
        return resolution.promise
      }

      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        throw new Error('unreachable')
      }
    }
    const disposeAdapter = ctx.llm.registerAdapter(['private'], new PendingAdapter())
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      const initialization = server.initialize({ cwd: storageDir, provider: 'private', model: 'selected' })
      await vi.waitFor(() => { expect(resolveModelCalled).toBe(true) })

      await expect(server.prompt({
        sessionId: 'too-early',
        contentBlocks: [{ type: 'text', text: 'must not run' }],
      })).rejects.toThrow('SDK server is not initialized')
      expect((server as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)

      resolution.resolve(resolvedModel)
      await initialization
      await server.shutdown()
    } finally {
      resolution.resolve(resolvedModel)
      disposeAdapter()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('rejects an unsupported reasoning effort during initialize', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-unsupported-reasoning-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      await expect(server.handleRequest('initialize', {
        cwd: storageDir,
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'impossible',
      })).rejects.toThrow('does not support reasoning effort "impossible"')
      expect((server as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('reports no adapter when the LLM service is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
        hasAdapterFor(model: string): boolean
        shutdown(): Promise<Record<string, never>>
      }

      expect(server.hasAdapterFor('missing-model')).toBe(false)
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects unknown JSON-RPC runtime methods', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-unknown-'))
    const ctx = await makeHarness(storageDir)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

      await expect(server.handleRequest('does/not/exist', {}))
        .rejects
        .toThrow('unknown DeepSeek Harness SDK runtime method: does/not/exist')

      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('coalesces concurrent session creation and retries a failed creation', async () => {
    let resolveShared: ((handle: AgentHandle) => void) | undefined
    const sharedCreation = new Promise<AgentHandle>((resolve) => { resolveShared = resolve })
    const sharedHandle = { agent: {} as Agent, dispose: vi.fn(() => Promise.resolve()) }
    const retryHandle = { agent: {} as Agent, dispose: vi.fn(() => Promise.resolve()) }
    const create = vi.fn<(options: unknown) => Promise<AgentHandle>>()
      .mockReturnValueOnce(sharedCreation)
      .mockRejectedValueOnce(new Error('creation failed'))
      .mockResolvedValueOnce(retryHandle)
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      agents: { create, get: () => undefined },
      get: () => undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
      getOrCreateSession(sessionId: string): Promise<{ handle: AgentHandle }>
      shutdown(): Promise<Record<string, never>>
    }

    const first = server.getOrCreateSession('shared')
    const second = server.getOrCreateSession('shared')
    expect(create).toHaveBeenCalledTimes(1)
    resolveShared?.(sharedHandle)
    const [firstRecord, secondRecord] = await Promise.all([first, second])
    expect(firstRecord).toBe(secondRecord)

    await expect(server.getOrCreateSession('retry')).rejects.toThrow('creation failed')
    await expect(server.getOrCreateSession('retry')).resolves.toMatchObject({ handle: retryHandle })
    expect(create).toHaveBeenCalledTimes(3)

    await server.shutdown()
    expect(sharedHandle.dispose).toHaveBeenCalledOnce()
    expect(retryHandle.dispose).toHaveBeenCalledOnce()
    await expect(server.getOrCreateSession('after-shutdown')).rejects.toThrow('SDK server is shutting down')
  })

  it('resolves a relative cwd before creating the session', async () => {
    const create = vi.fn<(options: unknown) => Promise<AgentHandle>>()
      .mockResolvedValue({ agent: {} as Agent, dispose: () => Promise.resolve() })
    const resolveCallConfig = vi.fn(async (config: unknown) => config)
    const ctx = {
      on: vi.fn(() => () => undefined),
      inject: vi.fn(() => ({ dispose: () => Promise.resolve() })),
      agents: { create, get: () => undefined },
      get: () => ({ listProviders: () => [{ id: 'mock', name: 'Mock' }], resolveCallConfig }),
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
      initialize(params: { cwd: string; provider: string; model: string; reasoningEffort?: string; maxTokens?: number }): Promise<unknown>
      getOrCreateSession(sessionId: string): Promise<unknown>
      shutdown(): Promise<Record<string, never>>
    }

    await server.initialize({ cwd: '.', provider: 'mock', model: 'model', reasoningEffort: 'high', maxTokens: 123 })
    await server.getOrCreateSession('relative')

    expect(resolveCallConfig).toHaveBeenCalledWith({
      provider: 'mock',
      model: 'model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 123,
    })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      meta: { cwd: process.cwd() },
      agentOptions: {
        provider: 'mock',
        model: 'model',
        reasoningEffort: ReasoningEffortId('high'),
        maxTokens: 123,
      },
    }))
    await server.shutdown()
  })

  it('lists, reads, and explicitly resumes durable sessions with their stored route', async () => {
    const header = { version: 0 as const, id: SessionId('saved'), createdAt: 7, cwd: '/tmp' }
    const events = [{
      type: 'request/header' as const, seq: 0, time: 8,
      data: { header: { config: { provider: 'stored-provider', model: 'stored-model' } } },
    }]
    const handle = { agent: { session: { id: SessionId('saved') } } as Agent, dispose: vi.fn(() => Promise.resolve()) }
    const resume = vi.fn(() => Promise.resolve(handle))
    const query = {
      listSessions: vi.fn(() => Promise.resolve([{ header, live: false, persisted: true }])),
      readSession: vi.fn(() => Promise.resolve({ session: header, events })),
    }
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      agents: { resume, create: vi.fn(), get: () => undefined },
      get: (key: string) => key === 'sessionQuery' ? query : undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

    await expect(server.listSessions()).resolves.toEqual({ sessions: [{ header, live: false, persisted: true }] })
    await expect(server.sessionHistory('saved')).resolves.toEqual({ session: header, events })
    await expect(server.resumeSession('saved')).resolves.toEqual({ sessionId: 'saved' })
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      resumeSessionId: SessionId('saved'),
      agentOptions: { provider: 'stored-provider', model: 'stored-model' },
    }))
    await expect(server.resumeSession('saved')).rejects.toThrow('already live')
    await server.shutdown()
  })

  it('rejects preset-backed durable sessions before publishing a live agent', async () => {
    const header = {
      version: 0 as const,
      id: SessionId('preset-saved'),
      createdAt: 7,
      agentPreset: 'researcher',
    }
    const resume = vi.fn()
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      agents: { resume, create: vi.fn(), get: () => undefined },
      get: (key: string) => key === 'sessionQuery' ? {
        readSession: vi.fn(() => Promise.resolve({ session: header, events: [] })),
      } : undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
      sessions: Map<string, unknown>
      resumeSession(sessionId: string): Promise<{ sessionId: string }>
      shutdown(): Promise<Record<string, never>>
    }

    await expect(server.resumeSession('preset-saved')).rejects.toThrow(
      'session resume does not support preset-backed session: preset-saved',
    )
    expect(resume).not.toHaveBeenCalled()
    expect(server.sessions).toHaveLength(0)
    await server.shutdown()
  })

  it('bridges approval and question requests with validation and first-response-wins receipts', async () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const transport = new FakeTransport()
    const ctx = mockContext({
      on: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      }),
      agents: { create: vi.fn(), get: () => undefined },
      get: (key: string) => key === 'userQuestions' ? {} : key === 'approval' ? {} : undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, transport)

    const approvalId = 'approval-1'
    const approval = listeners.get('approval/request')?.({
      agent: { session: { id: SessionId('s'), events: [{
        type: 'approval/asked', seq: 0, time: 1,
        data: { id: approvalId, toolName: 'bash', callId: 'call-1' },
      }] } },
      toolName: 'bash', callId: 'call-1',
    }, () => Promise.resolve('unavailable')) as Promise<string>
    const approvalRequest = transport.notifications.findLast(item => item.method === 'interaction.requested')?.params
    expect(approvalRequest).toMatchObject({ kind: 'approval', sessionId: 's', approvalId })
    const approvalRequestId = String(approvalRequest?.requestId)
    expect(server.respondInteraction({ requestId: approvalRequestId, kind: 'approval', outcome: 'allowed-once' })).toEqual({ accepted: true })
    expect(server.respondInteraction({ requestId: approvalRequestId, kind: 'approval', outcome: 'rejected' })).toEqual({ accepted: false, reason: 'not-pending' })
    await expect(approval).resolves.toBe('allowed-once')

    const questions = [{ id: 'q', question: 'Choose', options: [{ label: 'yes' }] }]
    const question = listeners.get('user-questions/request')?.({
      questions, agent: { session: { id: SessionId('s') } },
    }, () => Promise.reject(new Error('no answerer')))
    const questionRequest = transport.notifications.findLast(item => item.method === 'interaction.requested')?.params
    questions[0]?.options.splice(0, 1, { label: 'mutated' })
    expect(questionRequest?.questions).toEqual([{ id: 'q', question: 'Choose', options: [{ label: 'yes' }] }])
    const questionRequestId = String(questionRequest?.requestId)
    expect(server.respondInteraction({
      requestId: questionRequestId, kind: 'question', answer: { answers: [{ id: 'q', selected: ['no'] }] },
    })).toEqual({ accepted: false, reason: 'bad-response' })
    expect(server.respondInteraction({
      requestId: questionRequestId, kind: 'question', answer: { answers: [{ id: 'q', selected: ['yes'] }] },
    })).toEqual({ accepted: true })
    await expect(question).resolves.toEqual({ answers: [{ id: 'q', selected: ['yes'] }] })
    const cancelled = listeners.get('user-questions/request')?.({
      questions, agent: { session: { id: SessionId('s') } },
    }, () => Promise.reject(new Error('no answerer')))
    const cancellation = expect(cancelled).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    await server.shutdown()
    await cancellation
  })

  it('binds user-question registration across late load, removal, and replacement', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    const questions = [{ id: 'q', question: 'Choose', options: [{ label: 'yes' }] }]
    const session = { id: SessionId('questions') }
    const agent = { id: session.id, session } as unknown as Agent
    ctx.agents.enter(agent, undefined)

    const firstFiber = await ctx.plugin(UserQuestionService)
    await settleCordis()
    const firstService = ctx.userQuestions
    const first = firstService.ask({ questions, agent })
    await vi.waitFor(() => { expect(transport.notifications).toHaveLength(1) })
    const firstRequestId = String(transport.notifications[0]?.params?.requestId)
    expect(server.respondInteraction({ requestId: firstRequestId, kind: 'question-cancelled' }))
      .toEqual({ accepted: true })
    await expect(first).rejects.toMatchObject({ code: 'ASK_CANCELLED' })

    await firstFiber.dispose()
    await settleCordis()
    await expect(firstService.ask({ questions, agent })).rejects.toMatchObject({ code: 'NO_PROVIDER' })

    await ctx.plugin(UserQuestionService)
    await settleCordis()
    const replacementService = ctx.userQuestions
    const replacement = replacementService.ask({ questions, agent })
    await vi.waitFor(() => { expect(transport.notifications).toHaveLength(3) })
    const replacementRequest = transport.notifications.findLast(item => item.method === 'interaction.requested')
    expect(server.respondInteraction({
      requestId: String(replacementRequest?.params?.requestId),
      kind: 'question',
      answer: { answers: [{ id: 'q', selected: ['yes'] }] },
    })).toEqual({ accepted: true })
    await expect(replacement).resolves.toEqual({ answers: [{ id: 'q', selected: ['yes'] }] })

    await server.shutdown()
    await expect(replacementService.ask({ questions, agent })).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await ctx.fiber.dispose()
  })

  it('binds approval answering across late load, removal, and replacement', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    const events: SessionEvent[] = []
    const agent = { session: { id: SessionId('s'), events } } as unknown as Agent
    const request = { agent, toolName: 'bash' }

    const removeFirst = ctx.provide('approval', {} as never)
    events.push({
      type: 'approval/asked', seq: 0, time: 1,
      data: { id: 'approval-1' as never, toolName: 'bash' },
    })
    await settleCordis()
    const first = ctx.waterfall('approval/request', request, () => Promise.resolve('unavailable' as const))
    const firstNotification = transport.notifications.findLast(item => item.method === 'interaction.requested')
    expect(server.respondInteraction({
      requestId: String(firstNotification?.params?.requestId), kind: 'approval', outcome: 'allowed-once',
    })).toEqual({ accepted: true })
    await expect(first).resolves.toBe('allowed-once')

    removeFirst()
    await settleCordis()
    await expect(ctx.waterfall(
      'approval/request', request, () => Promise.resolve('unavailable' as const),
    )).resolves.toBe('unavailable')

    const removeReplacement = ctx.provide('approval', {} as never)
    events.push({
      type: 'approval/asked', seq: 1, time: 2,
      data: { id: 'approval-2' as never, toolName: 'bash' },
    })
    await settleCordis()
    const replacement = ctx.waterfall(
      'approval/request', request, () => Promise.resolve('unavailable' as const),
    )
    const replacementRequest = transport.notifications.findLast(item => item.method === 'interaction.requested')
    expect(replacementRequest?.params).toMatchObject({ approvalId: 'approval-2' })
    expect(server.respondInteraction({
      requestId: String(replacementRequest?.params?.requestId), kind: 'approval', outcome: 'rejected',
    })).toEqual({ accepted: true })
    await expect(replacement).resolves.toBe('rejected')

    await server.shutdown()
    await expect(ctx.waterfall(
      'approval/request', request, () => Promise.resolve('unavailable' as const),
    )).resolves.toBe('unavailable')
    removeReplacement()
    await ctx.fiber.dispose()
  })

  it.each(['approval', 'question'] as const)(
    'rolls back %s publication when the requested notification fails',
    async (kind) => {
      const listeners = new Map<string, (...args: unknown[]) => unknown>()
      const ctx = mockContext({
        on: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
          listeners.set(event, listener)
          return () => listeners.delete(event)
        }),
        agents: { create: vi.fn(), get: () => undefined },
        get: (key: string) => key === 'userQuestions' ? {} : key === 'approval' ? {} : undefined,
      })
      const server = new HarnessSdkJsonRpcServer(ctx, new ThrowingTransport('interaction.requested')) as unknown as {
        interactions: Map<string, unknown>
        shutdown(): Promise<Record<string, never>>
      }

      const wait = kind === 'approval'
        ? listeners.get('approval/request')?.({
          agent: { session: { id: SessionId('s'), events: [{
            type: 'approval/asked', seq: 0, time: 1,
            data: { id: 'approval-1', toolName: 'bash' },
          }] } }, toolName: 'bash',
        }, () => Promise.resolve('unavailable')) as Promise<unknown>
        : listeners.get('user-questions/request')?.({
          questions: [{ id: 'q', question: 'Choose', options: [{ label: 'yes' }] }],
          agent: { session: { id: SessionId('s') } },
        }, () => Promise.reject(new Error('no answerer')))
      await expect(wait).rejects.toThrow('interaction.requested write failed')
      expect(server.interactions).toHaveLength(0)
      await server.shutdown()
    },
  )

  it.each(['approval', 'question'] as const)(
    'settles %s waits when the resolved notification fails',
    async (kind) => {
      const listeners = new Map<string, (...args: unknown[]) => unknown>()
      const transport = new ThrowingTransport('interaction.resolved')
      const ctx = mockContext({
        on: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
          listeners.set(event, listener)
          return () => listeners.delete(event)
        }),
        agents: { create: vi.fn(), get: () => undefined },
        get: (key: string) => key === 'userQuestions' ? {} : key === 'approval' ? {} : undefined,
      })
      const server = new HarnessSdkJsonRpcServer(ctx, transport)

      const wait = kind === 'approval'
        ? listeners.get('approval/request')?.({
          agent: { session: { id: SessionId('s'), events: [{
            type: 'approval/asked', seq: 0, time: 1,
            data: { id: 'approval-1', toolName: 'bash' },
          }] } }, toolName: 'bash',
        }, () => Promise.resolve('unavailable')) as Promise<unknown>
        : listeners.get('user-questions/request')?.({
          questions: [{ id: 'q', question: 'Choose', options: [{ label: 'yes' }] }],
          agent: { session: { id: SessionId('s') } },
        }, () => Promise.reject(new Error('no answerer')))
      const request = transport.notifications.findLast(item => item.method === 'interaction.requested')?.params
      const response = kind === 'approval'
        ? server.respondInteraction({
          requestId: String(request?.requestId), kind: 'approval', outcome: 'allowed-once',
        })
        : server.respondInteraction({
          requestId: String(request?.requestId), kind: 'question',
          answer: { answers: [{ id: 'q', selected: ['yes'] }] },
        })
      expect(response).toEqual({ accepted: true })
      if (kind === 'approval') await expect(wait).resolves.toBe('allowed-once')
      else await expect(wait).resolves.toEqual({ answers: [{ id: 'q', selected: ['yes'] }] })
      await server.shutdown()
    },
  )

  it('owns asynchronous provider auth prompts with first-response and secret-free notifications', async () => {
    const transport = new FakeTransport()
    const llm = {
      authInfo: vi.fn(async (provider: string) => ({
        provider, configured: false, methods: [{ type: 'oauth' as const, label: 'Subscription' }],
      })),
      login: vi.fn(async (_provider: string, _type: string, interaction: {
        notify(event: object): void
        prompt(prompt: object): Promise<string>
      }) => {
        interaction.notify({ type: 'auth_url', url: 'https://example.test/login' })
        await interaction.prompt({ type: 'manual_code', message: 'Code' })
      }),
      logout: vi.fn(async () => undefined),
    }
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      llm,
      agents: { create: vi.fn(), get: () => undefined },
      get: (name: string) => name === 'llm' ? llm : undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    const { flowId } = await server.startAuth('openai-codex', 'oauth')
    await settleCordis()
    const prompt = transport.notifications.find(item => item.method === 'provider.auth.prompt')?.params
    expect(prompt).toMatchObject({ flowId, provider: 'openai-codex' })
    const promptId = String(prompt?.promptId)
    expect(server.respondAuth(flowId, promptId, 'sensitive-code')).toEqual({ accepted: true })
    expect(server.respondAuth(flowId, promptId, 'second')).toEqual({ accepted: false, reason: 'not-pending' })
    await settleCordis()
    expect(JSON.stringify(transport.notifications)).not.toContain('sensitive-code')
    expect(transport.notifications.at(-1)).toMatchObject({
      method: 'provider.auth.finished', params: { flowId, outcome: 'success' },
    })
    await server.logoutAuth('openai-codex')
    expect(llm.logout).toHaveBeenCalledWith('openai-codex')
    await server.shutdown()
  })

  it('refuses an auth start whose metadata lookup overlaps shutdown', async () => {
    const transport = new FakeTransport()
    let releaseInfo: (() => void) | undefined
    const infoGate = new Promise<void>((resolve) => { releaseInfo = resolve })
    const llm = {
      authInfo: vi.fn(async (provider: string) => {
        await infoGate
        return { provider, configured: false, methods: [{ type: 'oauth' as const, label: 'Subscription' }] }
      }),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    }
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      llm,
      agents: { create: vi.fn(), get: () => undefined },
      get: (name: string) => name === 'llm' ? llm : undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    const starting = server.startAuth('openai-codex', 'oauth')
    await settleCordis()
    const shutdown = server.shutdown()
    releaseInfo?.()
    await expect(starting).rejects.toThrow('SDK server is shutting down')
    await shutdown
    expect(llm.login).not.toHaveBeenCalled()
  })

  it('correlates prompt abort and whole-flow cancellation without echoing values', async () => {
    const transport = new FakeTransport()
    const promptController = new AbortController()
    let call = 0
    const llm = {
      authInfo: vi.fn(async (provider: string) => ({
        provider, configured: false, methods: [{ type: 'oauth' as const, label: 'Subscription' }],
      })),
      login: vi.fn(async (_provider: string, _type: string, interaction: {
        signal?: AbortSignal
        prompt(prompt: object): Promise<string>
      }) => {
        call += 1
        if (call === 1) {
          const waiting = interaction.prompt({ type: 'manual_code', message: 'Code', signal: promptController.signal })
          promptController.abort()
          await waiting
          return
        }
        await new Promise<void>((resolve) => {
          interaction.signal?.addEventListener('abort', () => { resolve() }, { once: true })
        })
        throw new Error('cancelled')
      }),
      logout: vi.fn(async () => undefined),
    }
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      llm,
      agents: { create: vi.fn(), get: () => undefined },
      get: (name: string) => name === 'llm' ? llm : undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    const first = await server.startAuth('openai-codex', 'oauth')
    await settleCordis()
    expect(transport.notifications.some(notification => notification.method === 'provider.auth.promptResolved'
      && notification.params?.flowId === first.flowId)).toBe(true)
    expect(transport.notifications.some(notification => notification.method === 'provider.auth.finished'
      && notification.params?.flowId === first.flowId && notification.params.outcome === 'error')).toBe(true)

    const second = await server.startAuth('openai-codex', 'oauth')
    await settleCordis()
    expect(server.cancelAuth(second.flowId)).toEqual({ requested: true })
    await settleCordis()
    expect(transport.notifications.some(notification => notification.method === 'provider.auth.finished'
      && notification.params?.flowId === second.flowId && notification.params.outcome === 'cancelled')).toBe(true)

    const third = await server.startAuth('openai-codex', 'oauth')
    await settleCordis()
    await server.shutdown()
    expect(transport.notifications.some(notification => notification.method === 'provider.auth.finished'
      && notification.params?.flowId === third.flowId && notification.params.outcome === 'cancelled')).toBe(true)
  })

  it('settles every teardown and aggregates multiple failures', async () => {
    const firstDispose = vi.fn(() => { throw new Error('first teardown failed') })
    const secondDispose = vi.fn(() => Promise.reject(new Error('second teardown failed')))
    const ctx = mockContext({
      on: vi.fn(() => () => undefined),
      agents: { create: vi.fn(), get: () => undefined },
      get: () => undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
      sessions: Map<string, { handle: AgentHandle; selection: object; commands: Set<never>; closing: boolean }>
      shutdown(): Promise<Record<string, never>>
    }
    server.sessions.set('first', {
      handle: { agent: {} as Agent, dispose: firstDispose }, selection: {}, commands: new Set(), closing: false,
    })
    server.sessions.set('second', {
      handle: { agent: {} as Agent, dispose: secondDispose }, selection: {}, commands: new Set(), closing: false,
    })

    await expect(server.shutdown()).rejects.toThrow('SDK server teardown failed')
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(secondDispose).toHaveBeenCalledOnce()
  })

  it('continues teardown after a subscription disposer fails', async () => {
    let subscription = 0
    const listenerFailure = new Error('listener teardown failed')
    const on = vi.fn(() => {
      subscription += 1
      return subscription === 1 ? () => { throw listenerFailure } : () => undefined
    })
    const ctx = mockContext({
      on,
      agents: { create: vi.fn(), get: () => undefined },
      get: () => undefined,
    })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

    await expect(server.shutdown()).rejects.toBe(listenerFailure)
    expect(on).toHaveBeenCalledTimes(4)
  })
})
