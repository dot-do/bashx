/**
 * rpc.do Integration Tests (TDD RED Phase)
 *
 * Tests for rpc.do integration in bashx.do providing:
 * - RPC client for remote bash execution via magic proxy
 * - RPC server exposing BashModule methods
 * - WebSocket transport with binary serialization
 * - Streaming stdout/stderr via RPC
 * - OAuth integration with bash scopes
 * - Error handling and reconnection
 * - Safety checking via RPC
 *
 * rpc.do API Reference:
 * Client:
 *   - DO(url): MagicProxy - Creates magic proxy for RPC calls
 *   - createClient(options): DOClient - Creates RPC client with options
 * Server:
 *   - $: ServerContext - Server context with sql/storage access
 *   - createRPCHandler(instance, ctx): RPCHandler
 *   - rpc(handler, options): Decorated handler
 *   - createStreamResponse(controller): Response
 *
 * These tests are designed to FAIL initially (RED phase).
 * Implementation will make them pass (GREEN phase).
 *
 * @module bashx/tests/do/rpc
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BashResult, ExecOptions, SpawnOptions, SpawnHandle } from '../../src/types.js'

// ============================================================================
// Mock Types (rpc.do interfaces we expect to integrate with)
// ============================================================================

/**
 * Connection state for RPC transport
 */
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

/**
 * RPC request message
 */
interface RPCRequest {
  type: 'request'
  id: string
  path: string[]
  args: unknown[]
  timestamp: number
}

/**
 * RPC response message
 */
interface RPCResponse {
  type: 'response'
  id: string
  success: boolean
  result?: unknown
  error?: RPCError
  timestamp: number
}

/**
 * RPC error structure
 */
interface RPCError {
  code: string
  message: string
  stack?: string
  data?: unknown
}

/**
 * Stream chunk for streaming responses
 */
interface RPCStreamChunk {
  type: 'stream'
  id: string
  chunk: unknown
  done: boolean
  index: number
  timestamp: number
}

/**
 * Stream controller for server-side streaming
 */
interface StreamController<T> {
  send(chunk: T): void
  done(): void
  error(err: Error): void
}

/**
 * DOClient options
 */
interface DOClientOptions {
  url: string
  protocol?: 'ws' | 'wss'
  reconnect?: {
    enabled?: boolean
    maxAttempts?: number
    backoffMs?: number
    maxBackoffMs?: number
  }
  timeout?: number
  batching?: {
    enabled?: boolean
    maxSize?: number
    delayMs?: number
  }
  headers?: Record<string, string>
}

/**
 * Error codes for RPC errors
 */
const ErrorCodes = {
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  CONNECTION_CLOSED: 'CONNECTION_CLOSED',
  TIMEOUT: 'TIMEOUT',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  SERIALIZATION_ERROR: 'SERIALIZATION_ERROR',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const

// ============================================================================
// Import statements for implementation (will fail until implemented)
// ============================================================================

// These imports will fail initially - that's expected for RED phase
// Once RPC integration is implemented, these will resolve
import {
  // Client-side
  RPCBashBackend,
  createRPCBashClient,
  // Server-side
  RPCBashDO,
  createBashRPCHandler,
  exposeBashModule,
  // Types
  type RPCBashClientOptions,
  type RPCBashServerConfig,
  type BashRPCNamespace,
  type StreamingExecHandle,
} from '../../src/do/rpc.js'

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock transport for testing RPC communication
 */
function createMockTransport() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  const sentMessages: (RPCRequest | RPCStreamChunk)[] = []
  let state: ConnectionState = 'connected'
  let autoRespond = true
  let responseDelay = 0
  let customResponder: ((request: RPCRequest) => RPCResponse) | undefined

  return {
    sentMessages,
    on(event: string, handler: (...args: unknown[]) => void): () => void {
      if (!handlers.has(event)) {
        handlers.set(event, new Set())
      }
      handlers.get(event)!.add(handler)
      return () => handlers.get(event)?.delete(handler)
    },
    emit(event: string, ...args: unknown[]): void {
      const eventHandlers = handlers.get(event)
      if (eventHandlers) {
        for (const handler of eventHandlers) {
          handler(...args)
        }
      }
    },
    send(message: RPCRequest | RPCStreamChunk): void {
      sentMessages.push(message)
      if (autoRespond && message.type === 'request') {
        const request = message as RPCRequest
        setTimeout(() => {
          let response: RPCResponse
          if (customResponder) {
            response = customResponder(request)
          } else {
            response = {
              type: 'response',
              id: request.id,
              success: true,
              result: { path: request.path, args: request.args },
              timestamp: Date.now(),
            }
          }
          this.emit('message', response)
        }, responseDelay)
      }
    },
    getState(): ConnectionState {
      return state
    },
    setState(newState: ConnectionState): void {
      state = newState
    },
    setAutoRespond(enabled: boolean): void {
      autoRespond = enabled
    },
    setResponseDelay(ms: number): void {
      responseDelay = ms
    },
    setCustomResponder(responder: (request: RPCRequest) => RPCResponse): void {
      customResponder = responder
    },
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    clear(): void {
      sentMessages.length = 0
      customResponder = undefined
      autoRespond = true
      responseDelay = 0
    },
  }
}

/**
 * Create a mock BashModule for server-side testing
 */
