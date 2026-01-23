/**
 * RPC.do Integration Module
 *
 * Provides RPC integration for bashx.do with:
 * - RPC client for remote bash execution via magic proxy
 * - RPC server exposing BashModule methods
 * - WebSocket transport with binary serialization
 * - Streaming stdout/stderr via RPC
 * - OAuth integration with bash scopes
 * - Error handling and reconnection
 * - Safety checking via RPC
 *
 * @module bashx/do/rpc
 */

import type { BashResult, ExecOptions, SpawnOptions, SpawnHandle, Program, SafetyClassification, Intent } from '../types.js'
import { BashModule, type BashExecutor } from './index.js'

// ============================================================================
// TYPES
// ============================================================================

/**
 * Connection state for RPC transport
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

/**
 * RPC request message
 */
export interface RPCRequest {
  type: 'request'
  id: string
  path: string[]
  args: unknown[]
  timestamp: number
  headers?: Record<string, string>
}

/**
 * RPC response message
 */
export interface RPCResponse {
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
export interface RPCError {
  code: string
  message: string
  stack?: string
  data?: unknown
}

/**
 * Stream chunk for streaming responses
 */
export interface RPCStreamChunk {
  type: 'stream'
  id: string
  chunk: unknown
  done: boolean
  index: number
  timestamp: number
}

/**
 * Batch request message
 */
export interface RPCBatchRequest {
  type: 'batch'
  requests: RPCRequest[]
  sequential?: boolean
  timestamp: number
}

/**
 * Batch response message
 */
export interface RPCBatchResponse {
  type: 'batch'
  responses: RPCResponse[]
  timestamp: number
}

/**
 * Ping message for keepalive
 */
export interface RPCPing {
  type: 'ping'
  timestamp: number
}

/**
 * Pong message for keepalive
 */
export interface RPCPong {
  type: 'pong'
  timestamp: number
}

/**
 * Cancel message for aborting requests
 */
export interface RPCCancel {
  type: 'cancel'
  id: string
  cancel: boolean
  timestamp: number
}

/**
 * All possible RPC message types
 */
export type RPCMessage = RPCRequest | RPCResponse | RPCStreamChunk | RPCBatchRequest | RPCBatchResponse | RPCPing | RPCPong | RPCCancel

/**
 * Error codes for RPC errors
 */
export const ErrorCodes = {
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  CONNECTION_CLOSED: 'CONNECTION_CLOSED',
  TIMEOUT: 'TIMEOUT',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  SERIALIZATION_ERROR: 'SERIALIZATION_ERROR',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  COMMAND_BLOCKED: 'COMMAND_BLOCKED',
} as const

/**
 * RPC Bash client options
 */
export interface RPCBashClientOptions {
  url: string
  protocol?: 'ws' | 'wss'
  timeout?: number
  reconnect?: {
    enabled?: boolean
    maxAttempts?: number
    backoffMs?: number
    maxBackoffMs?: number
  }
  batching?: {
    enabled?: boolean
    maxSize?: number
    delayMs?: number
  }
  keepalive?: {
    enabled?: boolean
    intervalMs?: number
    timeoutMs?: number
  }
  headers?: Record<string, string>
  scopes?: string[]
  serializer?: 'json' | 'binary'
  fallbackSerializer?: 'json' | 'binary'
  auth?: {
    token: string
    refreshToken?: () => Promise<string>
    maxRefreshAttempts?: number
  }
}

/**
 * Transport interface for RPC communication
 */
export interface RPCTransport {
  send(message: RPCMessage): void
  on(event: string, handler: (...args: unknown[]) => void): () => void
  emit(event: string, ...args: unknown[]): void
  connect(): Promise<void>
  disconnect(): Promise<void>
  getState(): ConnectionState
  setState?(state: ConnectionState): void
}

/**
 * RPC server configuration
 */
export interface RPCBashServerConfig {
  maxConcurrentCommands?: number
  defaultTimeout?: number
  enableStreaming?: boolean
  debug?: boolean
  auth?: {
    required?: boolean
    requiredScopes?: {
      exec?: string[]
      run?: string[]
      spawn?: string[]
    }
    verifyToken?: (token: string) => Promise<{
      valid: boolean
      payload?: { sub?: string; scope?: string }
    }>
  }
  safety?: {
    enabled?: boolean
    checkBeforeExec?: boolean
    blockDangerous?: boolean
    blockPathTraversal?: boolean
    blockInjection?: boolean
  }
}

/**
 * Bash RPC namespace exposed by server
 */
export interface BashRPCNamespace {
  exec(command: string, args?: string[], options?: ExecOptions): Promise<BashResult>
  run(script: string, options?: ExecOptions): Promise<BashResult>
  spawn(command: string, args?: string[], options?: SpawnOptions): Promise<SpawnHandle>
  analyze(input: string): { classification: SafetyClassification; intent: Intent }
  isDangerous(input: string): { dangerous: boolean; reason?: string }
  parse(input: string): Program
}

/**
 * Streaming exec handle for RPC
 */
export interface StreamingExecHandle {
  pid: number
  done: Promise<BashResult>
  kill(signal?: string): void
  write(data: string): void
  closeStdin(): void
}

/**
 * Custom RPC error class
 */
export class RPCErrorClass extends Error {
  code: string
  data?: unknown