function createMockBashModule() {
  return {
    name: 'bash' as const,
    exec: vi.fn().mockResolvedValue({
      input: 'ls',
      command: 'ls',
      valid: true,
      generated: false,
      stdout: 'file1.txt\nfile2.txt',
      stderr: '',
      exitCode: 0,
      intent: { commands: ['ls'], reads: [], writes: [], deletes: [], network: false, elevated: false },
      classification: { type: 'read', impact: 'none', reversible: true, reason: 'List directory' },
    } satisfies BashResult),
    spawn: vi.fn().mockResolvedValue({
      pid: 1234,
      done: Promise.resolve({} as BashResult),
      kill: vi.fn(),
      write: vi.fn(),
      closeStdin: vi.fn(),
    } satisfies SpawnHandle),
    run: vi.fn().mockResolvedValue({
      input: 'echo hello',
      command: 'echo hello',
      valid: true,
      generated: false,
      stdout: 'hello',
      stderr: '',
      exitCode: 0,
      intent: { commands: ['echo'], reads: [], writes: [], deletes: [], network: false, elevated: false },
      classification: { type: 'read', impact: 'none', reversible: true, reason: 'Echo command' },
    } satisfies BashResult),
    analyze: vi.fn().mockReturnValue({
      classification: { type: 'read', impact: 'none', reversible: true, reason: 'Safe' },
      intent: { commands: ['ls'], reads: [], writes: [], deletes: [], network: false, elevated: false },
    }),
    isDangerous: vi.fn().mockReturnValue({ dangerous: false }),
    parse: vi.fn().mockReturnValue({ type: 'Program', body: [], errors: [] }),
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Create mock OAuth context for testing
 */
function createMockOAuthContext(overrides: Partial<{
  authenticated: boolean
  userId: string
  permissions: { exec: boolean; admin: boolean }
  scopes: string[]
}> = {}) {
  return {
    authenticated: overrides.authenticated ?? true,
    userId: overrides.userId ?? 'user-123',
    permissions: overrides.permissions ?? { exec: true, admin: false },
    scopes: overrides.scopes ?? ['bash:exec'],
  }
}

// ============================================================================
// RPCBashBackend Client Tests
// ============================================================================

describe('RPCBashBackend', () => {
  describe('Client Creation', () => {
    it('should create RPC client for remote bash execution', () => {
      const client = createRPCBashClient({
        url: 'https://bash.example.com',
      })

      expect(client).toBeDefined()
      expect(typeof client.bash).toBe('object')
    })

    it('should create client with custom options', () => {
      const client = createRPCBashClient({
        url: 'wss://bash.example.com',
        timeout: 60000,
        reconnect: {
          enabled: true,
          maxAttempts: 5,
          backoffMs: 1000,
        },
        headers: {
          Authorization: 'Bearer token123',
        },
      })

      expect(client).toBeDefined()
    })

    it('should auto-detect WebSocket protocol from URL', () => {
      const httpsClient = createRPCBashClient({ url: 'https://bash.example.com' })
      const httpClient = createRPCBashClient({ url: 'http://localhost:8787' })

      // Both should be valid clients
      expect(httpsClient).toBeDefined()
      expect(httpClient).toBeDefined()
    })

    it('should support explicit WebSocket protocol override', () => {
      const client = createRPCBashClient({
        url: 'http://bash.example.com',
        protocol: 'wss',
      })

      expect(client).toBeDefined()
    })
  })

  describe('Magic Proxy for Bash Operations', () => {
    let mockTransport: ReturnType<typeof createMockTransport>
    let client: RPCBashBackend

    beforeEach(() => {
      mockTransport = createMockTransport()
      // Inject mock transport for testing
      client = new RPCBashBackend(mockTransport as any)
    })

    afterEach(() => {
      mockTransport.clear()
    })

    it('should proxy $.bash.exec() calls', async () => {
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: {
          input: 'ls -la',
          command: 'ls -la',
          valid: true,
          generated: false,
          stdout: 'total 32\ndrwxr-xr-x  2 user user 4096 Jan 1 00:00 .',
          stderr: '',
          exitCode: 0,
          intent: { commands: ['ls'], reads: [], writes: [], deletes: [], network: false, elevated: false },
          classification: { type: 'read', impact: 'none', reversible: true, reason: 'List' },
        } satisfies BashResult,
        timestamp: Date.now(),
      }))

      const result = await client.bash.exec('ls', ['-la'])

      expect(result.stdout).toContain('drwxr-xr-x')
      expect(result.exitCode).toBe(0)
      expect(mockTransport.sentMessages).toHaveLength(1)

      const request = mockTransport.sentMessages[0] as RPCRequest
      expect(request.path).toEqual(['bash', 'exec'])
      expect(request.args).toEqual(['ls', ['-la']])
    })

    it('should proxy $.bash.run() calls for scripts', async () => {
      const script = 'echo "hello"\necho "world"'
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: {
          input: script,
          command: script,
          valid: true,
          generated: false,
          stdout: 'hello\nworld',
          stderr: '',
          exitCode: 0,
          intent: { commands: ['echo'], reads: [], writes: [], deletes: [], network: false, elevated: false },
          classification: { type: 'read', impact: 'none', reversible: true, reason: 'Echo' },
        } satisfies BashResult,
        timestamp: Date.now(),
      }))

      const result = await client.bash.run(script)

      expect(result.stdout).toBe('hello\nworld')
      const request = mockTransport.sentMessages[0] as RPCRequest
      expect(request.path).toEqual(['bash', 'run'])
    })

    it('should proxy $.bash.analyze() calls', async () => {
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: {
          classification: { type: 'delete', impact: 'high', reversible: false, reason: 'Recursive delete' },
          intent: { commands: ['rm'], reads: [], writes: [], deletes: ['/tmp/data'], network: false, elevated: false },
        },
        timestamp: Date.now(),
      }))

      const analysis = await client.bash.analyze('rm -rf /tmp/data')

      expect(analysis.classification.type).toBe('delete')
      expect(analysis.classification.impact).toBe('high')
    })

    it('should proxy $.bash.isDangerous() calls', async () => {
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: { dangerous: true, reason: 'Recursive delete operation' },
        timestamp: Date.now(),
      }))

      const check = await client.bash.isDangerous('rm -rf /')

      expect(check.dangerous).toBe(true)
      expect(check.reason).toContain('Recursive delete')
    })

    it('should proxy $.bash.parse() calls', async () => {
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: {
          type: 'Program',
          body: [{ type: 'Command', name: 'ls', args: ['-la'] }],
          errors: [],
        },
        timestamp: Date.now(),
      }))

      const ast = await client.bash.parse('ls -la')

      expect(ast.type).toBe('Program')
    })

    it('should pass execution options through RPC', async () => {
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: {
          input: 'npm install',
          command: 'npm install',
          valid: true,
          generated: false,
          stdout: '',
          stderr: '',
          exitCode: 0,
          intent: { commands: ['npm'], reads: [], writes: [], deletes: [], network: true, elevated: false },
          classification: { type: 'write', impact: 'medium', reversible: true, reason: 'NPM' },
        } satisfies BashResult,
        timestamp: Date.now(),
      }))

      const options: ExecOptions = {
        cwd: '/app',
        timeout: 120000,
        env: { NODE_ENV: 'production' },
      }

      await client.bash.exec('npm', ['install'], options)

      const request = mockTransport.sentMessages[0] as RPCRequest
      expect(request.args).toEqual(['npm', ['install'], options])
    })
  })

  describe('Connection State Management', () => {
    let mockTransport: ReturnType<typeof createMockTransport>
    let client: RPCBashBackend

    beforeEach(() => {
      mockTransport = createMockTransport()
      client = new RPCBashBackend(mockTransport as any)
    })

    it('should expose connection state', () => {
      expect(client.connectionState).toBe('connected')
    })

    it('should track state transitions', async () => {
      const states: ConnectionState[] = []

      client.onStateChange((state) => states.push(state))

      mockTransport.emit('connecting')
      mockTransport.emit('connected')
      mockTransport.emit('disconnected')

      expect(states).toContain('connecting')
      expect(states).toContain('connected')
      expect(states).toContain('disconnected')
    })

    it('should expose isConnected helper', () => {
      mockTransport.setState('connected')
      expect(client.isConnected).toBe(true)

      mockTransport.setState('disconnected')
      expect(client.isConnected).toBe(false)
    })

    it('should wait for connection before executing', async () => {
      mockTransport.setState('connecting')

      const execPromise = client.bash.exec('ls')

      // Simulate connection established
      mockTransport.setState('connected')
      mockTransport.emit('connected')

      const result = await execPromise
      expect(result).toBeDefined()
    })
  })

  describe('Automatic Reconnection', () => {
    let mockTransport: ReturnType<typeof createMockTransport>

    beforeEach(() => {
      mockTransport = createMockTransport()
    })

    it('should reconnect on connection loss', async () => {
      const client = new RPCBashBackend(mockTransport as any, {
        reconnect: { enabled: true, maxAttempts: 3 },
      })

      mockTransport.emit('disconnected', 'connection lost')

      // Should attempt reconnection
      expect(mockTransport.connect).toHaveBeenCalled()
    })

    it('should use exponential backoff for reconnection', async () => {
      vi.useFakeTimers()

      const client = new RPCBashBackend(mockTransport as any, {
        reconnect: {
          enabled: true,
          maxAttempts: 3,
          backoffMs: 100,
          maxBackoffMs: 1000,
        },
      })

      mockTransport.connect.mockRejectedValueOnce(new Error('fail 1'))
      mockTransport.connect.mockRejectedValueOnce(new Error('fail 2'))
      mockTransport.connect.mockResolvedValueOnce(undefined)

      mockTransport.emit('disconnected')

      // First attempt immediate
      await vi.advanceTimersByTimeAsync(0)
      expect(mockTransport.connect).toHaveBeenCalledTimes(1)

      // Second attempt after 100ms
      await vi.advanceTimersByTimeAsync(100)
      expect(mockTransport.connect).toHaveBeenCalledTimes(2)

      // Third attempt after 200ms (exponential)
      await vi.advanceTimersByTimeAsync(200)
      expect(mockTransport.connect).toHaveBeenCalledTimes(3)

      vi.useRealTimers()
    })

    it('should emit reconnect events', async () => {
      const reconnectAttempts: number[] = []
      const client = new RPCBashBackend(mockTransport as any, {
        reconnect: { enabled: true },
      })

      client.onReconnect((attempt) => reconnectAttempts.push(attempt))

      mockTransport.emit('reconnecting', 1)
      mockTransport.emit('reconnecting', 2)

      expect(reconnectAttempts).toEqual([1, 2])
    })

    it('should give up after max attempts', async () => {
      const client = new RPCBashBackend(mockTransport as any, {
        reconnect: { enabled: true, maxAttempts: 2 },
      })

      let finalError: Error | undefined
      client.onError((err) => { finalError = err })

      mockTransport.connect.mockRejectedValue(new Error('connection failed'))

      mockTransport.emit('disconnected')

      // Wait for all attempts
      await vi.waitFor(() => mockTransport.connect.mock.calls.length >= 2)

      expect(finalError?.message).toContain('max reconnection attempts')
    })

    it('should queue requests during reconnection', async () => {
      const client = new RPCBashBackend(mockTransport as any, {
        reconnect: { enabled: true },
      })

      mockTransport.setState('reconnecting')

      // These should be queued
      const promise1 = client.bash.exec('ls')
      const promise2 = client.bash.exec('pwd')

      // No messages sent while reconnecting
      expect(mockTransport.sentMessages).toHaveLength(0)

      // Reconnect succeeds
      mockTransport.setState('connected')
      mockTransport.emit('connected')

      // Queued requests should now be sent
      await vi.waitFor(() => mockTransport.sentMessages.length >= 2)
      expect(mockTransport.sentMessages).toHaveLength(2)
    })
  })
})

// ============================================================================
// RPCBashDO Server Tests
// ============================================================================

describe('RPCBashDO Server', () => {
  describe('Handler Creation', () => {
    it('should create RPC handler from BashModule', () => {
      const bashModule = createMockBashModule()
      const handler = createBashRPCHandler(bashModule)

      expect(handler).toBeDefined()
      expect(typeof handler.fetch).toBe('function')
    })

    it('should expose BashModule methods via RPC', () => {
      const bashModule = createMockBashModule()
      const namespace = exposeBashModule(bashModule)

      expect(namespace.exec).toBeDefined()
      expect(namespace.run).toBeDefined()
      expect(namespace.spawn).toBeDefined()
      expect(namespace.analyze).toBeDefined()
      expect(namespace.isDangerous).toBeDefined()
      expect(namespace.parse).toBeDefined()
    })

    it('should support custom server configuration', () => {
      const bashModule = createMockBashModule()
      const handler = createBashRPCHandler(bashModule, {
        maxConcurrentCommands: 10,
        defaultTimeout: 30000,
        enableStreaming: true,
      })

      expect(handler).toBeDefined()
    })
  })

  describe('Method Invocation', () => {
    let bashModule: ReturnType<typeof createMockBashModule>
    let handler: { fetch: (request: Request) => Promise<Response> }

    beforeEach(() => {
      bashModule = createMockBashModule()
      handler = createBashRPCHandler(bashModule)
    })

    it('should handle exec RPC calls', async () => {
      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'call-1',
          path: ['bash', 'exec'],
          args: ['ls', ['-la']],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(true)
      expect(bashModule.exec).toHaveBeenCalledWith('ls', ['-la'])
    })

    it('should handle run RPC calls', async () => {
      const script = 'npm run build'
      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'call-2',
          path: ['bash', 'run'],
          args: [script, { timeout: 60000 }],
          timestamp: Date.now(),
        }),
      })

      await handler.fetch(request)

      expect(bashModule.run).toHaveBeenCalledWith(script, { timeout: 60000 })
    })

    it('should handle analyze RPC calls', async () => {
      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'call-3',
          path: ['bash', 'analyze'],
          args: ['rm -rf /'],
          timestamp: Date.now(),
        }),
      })

      await handler.fetch(request)

      expect(bashModule.analyze).toHaveBeenCalledWith('rm -rf /')
    })

    it('should return METHOD_NOT_FOUND for unknown paths', async () => {
      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'call-4',
          path: ['bash', 'unknownMethod'],
          args: [],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(false)
      expect(data.error.code).toBe(ErrorCodes.METHOD_NOT_FOUND)
    })
  })

  describe('Streaming stdout/stderr', () => {
    let bashModule: ReturnType<typeof createMockBashModule>
    let handler: { fetch: (request: Request) => Promise<Response> }

    beforeEach(() => {
      bashModule = createMockBashModule()
      handler = createBashRPCHandler(bashModule, { enableStreaming: true })
    })

    it('should stream command output', async () => {
      // Mock spawn to emit chunks
      let streamController: StreamController<{ stdout?: string; stderr?: string }>
      bashModule.spawn.mockImplementation(async () => {
        return {
          pid: 1234,
          done: new Promise((resolve) => {
            streamController = {
              send: vi.fn(),
              done: () => resolve({} as BashResult),
              error: vi.fn(),
            }
          }),
          kill: vi.fn(),
          write: vi.fn(),
          closeStdin: vi.fn(),
        }
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        headers: { 'Accept': 'text/event-stream' },
        body: JSON.stringify({
          type: 'request',
          id: 'stream-1',
          path: ['bash', 'stream'],
          args: ['tail', ['-f', '/var/log/app.log']],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)

      expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    })

    it('should handle streaming stderr', async () => {
      const chunks: string[] = []

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'stream-2',
          path: ['bash', 'streamExec'],
          args: ['some-command-with-stderr'],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const reader = response.body?.getReader()

      // Read streamed chunks
      if (reader) {
        const decoder = new TextDecoder()
        let done = false
        while (!done) {
          const { value, done: readerDone } = await reader.read()
          done = readerDone
          if (value) {
            chunks.push(decoder.decode(value))
          }
        }
      }

      // Verify streaming format
      expect(response.headers.get('Content-Type')).toContain('event-stream')
    })

    it('should support binary data streaming for file transfers', async () => {
      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'binary-1',
          path: ['bash', 'streamBinary'],
          args: ['cat', ['binary-file.bin']],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)

      // Binary streams should use application/octet-stream
      expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
    })
  })

  describe('Batch Command Execution', () => {
    let bashModule: ReturnType<typeof createMockBashModule>
    let handler: { fetch: (request: Request) => Promise<Response> }

    beforeEach(() => {
      bashModule = createMockBashModule()
      handler = createBashRPCHandler(bashModule)
    })

    it('should handle batch RPC requests', async () => {
      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'batch',
          requests: [
            { type: 'request', id: 'b1', path: ['bash', 'exec'], args: ['ls'], timestamp: Date.now() },
            { type: 'request', id: 'b2', path: ['bash', 'exec'], args: ['pwd'], timestamp: Date.now() },
            { type: 'request', id: 'b3', path: ['bash', 'exec'], args: ['whoami'], timestamp: Date.now() },
          ],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.type).toBe('batch')
      expect(data.responses).toHaveLength(3)
      expect(bashModule.exec).toHaveBeenCalledTimes(3)
    })

    it('should execute batch commands in parallel by default', async () => {
      const executionOrder: string[] = []
      bashModule.exec.mockImplementation(async (cmd: string) => {
        executionOrder.push(`start:${cmd}`)
        await new Promise((r) => setTimeout(r, 10))
        executionOrder.push(`end:${cmd}`)
        return {} as BashResult
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'batch',
          requests: [
            { type: 'request', id: 'b1', path: ['bash', 'exec'], args: ['cmd1'], timestamp: Date.now() },
            { type: 'request', id: 'b2', path: ['bash', 'exec'], args: ['cmd2'], timestamp: Date.now() },
          ],
          timestamp: Date.now(),
        }),
      })

      await handler.fetch(request)

      // Parallel execution: starts interleave with ends
      expect(executionOrder[0]).toBe('start:cmd1')
      expect(executionOrder[1]).toBe('start:cmd2')
    })

    it('should support sequential batch execution option', async () => {
      const executionOrder: string[] = []
      bashModule.exec.mockImplementation(async (cmd: string) => {
        executionOrder.push(`start:${cmd}`)
        await new Promise((r) => setTimeout(r, 10))
        executionOrder.push(`end:${cmd}`)
        return {} as BashResult
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'batch',
          sequential: true,
          requests: [
            { type: 'request', id: 'b1', path: ['bash', 'exec'], args: ['cmd1'], timestamp: Date.now() },
            { type: 'request', id: 'b2', path: ['bash', 'exec'], args: ['cmd2'], timestamp: Date.now() },
          ],
          timestamp: Date.now(),
        }),
      })

      await handler.fetch(request)

      // Sequential: first ends before second starts
      expect(executionOrder).toEqual(['start:cmd1', 'end:cmd1', 'start:cmd2', 'end:cmd2'])
    })

    it('should handle partial failures in batch', async () => {
      bashModule.exec.mockImplementation(async (cmd: string) => {
        if (cmd === 'fail') {
          throw new Error('Command failed')
        }
        return {} as BashResult
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'batch',
          requests: [
            { type: 'request', id: 'b1', path: ['bash', 'exec'], args: ['succeed'], timestamp: Date.now() },
            { type: 'request', id: 'b2', path: ['bash', 'exec'], args: ['fail'], timestamp: Date.now() },
            { type: 'request', id: 'b3', path: ['bash', 'exec'], args: ['succeed'], timestamp: Date.now() },
          ],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.responses[0].success).toBe(true)
      expect(data.responses[1].success).toBe(false)
      expect(data.responses[2].success).toBe(true)
    })
  })
})