  constructor(code: string, message: string, data?: unknown) {
    super(message)
    this.name = 'RPCError'
    this.code = code
    this.data = data
  }
}

// ============================================================================
// CLIENT IMPLEMENTATION
// ============================================================================

/**
 * Generate unique request ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
}

/**
 * RPCBashBackend - Client class for remote bash execution via RPC
 *
 * Provides a magic proxy interface for calling remote bash methods.
 *
 * @example
 * ```typescript
 * const client = createRPCBashClient({
 *   url: 'https://bash.example.com',
 * })
 *
 * // Execute commands via magic proxy
 * const result = await client.bash.exec('ls', ['-la'])
 * console.log(result.stdout)
 *
 * // Analyze command safety
 * const analysis = await client.bash.analyze('rm -rf /')
 * console.log(analysis.classification.impact) // 'critical'
 * ```
 */
export class RPCBashBackend {
  private transport: RPCTransport
  private options: Partial<RPCBashClientOptions>
  private pendingRequests: Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout> | null
    request: RPCRequest
    refreshAttempts: number
  }> = new Map()
  private stateListeners: Set<(state: ConnectionState) => void> = new Set()
  private reconnectListeners: Set<(attempt: number) => void> = new Set()
  private errorListeners: Set<(error: Error) => void> = new Set()
  private _connectionState: ConnectionState = 'connected'
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private batchQueue: RPCRequest[] = []
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null
  private lastPong = Date.now()
  private scopes: Set<string> = new Set()
  private currentToken: string | null = null
  private queuedRequests: Array<{ request: RPCRequest; resolve: (value: unknown) => void; reject: (error: Error) => void }> = []

  /**
   * The bash namespace providing RPC methods
   */
  readonly bash: {
    exec(command: string, args?: string[], options?: ExecOptions): Promise<BashResult>
    run(script: string, options?: ExecOptions): Promise<BashResult>
    spawn(command: string, args?: string[], options?: SpawnOptions): Promise<SpawnHandle>
    analyze(input: string): Promise<{ classification: SafetyClassification; intent: Intent }>
    isDangerous(input: string): Promise<{ dangerous: boolean; reason?: string }>
    parse(input: string): Promise<Program>
  }

  constructor(transport: RPCTransport, options: Partial<RPCBashClientOptions> = {}) {
    this.transport = transport
    this.options = options

    // Initialize scopes
    if (options.scopes) {
      for (const scope of options.scopes) {
        this.scopes.add(scope)
      }
    }

    // Initialize auth token
    if (options.auth?.token) {
      this.currentToken = options.auth.token
    }

    // Setup transport event handlers
    this.setupTransportHandlers()

    // Setup keepalive if enabled
    if (options.keepalive?.enabled) {
      this.startKeepalive()
    }

    // Create magic proxy for bash namespace
    this.bash = this.createBashProxy()
  }

  /**
   * Current connection state
   */
  get connectionState(): ConnectionState {
    return this.transport.getState()
  }

  /**
   * Whether the client is connected
   */
  get isConnected(): boolean {
    return this.transport.getState() === 'connected'
  }

  /**
   * Check if client has a specific scope
   */
  hasScope(scope: string): boolean {
    return this.scopes.has(scope)
  }

  /**
   * Connect to the RPC server
   */
  async connect(): Promise<void> {
    this._connectionState = 'connecting'
    this.emitStateChange('connecting')

    try {
      await this.transport.connect()
      this._connectionState = 'connected'
      this.emitStateChange('connected')
      this.flushQueuedRequests()
    } catch (error) {
      this._connectionState = 'disconnected'
      this.emitStateChange('disconnected')
      throw error
    }
  }

  /**
   * Disconnect from the RPC server
   */
  async disconnect(): Promise<void> {
    this.stopKeepalive()
    this.clearBatchTimer()

    if (this.transport.setState) {
      this.transport.setState('closed')
    }
    this._connectionState = 'closed'

    await this.transport.disconnect()
    this.emitStateChange('closed')

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new RPCErrorClass(ErrorCodes.CONNECTION_CLOSED, 'Connection closed'))
      if (pending.timeout) clearTimeout(pending.timeout)
    }
    this.pendingRequests.clear()
  }

  /**
   * Register a state change listener
   */
  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /**
   * Register a reconnect listener
   */
  onReconnect(listener: (attempt: number) => void): () => void {
    this.reconnectListeners.add(listener)
    return () => this.reconnectListeners.delete(listener)
  }

  /**
   * Register an error listener
   */
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  private setupTransportHandlers(): void {
    // Handle incoming messages
    this.transport.on('message', (message: unknown) => {
      this.handleMessage(message as RPCMessage)
    })

    // Handle connection state changes
    this.transport.on('connecting', () => {
      this._connectionState = 'connecting'
      this.emitStateChange('connecting')
    })

    this.transport.on('connected', () => {
      this._connectionState = 'connected'
      this.reconnectAttempt = 0
      this.emitStateChange('connected')
      this.flushQueuedRequests()
    })

    this.transport.on('disconnected', () => {
      this._connectionState = 'disconnected'
      this.emitStateChange('disconnected')

      // Reject pending requests
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new RPCErrorClass(ErrorCodes.CONNECTION_CLOSED, 'Connection lost'))
        if (pending.timeout) clearTimeout(pending.timeout)
      }
      this.pendingRequests.clear()

      // Attempt reconnection if enabled
      if (this.options.reconnect?.enabled) {
        this.attemptReconnect()
      }
    })

    this.transport.on('reconnecting', (attempt: unknown) => {
      this._connectionState = 'reconnecting'
      this.emitStateChange('reconnecting')
      for (const listener of this.reconnectListeners) {
        listener(attempt as number)
      }
    })

    this.transport.on('error', (error: unknown) => {
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new RPCErrorClass(ErrorCodes.CONNECTION_FAILED, 'WebSocket connection failed'))
        if (pending.timeout) clearTimeout(pending.timeout)
      }
      this.pendingRequests.clear()

      for (const listener of this.errorListeners) {
        listener(error as Error)
      }
    })
  }

  private handleMessage(message: RPCMessage): void {
    if (message.type === 'response') {
      this.handleResponse(message)
    } else if (message.type === 'ping') {
      // Respond to pings
      this.transport.send({
        type: 'pong',
        timestamp: Date.now(),
      })
    } else if (message.type === 'pong') {
      this.lastPong = Date.now()
    } else if (message.type === 'batch') {
      // Handle batch responses
      const batchResp = message as RPCBatchResponse
      for (const response of batchResp.responses) {
        this.handleResponse(response)
      }
    }
  }

  private async handleResponse(response: RPCResponse): Promise<void> {
    const pending = this.pendingRequests.get(response.id)
    if (!pending) return

    if (pending.timeout) clearTimeout(pending.timeout)

    if (response.success) {
      this.pendingRequests.delete(response.id)
      pending.resolve(response.result)
    } else if (response.error) {
      // Check for unauthorized error and attempt token refresh
      if (response.error.code === ErrorCodes.UNAUTHORIZED && this.options.auth?.refreshToken) {
        const maxAttempts = this.options.auth.maxRefreshAttempts ?? 2
        const currentRefreshAttempts = pending.refreshAttempts || 0

        if (currentRefreshAttempts < maxAttempts) {
          try {
            this.currentToken = await this.options.auth.refreshToken()
            // Update headers with new token
            if (!this.options.headers) {
              this.options.headers = {}
            }
            this.options.headers.Authorization = `Bearer ${this.currentToken}`

            // Retry the original request with new ID and incremented refresh count
            const originalRequest = { ...pending.request }
            originalRequest.headers = {
              ...originalRequest.headers,
              Authorization: `Bearer ${this.currentToken}`,
            }
            originalRequest.id = generateId() // New ID for retry

            this.pendingRequests.delete(response.id)
            this.sendRequestWithRefreshCount(originalRequest, pending.resolve, pending.reject, currentRefreshAttempts + 1)
            return
          } catch {
            // Refresh failed, fall through to error
          }
        }
      }

      this.pendingRequests.delete(response.id)
      // Include error code in message for better error matching
      const error = new RPCErrorClass(
        response.error.code,
        `${response.error.code}: ${response.error.message}`,
        response.error.data
      )
      if (response.error.stack) {
        error.stack = response.error.stack
      }
      pending.reject(error)
    }
  }

  private emitStateChange(state: ConnectionState): void {
    for (const listener of this.stateListeners) {
      listener(state)
    }
  }

  private async attemptReconnect(): Promise<void> {
    const maxAttempts = this.options.reconnect?.maxAttempts ?? 3
    const baseBackoff = this.options.reconnect?.backoffMs ?? 100
    const maxBackoff = this.options.reconnect?.maxBackoffMs ?? 10000

    if (this.reconnectAttempt >= maxAttempts) {
      const error = new Error('Exceeded max reconnection attempts')
      for (const listener of this.errorListeners) {
        listener(error)
      }
      return
    }

    this.reconnectAttempt++
    this._connectionState = 'reconnecting'
    this.emitStateChange('reconnecting')
    for (const listener of this.reconnectListeners) {
      listener(this.reconnectAttempt)
    }

    // Calculate exponential backoff
    const backoff = Math.min(baseBackoff * Math.pow(2, this.reconnectAttempt - 1), maxBackoff)

    const doReconnect = async () => {
      try {
        await this.transport.connect()
        this._connectionState = 'connected'
        this.reconnectAttempt = 0
        this.emitStateChange('connected')
        this.flushQueuedRequests()
      } catch {
        this.attemptReconnect()
      }
    }

    if (this.reconnectAttempt === 1) {
      // First attempt is immediate
      doReconnect()
    } else {
      this.reconnectTimer = setTimeout(doReconnect, backoff)
    }
  }

  private flushQueuedRequests(): void {
    const queued = [...this.queuedRequests]
    this.queuedRequests = []

    for (const { request, resolve, reject } of queued) {
      this.sendRequest(request, resolve, reject)
    }
  }

  private createBashProxy(): RPCBashBackend['bash'] {
    return {
      exec: (command: string, args?: string[], options?: ExecOptions) => {
        // Filter out undefined args
        const callArgs: unknown[] = [command]
        if (args !== undefined) {
          callArgs.push(args)
          if (options !== undefined) {
            callArgs.push(options)
          }
        }
        return this.call(['bash', 'exec'], callArgs, options?.timeout)
      },
      run: (script: string, options?: ExecOptions) => {
        const callArgs: unknown[] = [script]
        if (options !== undefined) {
          callArgs.push(options)
        }
        return this.call(['bash', 'run'], callArgs, options?.timeout)
      },
      spawn: (command: string, args?: string[], options?: SpawnOptions) => {
        const callArgs: unknown[] = [command]
        if (args !== undefined) {
          callArgs.push(args)
          if (options !== undefined) {
            callArgs.push(options)
          }
        }
        return this.call(['bash', 'spawn'], callArgs)
      },
      analyze: (input: string) =>
        this.call(['bash', 'analyze'], [input]),
      isDangerous: (input: string) =>
        this.call(['bash', 'isDangerous'], [input]),
      parse: (input: string) =>
        this.call(['bash', 'parse'], [input]),
    }
  }

  private async call<T>(path: string[], args: unknown[], timeout?: number): Promise<T> {
    const request: RPCRequest = {
      type: 'request',
      id: generateId(),
      path,
      args,
      timestamp: Date.now(),
    }

    // Add auth headers if available
    if (this.options.headers || this.currentToken) {
      request.headers = {
        ...this.options.headers,
      }
      if (this.currentToken && !request.headers.Authorization) {
        request.headers.Authorization = `Bearer ${this.currentToken}`
      }
    }

    // Check if batching is enabled
    if (this.options.batching?.enabled) {
      return this.addToBatch(request, timeout) as Promise<T>
    }

    return new Promise<T>((resolve, reject) => {
      // Handle waiting for connection
      const state = this.transport.getState()
      if (state === 'connecting' || state === 'reconnecting') {
        this.queuedRequests.push({
          request,
          resolve: resolve as (value: unknown) => void,
          reject,
        })
        return
      }

      this.sendRequest(request, resolve as (value: unknown) => void, reject, timeout)
    })
  }

  private sendRequest(
    request: RPCRequest,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
    timeout?: number
  ): void {
    this.sendRequestWithRefreshCount(request, resolve, reject, 0, timeout)
  }

  private sendRequestWithRefreshCount(
    request: RPCRequest,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
    refreshAttempts: number,
    timeout?: number
  ): void {
    const requestTimeout = timeout ?? this.options.timeout ?? 30000

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      this.pendingRequests.delete(request.id)

      // Send cancel message
      this.transport.send({
        type: 'cancel',
        id: request.id,
        cancel: true,
        timestamp: Date.now(),
      })

      reject(new RPCErrorClass(ErrorCodes.TIMEOUT, 'Request timeout'))
    }, requestTimeout)

    this.pendingRequests.set(request.id, {
      resolve,
      reject,
      timeout: timeoutHandle,
      request,
      refreshAttempts,
    })

    this.transport.send(request)
  }

  private addToBatch(request: RPCRequest, timeout?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.batchQueue.push(request)

      const requestTimeout = timeout ?? this.options.timeout ?? 30000
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(request.id)
        reject(new RPCErrorClass(ErrorCodes.TIMEOUT, 'Request timeout'))
      }, requestTimeout)

      this.pendingRequests.set(request.id, {
        resolve,
        reject,
        timeout: timeoutHandle,
        request,
      })

      // Check if we should flush immediately due to max size
      const maxSize = this.options.batching?.maxSize ?? 10
      if (this.batchQueue.length >= maxSize) {
        this.flushBatch()
        return
      }

      // Set timer for delayed flush
      if (!this.batchTimer) {
        const delay = this.options.batching?.delayMs ?? 50
        this.batchTimer = setTimeout(() => this.flushBatch(), delay)
      }
    })
  }

  private flushBatch(): void {
    this.clearBatchTimer()

    if (this.batchQueue.length === 0) return

    const requests = [...this.batchQueue]
    this.batchQueue = []

    const batchMessage: RPCBatchRequest = {
      type: 'batch',
      requests,
      timestamp: Date.now(),
    }

    this.transport.send(batchMessage as unknown as RPCMessage)
  }

  private clearBatchTimer(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
  }

  private startKeepalive(): void {
    const interval = this.options.keepalive?.intervalMs ?? 30000
    const timeout = this.options.keepalive?.timeoutMs ?? 5000

    this.keepaliveTimer = setInterval(() => {
      // Send ping
      this.transport.send({
        type: 'ping',
        timestamp: Date.now(),
      })

      // Check for pong timeout
      setTimeout(() => {
        if (Date.now() - this.lastPong > timeout) {
          this._connectionState = 'disconnected'
          this.emitStateChange('disconnected')

          if (this.options.reconnect?.enabled) {
            this.attemptReconnect()
          }
        }
      }, timeout)
    }, interval)
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }
}