// ============================================================================
// RPC Transport Tests
// ============================================================================

describe('RPC Transport', () => {
  describe('WebSocket Connection', () => {
    it('should establish WebSocket connection', async () => {
      const client = createRPCBashClient({
        url: 'wss://bash.example.com/ws',
      })

      await client.connect()

      expect(client.connectionState).toBe('connected')
    })

    it('should handle connection failure', async () => {
      const client = createRPCBashClient({
        url: 'wss://invalid.example.com/ws',
        reconnect: { enabled: false },
      })

      await expect(client.connect()).rejects.toThrow()
      expect(client.connectionState).toBe('disconnected')
    })

    it('should support graceful disconnect', async () => {
      const mockTransport = createMockTransport()
      const client = new RPCBashBackend(mockTransport as any)

      await client.disconnect()

      expect(mockTransport.disconnect).toHaveBeenCalled()
      expect(client.connectionState).toBe('closed')
    })
  })

  describe('Binary Serialization', () => {
    let mockTransport: ReturnType<typeof createMockTransport>

    beforeEach(() => {
      mockTransport = createMockTransport()
    })

    it('should serialize RPC messages to binary', async () => {
      const client = new RPCBashBackend(mockTransport as any, {
        serializer: 'binary',
      })

      await client.bash.exec('ls')

      // The sent message should be binary (ArrayBuffer or Uint8Array)
      const sentMessage = mockTransport.sentMessages[0]
      expect(sentMessage).toBeDefined()
    })

    it('should deserialize binary RPC responses', async () => {
      const client = new RPCBashBackend(mockTransport as any, {
        serializer: 'binary',
      })

      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: { stdout: 'binary test', exitCode: 0 },
        timestamp: Date.now(),
      }))

      const result = await client.bash.exec('ls')

      expect(result.stdout).toBe('binary test')
    })

    it('should fall back to JSON serializer when binary fails', async () => {
      const client = new RPCBashBackend(mockTransport as any, {
        serializer: 'binary',
        fallbackSerializer: 'json',
      })

      // Simulate binary parse failure
      mockTransport.emit('message', { corrupted: true })

      // Should not throw, should use fallback
      expect(client.connectionState).not.toBe('closed')
    })
  })

  describe('Message Batching', () => {
    let mockTransport: ReturnType<typeof createMockTransport>

    beforeEach(() => {
      mockTransport = createMockTransport()
    })

    it('should batch multiple requests', async () => {
      vi.useFakeTimers()

      const client = new RPCBashBackend(mockTransport as any, {
        batching: {
          enabled: true,
          maxSize: 10,
          delayMs: 50,
        },
      })

      // Fire multiple requests rapidly
      const promises = [
        client.bash.exec('ls'),
        client.bash.exec('pwd'),
        client.bash.exec('whoami'),
      ]

      // Advance time to trigger batch
      await vi.advanceTimersByTimeAsync(50)

      // Should send one batched message instead of three
      expect(mockTransport.sentMessages).toHaveLength(1)
      expect(mockTransport.sentMessages[0].type).toBe('batch')

      vi.useRealTimers()
    })

    it('should flush batch when max size reached', async () => {
      const client = new RPCBashBackend(mockTransport as any, {
        batching: {
          enabled: true,
          maxSize: 2,
          delayMs: 1000,
        },
      })

      // Fire requests up to max size
      client.bash.exec('cmd1')
      client.bash.exec('cmd2')

      // Should immediately flush without waiting for delay
      await vi.waitFor(() => mockTransport.sentMessages.length > 0)
      expect(mockTransport.sentMessages[0].type).toBe('batch')
    })

    it('should disable batching by default', async () => {
      const client = new RPCBashBackend(mockTransport as any)

      await client.bash.exec('ls')
      await client.bash.exec('pwd')

      // Each request sent individually
      expect(mockTransport.sentMessages).toHaveLength(2)
      expect(mockTransport.sentMessages[0].type).toBe('request')
    })
  })

  describe('Ping/Pong Keepalive', () => {
    let mockTransport: ReturnType<typeof createMockTransport>

    beforeEach(() => {
      mockTransport = createMockTransport()
    })

    it('should send periodic ping messages', async () => {
      vi.useFakeTimers()

      const client = new RPCBashBackend(mockTransport as any, {
        keepalive: {
          enabled: true,
          intervalMs: 30000,
        },
      })

      await vi.advanceTimersByTimeAsync(30000)

      const pings = mockTransport.sentMessages.filter((m) => m.type === 'ping')
      expect(pings.length).toBeGreaterThan(0)

      vi.useRealTimers()
    })

    it('should respond to ping with pong', async () => {
      const client = new RPCBashBackend(mockTransport as any)

      mockTransport.emit('message', { type: 'ping', timestamp: Date.now() })

      // Should have sent a pong response
      const pongs = mockTransport.sentMessages.filter((m) => m.type === 'pong')
      expect(pongs.length).toBe(1)
    })

    it('should detect connection timeout on missed pongs', async () => {
      vi.useFakeTimers()

      let disconnected = false
      const client = new RPCBashBackend(mockTransport as any, {
        keepalive: {
          enabled: true,
          intervalMs: 1000,
          timeoutMs: 3000,
        },
      })

      client.onStateChange((state) => {
        if (state === 'disconnected') {
          disconnected = true
        }
      })

      // Don't respond to pings
      mockTransport.setAutoRespond(false)

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(5000)

      expect(disconnected).toBe(true)

      vi.useRealTimers()
    })
  })
})

// ============================================================================
// OAuth Integration Tests
// ============================================================================

describe('OAuth Integration with RPC', () => {
  let mockTransport: ReturnType<typeof createMockTransport>
  let bashModule: ReturnType<typeof createMockBashModule>

  beforeEach(() => {
    mockTransport = createMockTransport()
    bashModule = createMockBashModule()
  })

  describe('Auth Headers', () => {
    it('should include Authorization header in RPC requests', async () => {
      const client = new RPCBashBackend(mockTransport as any, {
        headers: {
          Authorization: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
        },
      })

      await client.bash.exec('ls')

      const request = mockTransport.sentMessages[0] as RPCRequest & { headers?: Record<string, string> }
      expect(request.headers?.Authorization).toContain('Bearer')
    })

    it('should support bash:execute scope', async () => {
      const client = new RPCBashBackend(mockTransport as any, {
        headers: {
          Authorization: 'Bearer token-with-bash-execute-scope',
        },
        scopes: ['bash:execute'],
      })

      await client.bash.exec('ls')

      // Request should include scope information
      expect(client.hasScope('bash:execute')).toBe(true)
    })

    it('should support bash:admin scope for dangerous commands', async () => {
      const client = new RPCBashBackend(mockTransport as any, {
        headers: {
          Authorization: 'Bearer token-with-admin-scope',
        },
        scopes: ['bash:execute', 'bash:admin'],
      })

      expect(client.hasScope('bash:admin')).toBe(true)
    })
  })

  describe('Token Refresh', () => {
    it('should trigger token refresh on UNAUTHORIZED error', async () => {
      const refreshToken = vi.fn().mockResolvedValue('new-token')

      const client = new RPCBashBackend(mockTransport as any, {
        auth: {
          token: 'expired-token',
          refreshToken,
        },
      })

      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: false,
        error: { code: ErrorCodes.UNAUTHORIZED, message: 'Token expired' },
        timestamp: Date.now(),
      }))

      await client.bash.exec('ls')

      expect(refreshToken).toHaveBeenCalled()
    })

    it('should retry request after token refresh', async () => {
      let callCount = 0
      const refreshToken = vi.fn().mockResolvedValue('new-token')

      const client = new RPCBashBackend(mockTransport as any, {
        auth: {
          token: 'expired-token',
          refreshToken,
        },
      })

      mockTransport.setCustomResponder((request) => {
        callCount++
        if (callCount === 1) {
          return {
            type: 'response',
            id: request.id,
            success: false,
            error: { code: ErrorCodes.UNAUTHORIZED, message: 'Token expired' },
            timestamp: Date.now(),
          }
        }
        return {
          type: 'response',
          id: request.id,
          success: true,
          result: { stdout: 'success', exitCode: 0 },
          timestamp: Date.now(),
        }
      })

      const result = await client.bash.exec('ls')

      expect(callCount).toBe(2)
      expect(result.stdout).toBe('success')
    })

    it('should fail after max refresh attempts', async () => {
      const refreshToken = vi.fn().mockResolvedValue('still-invalid-token')

      const client = new RPCBashBackend(mockTransport as any, {
        auth: {
          token: 'bad-token',
          refreshToken,
          maxRefreshAttempts: 2,
        },
      })

      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: false,
        error: { code: ErrorCodes.UNAUTHORIZED, message: 'Unauthorized' },
        timestamp: Date.now(),
      }))

      await expect(client.bash.exec('ls')).rejects.toThrow('UNAUTHORIZED')
      expect(refreshToken).toHaveBeenCalledTimes(2)
    })
  })

  describe('Permission Checking via RPC', () => {
    it('should check bash:execute permission for exec calls', async () => {
      const handler = createBashRPCHandler(bashModule, {
        auth: {
          required: true,
          requiredScopes: {
            exec: ['bash:execute'],
            run: ['bash:execute'],
            spawn: ['bash:execute'],
          },
        },
      })

      // Request without auth
      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'call-1',
          path: ['bash', 'exec'],
          args: ['ls'],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(false)
      expect(data.error.code).toBe(ErrorCodes.UNAUTHORIZED)
    })

    it('should allow exec with valid bash:execute token', async () => {
      const handler = createBashRPCHandler(bashModule, {
        auth: {
          required: true,
          verifyToken: vi.fn().mockResolvedValue({
            valid: true,
            payload: { sub: 'user-1', scope: 'bash:execute' },
          }),
        },
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
        },
        body: JSON.stringify({
          type: 'request',
          id: 'call-1',
          path: ['bash', 'exec'],
          args: ['ls'],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(true)
    })

    it('should check bash:admin for dangerous commands', async () => {
      bashModule.isDangerous.mockReturnValue({ dangerous: true, reason: 'Recursive delete' })

      const handler = createBashRPCHandler(bashModule, {
        auth: {
          required: true,
          verifyToken: vi.fn().mockResolvedValue({
            valid: true,
            payload: { sub: 'user-1', scope: 'bash:execute' }, // No admin scope
          }),
        },
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-without-admin',
        },
        body: JSON.stringify({
          type: 'request',
          id: 'call-1',
          path: ['bash', 'exec'],
          args: ['rm', ['-rf', '/']],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(false)
      expect(data.error.message).toContain('admin')
    })
  })
})

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('Error Handling', () => {
  let mockTransport: ReturnType<typeof createMockTransport>

  beforeEach(() => {
    mockTransport = createMockTransport()
  })

  describe('Command Timeout', () => {
    it('should timeout long-running commands', async () => {
      mockTransport.setAutoRespond(false)

      const client = new RPCBashBackend(mockTransport as any, {
        timeout: 100,
      })

      await expect(client.bash.exec('sleep', ['60'])).rejects.toThrow(/timeout/i)
    })

    it('should support per-command timeout override', async () => {
      mockTransport.setAutoRespond(false)

      const client = new RPCBashBackend(mockTransport as any, {
        timeout: 5000, // Default 5s
      })

      // This specific call should timeout after 100ms
      await expect(
        client.bash.exec('slow-command', [], { timeout: 100 })
      ).rejects.toThrow(/timeout/i)
    })

    it('should cancel command on client-side timeout', async () => {
      const client = new RPCBashBackend(mockTransport as any, {
        timeout: 100,
      })

      try {
        await client.bash.exec('long-command')
      } catch {
        // Expected timeout
      }

      // Should have sent a cancel message
      const cancelMessage = mockTransport.sentMessages.find(
        (m) => m.type === 'cancel' || (m as any).cancel === true
      )
      expect(cancelMessage).toBeDefined()
    })
  })

  describe('Connection Failure During Execution', () => {
    it('should reject pending calls on disconnect', async () => {
      mockTransport.setAutoRespond(false)

      const client = new RPCBashBackend(mockTransport as any)

      const execPromise = client.bash.exec('ls')

      // Simulate connection drop
      mockTransport.emit('disconnected', 'connection lost')

      await expect(execPromise).rejects.toThrow(/connection/i)
    })

    it('should provide meaningful error for connection failures', async () => {
      mockTransport.setAutoRespond(false)

      const client = new RPCBashBackend(mockTransport as any)

      const execPromise = client.bash.exec('ls')

      mockTransport.emit('error', new Error('WebSocket connection failed'))

      try {
        await execPromise
        expect.fail('Should have thrown')
      } catch (error: any) {
        expect(error.code).toBe(ErrorCodes.CONNECTION_FAILED)
        expect(error.message).toContain('connection')
      }
    })
  })

  describe('Permission Denied Errors', () => {
    it('should throw PermissionDenied for unauthorized commands', async () => {
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: false,
        error: {
          code: ErrorCodes.UNAUTHORIZED,
          message: 'Permission denied: bash:admin scope required',
        },
        timestamp: Date.now(),
      }))

      const client = new RPCBashBackend(mockTransport as any)

      try {
        await client.bash.exec('sudo', ['rm', '-rf', '/'])
        expect.fail('Should have thrown')
      } catch (error: any) {
        expect(error.code).toBe(ErrorCodes.UNAUTHORIZED)
        expect(error.message).toContain('bash:admin')
      }
    })

    it('should include required scope in error', async () => {
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: false,
        error: {
          code: ErrorCodes.UNAUTHORIZED,
          message: 'Missing scope',
          data: { requiredScope: 'bash:admin', currentScopes: ['bash:execute'] },
        },
        timestamp: Date.now(),
      }))

      const client = new RPCBashBackend(mockTransport as any)

      try {
        await client.bash.exec('dangerous-command')
      } catch (error: any) {
        expect(error.data.requiredScope).toBe('bash:admin')
        expect(error.data.currentScopes).toContain('bash:execute')
      }
    })
  })

  describe('Streaming Errors', () => {
    it('should handle errors during stream', async () => {
      const bashModule = createMockBashModule()
      const handler = createBashRPCHandler(bashModule, { enableStreaming: true })

      // Mock spawn to emit error during stream
      bashModule.spawn.mockImplementation(async () => {
        throw new Error('Process crashed')
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'stream-err',
          path: ['bash', 'stream'],
          args: ['crash-command'],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(false)
      expect(data.error.code).toBe(ErrorCodes.INTERNAL_ERROR)
    })

    it('should clean up stream on client disconnect', async () => {
      const bashModule = createMockBashModule()
      const spawnHandle = {
        pid: 1234,
        done: new Promise(() => {}), // Never resolves
        kill: vi.fn(),
        write: vi.fn(),
        closeStdin: vi.fn(),
      }
      bashModule.spawn.mockResolvedValue(spawnHandle)

      const handler = createBashRPCHandler(bashModule, { enableStreaming: true })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'stream-cleanup',
          path: ['bash', 'stream'],
          args: ['long-running'],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)

      // Simulate client disconnecting (abort the request)
      // The handler should kill the spawned process
      // This is simulated by checking kill was called on cleanup
    })
  })

  describe('Server-Side Error Handling', () => {
    it('should return INTERNAL_ERROR for unexpected exceptions', async () => {
      const bashModule = createMockBashModule()
      bashModule.exec.mockRejectedValue(new Error('Unexpected failure'))

      const handler = createBashRPCHandler(bashModule)

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'err-1',
          path: ['bash', 'exec'],
          args: ['ls'],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(false)
      expect(data.error.code).toBe(ErrorCodes.INTERNAL_ERROR)
    })

    it('should not leak stack traces in production', async () => {
      const bashModule = createMockBashModule()
      bashModule.exec.mockRejectedValue(new Error('Secret internal error'))

      const handler = createBashRPCHandler(bashModule, {
        debug: false, // Production mode
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'err-2',
          path: ['bash', 'exec'],
          args: ['ls'],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.error.stack).toBeUndefined()
      expect(data.error.message).not.toContain('Secret')
    })

    it('should include stack traces in debug mode', async () => {
      const bashModule = createMockBashModule()
      const error = new Error('Debug error')
      error.stack = 'Error: Debug error\n    at someFunction (file.ts:10:5)'
      bashModule.exec.mockRejectedValue(error)

      const handler = createBashRPCHandler(bashModule, {
        debug: true,
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'err-3',
          path: ['bash', 'exec'],
          args: ['ls'],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.error.stack).toContain('someFunction')
    })
  })
})

// ============================================================================
// Safety Integration Tests
// ============================================================================

describe('Safety Integration', () => {
  let mockTransport: ReturnType<typeof createMockTransport>
  let bashModule: ReturnType<typeof createMockBashModule>

  beforeEach(() => {
    mockTransport = createMockTransport()
    bashModule = createMockBashModule()
  })

  describe('Safety Checking Before RPC Execution', () => {
    it('should analyze command safety before execution', async () => {
      const handler = createBashRPCHandler(bashModule, {
        safety: {
          enabled: true,
          checkBeforeExec: true,
        },
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'safe-1',
          path: ['bash', 'exec'],
          args: ['ls', ['-la']],
          timestamp: Date.now(),
        }),
      })

      await handler.fetch(request)

      // Should have called isDangerous or analyze
      expect(bashModule.isDangerous).toHaveBeenCalled()
    })

    it('should block dangerous commands via RPC', async () => {
      bashModule.isDangerous.mockReturnValue({
        dangerous: true,
        reason: 'Recursive deletion of root filesystem',
      })

      const handler = createBashRPCHandler(bashModule, {
        safety: {
          enabled: true,
          blockDangerous: true,
        },
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'unsafe-1',
          path: ['bash', 'exec'],
          args: ['rm', ['-rf', '/']],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(false)
      expect(data.error.code).toBe('COMMAND_BLOCKED')
      expect(data.error.message).toContain('dangerous')
    })

    it('should allow dangerous commands with confirm flag', async () => {
      bashModule.isDangerous.mockReturnValue({
        dangerous: true,
        reason: 'Recursive delete',
      })

      const handler = createBashRPCHandler(bashModule, {
        safety: {
          enabled: true,
          blockDangerous: true,
        },
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'confirm-1',
          path: ['bash', 'exec'],
          args: ['rm', ['-rf', 'temp/'], { confirm: true }],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(true)
      expect(bashModule.exec).toHaveBeenCalledWith('rm', ['-rf', 'temp/'], { confirm: true })
    })
  })

  describe('Dangerous Command Rejection', () => {
    it('should reject rm -rf / without admin scope', async () => {
      bashModule.isDangerous.mockReturnValue({ dangerous: true, reason: 'Root delete' })

      const handler = createBashRPCHandler(bashModule, {
        safety: { enabled: true, blockDangerous: true },
        auth: {
          verifyToken: vi.fn().mockResolvedValue({
            valid: true,
            payload: { scope: 'bash:execute' },
          }),
        },
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token' },
        body: JSON.stringify({
          type: 'request',
          id: 'rm-1',
          path: ['bash', 'exec'],
          args: ['rm', ['-rf', '/']],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(false)
    })

    it('should reject sudo commands without admin scope', async () => {
      bashModule.isDangerous.mockReturnValue({ dangerous: true, reason: 'Elevated privileges' })

      const handler = createBashRPCHandler(bashModule, {
        safety: { enabled: true, blockDangerous: true },
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'sudo-1',
          path: ['bash', 'exec'],
          args: ['sudo', ['apt', 'install', 'malware']],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(false)
      expect(data.error.code).toBe('COMMAND_BLOCKED')
    })

    it('should reject chmod 777 / commands', async () => {
      bashModule.isDangerous.mockReturnValue({ dangerous: true, reason: 'Permission change on root' })

      const handler = createBashRPCHandler(bashModule, {
        safety: { enabled: true, blockDangerous: true },
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'chmod-1',
          path: ['bash', 'exec'],
          args: ['chmod', ['777', '/']],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(false)
    })
  })

  describe('Command Classification via RPC', () => {
    it('should classify read-only commands', async () => {
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: {
          classification: { type: 'read', impact: 'none', reversible: true, reason: 'List directory' },
          intent: { commands: ['ls'], reads: ['.'], writes: [], deletes: [], network: false, elevated: false },
        },
        timestamp: Date.now(),
      }))

      const client = new RPCBashBackend(mockTransport as any)
      const analysis = await client.bash.analyze('ls -la')

      expect(analysis.classification.type).toBe('read')
      expect(analysis.classification.impact).toBe('none')
    })

    it('should classify write commands', async () => {
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: {
          classification: { type: 'write', impact: 'medium', reversible: true, reason: 'Copy files' },
          intent: { commands: ['cp'], reads: ['src'], writes: ['dest'], deletes: [], network: false, elevated: false },
        },
        timestamp: Date.now(),
      }))

      const client = new RPCBashBackend(mockTransport as any)
      const analysis = await client.bash.analyze('cp -r src/ dest/')

      expect(analysis.classification.type).toBe('write')
      expect(analysis.intent.writes).toContain('dest')
    })

    it('should classify delete commands', async () => {
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: {
          classification: { type: 'delete', impact: 'high', reversible: false, reason: 'Delete files' },
          intent: { commands: ['rm'], reads: [], writes: [], deletes: ['/tmp/data'], network: false, elevated: false },
        },
        timestamp: Date.now(),
      }))

      const client = new RPCBashBackend(mockTransport as any)
      const analysis = await client.bash.analyze('rm -rf /tmp/data')

      expect(analysis.classification.type).toBe('delete')
      expect(analysis.classification.impact).toBe('high')
      expect(analysis.intent.deletes).toContain('/tmp/data')
    })

    it('should classify network commands', async () => {
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: {
          classification: { type: 'network', impact: 'medium', reversible: true, reason: 'HTTP request' },
          intent: { commands: ['curl'], reads: [], writes: [], deletes: [], network: true, elevated: false },
        },
        timestamp: Date.now(),
      }))

      const client = new RPCBashBackend(mockTransport as any)
      const analysis = await client.bash.analyze('curl https://api.example.com')

      expect(analysis.classification.type).toBe('network')
      expect(analysis.intent.network).toBe(true)
    })

    it('should classify elevated commands', async () => {
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: {
          classification: { type: 'admin', impact: 'critical', reversible: false, reason: 'Elevated privileges' },
          intent: { commands: ['sudo', 'apt'], reads: [], writes: [], deletes: [], network: true, elevated: true },
        },
        timestamp: Date.now(),
      }))

      const client = new RPCBashBackend(mockTransport as any)
      const analysis = await client.bash.analyze('sudo apt update')

      expect(analysis.classification.type).toBe('admin')
      expect(analysis.intent.elevated).toBe(true)
    })
  })

  describe('Path Traversal Protection', () => {
    it('should reject path traversal attempts', async () => {
      const handler = createBashRPCHandler(bashModule, {
        safety: {
          enabled: true,
          blockPathTraversal: true,
        },
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'traversal-1',
          path: ['bash', 'exec'],
          args: ['cat', ['../../etc/passwd']],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(false)
      expect(data.error.message).toContain('path traversal')
    })

    it('should reject command injection attempts', async () => {
      const handler = createBashRPCHandler(bashModule, {
        safety: {
          enabled: true,
          blockInjection: true,
        },
      })

      const request = new Request('https://bash.example.com/rpc', {
        method: 'POST',
        body: JSON.stringify({
          type: 'request',
          id: 'inject-1',
          path: ['bash', 'exec'],
          args: ['echo', ['hello; rm -rf /']],
          timestamp: Date.now(),
        }),
      })

      const response = await handler.fetch(request)
      const data = await response.json()

      expect(data.success).toBe(false)
      expect(data.error.message).toContain('injection')
    })
  })
})