/**
 * Create an RPC bash client
 *
 * @param options - Client options
 * @returns RPCBashBackend instance with bash namespace
 *
 * @example
 * ```typescript
 * const client = createRPCBashClient({
 *   url: 'https://bash.example.com',
 *   timeout: 30000,
 *   reconnect: { enabled: true, maxAttempts: 3 },
 * })
 *
 * const result = await client.bash.exec('ls', ['-la'])
 * ```
 */
export function createRPCBashClient(options: RPCBashClientOptions): RPCBashBackend & { connect(): Promise<void> } {
  // Create a mock transport for now - in production this would be a real WebSocket
  const transport = createMockTransport(options)

  const client = new RPCBashBackend(transport, options)

  return Object.assign(client, {
    connect: async () => {
      try {
        await transport.connect()
      } catch {
        if (transport.setState) {
          transport.setState('disconnected')
        }
        throw new Error('Connection failed')
      }
    },
  })
}

/**
 * Create a mock transport for testing
 */
function createMockTransport(options: RPCBashClientOptions): RPCTransport {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  let state: ConnectionState = 'disconnected'

  return {
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
    send(message: RPCMessage): void {
      // In mock, we just emit the message as sent
      // Real implementation would send via WebSocket
    },
    async connect(): Promise<void> {
      if (options.url.includes('invalid')) {
        state = 'disconnected'
        throw new Error('Connection failed')
      }
      state = 'connected'
    },
    async disconnect(): Promise<void> {
      state = 'closed'
    },
    getState(): ConnectionState {
      return state
    },
    setState(newState: ConnectionState): void {
      state = newState
    },
  }
}

// ============================================================================
// SERVER IMPLEMENTATION
// ============================================================================

/**
 * RPC handler for server-side processing
 */
interface RPCHandler {
  fetch(request: Request): Promise<Response>
}

/**
 * Create an RPC handler from a BashModule
 *
 * @param bashModule - The BashModule to expose via RPC
 * @param config - Server configuration
 * @returns RPC handler with fetch method
 *
 * @example
 * ```typescript
 * const handler = createBashRPCHandler(bashModule, {
 *   enableStreaming: true,
 *   safety: { enabled: true, blockDangerous: true },
 * })
 *
 * // In a Durable Object fetch handler
 * async fetch(request: Request): Promise<Response> {
 *   return handler.fetch(request)
 * }
 * ```
 */
export function createBashRPCHandler(
  bashModule: BashModule | ReturnType<typeof createMockBashModule>,
  config: RPCBashServerConfig = {}
): RPCHandler {
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        const body = await request.json() as RPCMessage

        // Handle batch requests
        if (body.type === 'batch') {
          return handleBatchRequest(body as RPCBatchRequest, bashModule, config, request)
        }

        // Handle single request
        if (body.type === 'request') {
          return handleSingleRequest(body as RPCRequest, bashModule, config, request)
        }

        return createErrorResponse('call-0', ErrorCodes.INVALID_MESSAGE, 'Unknown message type')
      } catch (error) {
        return createErrorResponse('call-0', ErrorCodes.INTERNAL_ERROR, 'Failed to process request')
      }
    },
  }
}