// ============================================================================
// Type Safety Tests
// ============================================================================

describe('Type Safety', () => {
  describe('Client Type Inference', () => {
    it('should infer correct return types for bash.exec', async () => {
      const mockTransport = createMockTransport()
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: {
          input: 'ls',
          command: 'ls',
          valid: true,
          generated: false,
          stdout: 'output',
          stderr: '',
          exitCode: 0,
          intent: { commands: ['ls'], reads: [], writes: [], deletes: [], network: false, elevated: false },
          classification: { type: 'read', impact: 'none', reversible: true, reason: 'List' },
        } satisfies BashResult,
        timestamp: Date.now(),
      }))

      const client = new RPCBashBackend(mockTransport as any)

      // TypeScript should infer result as BashResult
      const result = await client.bash.exec('ls')

      // These should compile without type errors
      const stdout: string = result.stdout
      const exitCode: number = result.exitCode
      const classification = result.classification

      expect(typeof stdout).toBe('string')
      expect(typeof exitCode).toBe('number')
      expect(classification).toBeDefined()
    })

    it('should infer correct types for analyze', async () => {
      const mockTransport = createMockTransport()
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: {
          classification: { type: 'read', impact: 'none', reversible: true, reason: 'Safe' },
          intent: { commands: ['ls'], reads: [], writes: [], deletes: [], network: false, elevated: false },
        },
        timestamp: Date.now(),
      }))

      const client = new RPCBashBackend(mockTransport as any)

      const analysis = await client.bash.analyze('ls')

      // Type checks
      const type: string = analysis.classification.type
      const commands: string[] = analysis.intent.commands

      expect(type).toBeDefined()
      expect(Array.isArray(commands)).toBe(true)
    })

    it('should infer correct types for isDangerous', async () => {
      const mockTransport = createMockTransport()
      mockTransport.setCustomResponder((request) => ({
        type: 'response',
        id: request.id,
        success: true,
        result: { dangerous: true, reason: 'Test reason' },
        timestamp: Date.now(),
      }))

      const client = new RPCBashBackend(mockTransport as any)

      const check = await client.bash.isDangerous('rm -rf /')

      // Type checks
      const dangerous: boolean = check.dangerous
      const reason: string | undefined = check.reason

      expect(typeof dangerous).toBe('boolean')
    })
  })
})

// ============================================================================
// Integration with Existing BashModule Tests
// ============================================================================

describe('Integration with BashModule', () => {
  it('should wrap existing BashModule for RPC exposure', () => {
    const bashModule = createMockBashModule()
    const rpcModule = exposeBashModule(bashModule)

    // All BashModule methods should be exposed
    expect(rpcModule.exec).toBeDefined()
    expect(rpcModule.run).toBeDefined()
    expect(rpcModule.spawn).toBeDefined()
    expect(rpcModule.analyze).toBeDefined()
    expect(rpcModule.isDangerous).toBeDefined()
    expect(rpcModule.parse).toBeDefined()
  })

  it('should maintain method signatures through RPC', async () => {
    const bashModule = createMockBashModule()
    const handler = createBashRPCHandler(bashModule)

    // exec(command, args?, options?)
    const execRequest = new Request('https://bash.example.com/rpc', {
      method: 'POST',
      body: JSON.stringify({
        type: 'request',
        id: '1',
        path: ['bash', 'exec'],
        args: ['git', ['status'], { cwd: '/repo' }],
        timestamp: Date.now(),
      }),
    })

    await handler.fetch(execRequest)

    expect(bashModule.exec).toHaveBeenCalledWith('git', ['status'], { cwd: '/repo' })
  })

  it('should support BashModule with FsCapability via RPC', async () => {
    const bashModule = createMockBashModule()
    // Simulate FsCapability being available
    ;(bashModule as any).hasFsCapability = true

    const handler = createBashRPCHandler(bashModule)

    // Native cat should still work through RPC
    const request = new Request('https://bash.example.com/rpc', {
      method: 'POST',
      body: JSON.stringify({
        type: 'request',
        id: '1',
        path: ['bash', 'exec'],
        args: ['cat', ['file.txt']],
        timestamp: Date.now(),
      }),
    })

    await handler.fetch(request)

    expect(bashModule.exec).toHaveBeenCalledWith('cat', ['file.txt'])
  })
})