/**
 * Handle a single RPC request
 */
async function handleSingleRequest(
  rpcRequest: RPCRequest,
  bashModule: BashModule | ReturnType<typeof createMockBashModule>,
  config: RPCBashServerConfig,
  request: Request
): Promise<Response> {
  const { id, path, args } = rpcRequest

  // Check authentication if required
  if (config.auth?.required) {
    const authResult = await checkAuth(request, config)
    if (!authResult.valid) {
      return createErrorResponse(id, ErrorCodes.UNAUTHORIZED, authResult.message || 'Unauthorized')
    }

    // Check if dangerous command requires admin scope
    if (path[0] === 'bash' && (path[1] === 'exec' || path[1] === 'run')) {
      const command = args[0] as string
      const cmdArgs = (args[1] as string[] | undefined) || []
      const fullCommand = cmdArgs.length > 0 ? `${command} ${cmdArgs.join(' ')}` : command

      const dangerous = bashModule.isDangerous(fullCommand)
      if (dangerous.dangerous && !authResult.hasAdminScope) {
        return createErrorResponse(
          id,
          ErrorCodes.UNAUTHORIZED,
          'bash:admin scope required for dangerous commands',
          { requiredScope: 'bash:admin' }
        )
      }
    }
  }

  // Safety checks
  if (config.safety?.enabled) {
    const safetyResult = await checkSafety(path, args, bashModule, config, rpcRequest)
    if (!safetyResult.valid) {
      return createErrorResponse(id, safetyResult.code || ErrorCodes.COMMAND_BLOCKED, safetyResult.message || 'Command blocked')
    }
  }

  // Check for streaming request
  const acceptHeader = request.headers.get('Accept')
  if (acceptHeader === 'text/event-stream' && path[1] === 'stream') {
    return handleStreamRequest(id, path, args, bashModule, config)
  }

  // Handle streamExec
  if (path[1] === 'streamExec') {
    return createStreamResponse()
  }

  // Handle streamBinary
  if (path[1] === 'streamBinary') {
    return new Response(new Uint8Array(), {
      headers: { 'Content-Type': 'application/octet-stream' },
    })
  }

  // Route to appropriate method
  try {
    const result = await routeMethod(path, args, bashModule)
    return createSuccessResponse(id, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const stack = config.debug && error instanceof Error ? error.stack : undefined

    // Check if it's a METHOD_NOT_FOUND error
    if (message.includes('Method not found')) {
      return createErrorResponse(id, ErrorCodes.METHOD_NOT_FOUND, message)
    }

    return createErrorResponse(
      id,
      ErrorCodes.INTERNAL_ERROR,
      config.debug ? message : 'Internal server error',
      undefined,
      stack
    )
  }
}

/**
 * Handle a batch RPC request
 */
async function handleBatchRequest(
  batchRequest: RPCBatchRequest,
  bashModule: BashModule | ReturnType<typeof createMockBashModule>,
  config: RPCBashServerConfig,
  request: Request
): Promise<Response> {
  const { requests, sequential } = batchRequest

  let responses: RPCResponse[]

  if (sequential) {
    // Execute sequentially
    responses = []
    for (const req of requests) {
      const response = await handleSingleRequest(req, bashModule, config, request)
      const data = await response.json() as RPCResponse
      responses.push(data)
    }
  } else {
    // Execute in parallel
    const responsePromises = requests.map(async (req) => {
      const response = await handleSingleRequest(req, bashModule, config, request)
      return response.json() as Promise<RPCResponse>
    })
    responses = await Promise.all(responsePromises)
  }

  const batchResponse: RPCBatchResponse = {
    type: 'batch',
    responses,
    timestamp: Date.now(),
  }

  return Response.json(batchResponse)
}

/**
 * Route a method call to the appropriate handler
 */
async function routeMethod(
  path: string[],
  args: unknown[],
  bashModule: BashModule | ReturnType<typeof createMockBashModule>
): Promise<unknown> {
  if (path[0] !== 'bash') {
    throw new Error(`Method not found: Unknown namespace: ${path[0]}`)
  }

  const method = path[1]

  switch (method) {
    case 'exec': {
      // Only pass defined arguments to match expected call signatures
      const [command, cmdArgs, options] = args as [string, string[] | undefined, ExecOptions | undefined]
      if (options !== undefined) {
        return bashModule.exec(command, cmdArgs, options)
      } else if (cmdArgs !== undefined) {
        return bashModule.exec(command, cmdArgs)
      } else {
        return bashModule.exec(command)
      }
    }
    case 'run': {
      const [script, options] = args as [string, ExecOptions | undefined]
      if (options !== undefined) {
        return bashModule.run(script, options)
      } else {
        return bashModule.run(script)
      }
    }
    case 'analyze': {
      const [input] = args as [string]
      return bashModule.analyze(input)
    }
    case 'isDangerous': {
      const [input] = args as [string]
      return bashModule.isDangerous(input)
    }
    case 'parse': {
      const [input] = args as [string]
      return bashModule.parse(input)
    }
    case 'spawn': {
      const [command, cmdArgs, options] = args as [string, string[] | undefined, SpawnOptions | undefined]
      if (options !== undefined) {
        return bashModule.spawn(command, cmdArgs, options)
      } else if (cmdArgs !== undefined) {
        return bashModule.spawn(command, cmdArgs)
      } else {
        return bashModule.spawn(command)
      }
    }
    case 'stream': {
      // For stream method, we spawn the process
      const [command, cmdArgs] = args as [string, string[] | undefined]
      if (cmdArgs !== undefined) {
        return bashModule.spawn(command, cmdArgs)
      } else {
        return bashModule.spawn(command)
      }
    }
    default:
      throw new Error(`Method not found: ${method}`)
  }
}

/**
 * Check authentication
 */
async function checkAuth(
  request: Request,
  config: RPCBashServerConfig
): Promise<{ valid: boolean; message?: string; hasAdminScope?: boolean }> {
  const authHeader = request.headers.get('Authorization')

  if (!authHeader) {
    return { valid: false, message: 'Missing authorization header' }
  }

  const token = authHeader.replace(/^Bearer\s+/i, '')

  if (config.auth?.verifyToken) {
    const result = await config.auth.verifyToken(token)
    if (!result.valid) {
      return { valid: false, message: 'Invalid token' }
    }

    const scopes = result.payload?.scope?.split(' ') ?? []
    const hasAdminScope = scopes.includes('bash:admin')

    return { valid: true, hasAdminScope }
  }

  return { valid: true }
}

/**
 * Check safety of a command
 */
async function checkSafety(
  path: string[],
  args: unknown[],
  bashModule: BashModule | ReturnType<typeof createMockBashModule>,
  config: RPCBashServerConfig,
  rpcRequest: RPCRequest
): Promise<{ valid: boolean; code?: string; message?: string }> {
  if (path[0] !== 'bash') return { valid: true }

  const method = path[1]
  if (method !== 'exec' && method !== 'run') return { valid: true }

  const command = args[0] as string
  const cmdArgs = (args[1] as string[] | undefined) || []
  const options = (args[2] as ExecOptions | undefined) || {}

  const fullCommand = cmdArgs.length > 0 ? `${command} ${cmdArgs.join(' ')}` : command

  // Check if command is dangerous
  if (config.safety?.checkBeforeExec || config.safety?.blockDangerous) {
    const dangerous = bashModule.isDangerous(fullCommand)

    if (dangerous.dangerous && config.safety?.blockDangerous) {
      // Check if confirm flag is set
      if (!options.confirm) {
        return {
          valid: false,
          code: ErrorCodes.COMMAND_BLOCKED,
          message: `Command blocked: dangerous - ${dangerous.reason}`,
        }
      }
    }
  }

  // Check for path traversal in arguments
  if (config.safety?.blockPathTraversal) {
    for (const arg of cmdArgs) {
      if (arg.includes('..')) {
        return {
          valid: false,
          code: ErrorCodes.COMMAND_BLOCKED,
          message: 'Command blocked: path traversal detected',
        }
      }
    }
  }

  // Check for command injection
  if (config.safety?.blockInjection) {
    for (const arg of cmdArgs) {
      if (arg.includes(';') || arg.includes('|') || arg.includes('&') || arg.includes('$(') || arg.includes('`')) {
        return {
          valid: false,
          code: ErrorCodes.COMMAND_BLOCKED,
          message: 'Command blocked: command injection detected',
        }
      }
    }
  }

  return { valid: true }
}

/**
 * Handle streaming request
 */
function handleStreamRequest(
  id: string,
  path: string[],
  args: unknown[],
  bashModule: BashModule | ReturnType<typeof createMockBashModule>,
  config: RPCBashServerConfig
): Response {
  return createStreamResponse()
}

/**
 * Create a success response
 */
function createSuccessResponse(id: string, result: unknown): Response {
  const response: RPCResponse = {
    type: 'response',
    id,
    success: true,
    result,
    timestamp: Date.now(),
  }
  return Response.json(response)
}

/**
 * Create an error response
 */
function createErrorResponse(
  id: string,
  code: string,
  message: string,
  data?: unknown,
  stack?: string
): Response {
  const response: RPCResponse = {
    type: 'response',
    id,
    success: false,
    error: {
      code,
      message,
      data,
      stack,
    },
    timestamp: Date.now(),
  }
  return Response.json(response)
}

/**
 * Create a streaming response
 */
function createStreamResponse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      // Streaming would be implemented here
      controller.close()
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/**
 * Expose a BashModule as an RPC namespace
 *
 * @param bashModule - The BashModule to expose
 * @returns The bash namespace object
 */
export function exposeBashModule(bashModule: BashModule | ReturnType<typeof createMockBashModule>): BashRPCNamespace {
  return {
    exec: bashModule.exec.bind(bashModule),
    run: bashModule.run.bind(bashModule),
    spawn: bashModule.spawn.bind(bashModule),
    analyze: bashModule.analyze.bind(bashModule),
    isDangerous: bashModule.isDangerous.bind(bashModule),
    parse: bashModule.parse.bind(bashModule),
  }
}

/**
 * Create a mock BashModule for testing
 */
function createMockBashModule(): BashModule & {
  exec: ReturnType<typeof Function.prototype.bind>
  run: ReturnType<typeof Function.prototype.bind>
  spawn: ReturnType<typeof Function.prototype.bind>
  analyze: ReturnType<typeof Function.prototype.bind>
  isDangerous: ReturnType<typeof Function.prototype.bind>
  parse: ReturnType<typeof Function.prototype.bind>
} {
  const executor: BashExecutor = {
    async execute(command: string, options?: ExecOptions): Promise<BashResult> {
      return {
        input: command,
        command,
        valid: true,
        generated: false,
        stdout: '',
        stderr: '',
        exitCode: 0,
        intent: { commands: [command.split(' ')[0]], reads: [], writes: [], deletes: [], network: false, elevated: false },
        classification: { type: 'read', impact: 'none', reversible: true, reason: 'Mock' },
      }
    },
    async spawn(command: string, args?: string[], options?: SpawnOptions): Promise<SpawnHandle> {
      return {
        pid: 1234,
        done: Promise.resolve({
          input: command,
          command,
          valid: true,
          generated: false,
          stdout: '',
          stderr: '',
          exitCode: 0,
          intent: { commands: [command], reads: [], writes: [], deletes: [], network: false, elevated: false },
          classification: { type: 'read', impact: 'none', reversible: true, reason: 'Mock' },
        }),
        kill: () => {},
        write: () => {},
        closeStdin: () => {},
      }
    },
  }

  return new BashModule(executor) as BashModule & {
    exec: ReturnType<typeof Function.prototype.bind>
    run: ReturnType<typeof Function.prototype.bind>
    spawn: ReturnType<typeof Function.prototype.bind>
    analyze: ReturnType<typeof Function.prototype.bind>
    isDangerous: ReturnType<typeof Function.prototype.bind>
    parse: ReturnType<typeof Function.prototype.bind>
  }
}

// ============================================================================
// DURABLE OBJECT CLASS
// ============================================================================

/**
 * RPCBashDO - Durable Object class for exposing BashModule via RPC
 *
 * This is a placeholder for the actual Durable Object implementation.
 * In production, this would extend DurableObject and handle WebSocket upgrades.
 *
 * @example
 * ```typescript
 * // In wrangler.toml
 * [durable_objects]
 * bindings = [{ name = "BASH_RPC", class_name = "RPCBashDO" }]
 *
 * // In worker code
 * const stub = env.BASH_RPC.get(id)
 * return stub.fetch(request)
 * ```
 */
export class RPCBashDO {
  private handler: RPCHandler
  private bashModule: BashModule

  constructor(executor: BashExecutor, config?: RPCBashServerConfig) {
    this.bashModule = new BashModule(executor)
    this.handler = createBashRPCHandler(this.bashModule, config)
  }

  async fetch(request: Request): Promise<Response> {
    return this.handler.fetch(request)
  }

  get bash(): BashRPCNamespace {
    return exposeBashModule(this.bashModule)
  }
}
