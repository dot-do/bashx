/**
 * bashx.do Worker Entry Point
 *
 * Durable Object-based shell execution service with:
 * - AST-based command safety analysis
 * - Tiered execution (native, RPC, loader, sandbox)
 * - FsCapability integration via FSX service binding
 *
 * @example
 * ```typescript
 * // RPC call
 * const response = await fetch(doStub, {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     method: 'exec',
 *     params: { command: 'ls', args: ['-la'] }
 *   })
 * })
 * ```
 *
 * @module bashx/do/worker
 */

import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'
import { BashModule, TieredExecutor, type BashExecutor } from './index.js'
import type { BashResult, ExecOptions, FsCapability } from '../types.js'
import {
  TerminalRenderer,
  StreamingRenderer,
  createWebSocketCallback,
  type RenderTier,
} from './terminal-renderer.js'

// ============================================================================
// ENVIRONMENT TYPES
// ============================================================================

/**
 * Environment bindings for bashx-do
 */
export interface Env {
  /** Self-binding for ShellDO */
  BASHX: DurableObjectNamespace

  /** Service binding to fsx-do for filesystem operations */
  FSX: Fetcher

  /** Optional: Container service for Tier 4 sandbox execution */
  CONTAINER?: Fetcher
}

// ============================================================================
// FSX SERVICE ADAPTER
// ============================================================================

/**
 * Partial implementation of FsCapability for FSX service binding.
 *
 * This allows BashModule to use native file operations via the FSX service
 * for commands like cat, ls, head, tail, etc.
 *
 * Note: This is a partial implementation - additional methods can be added as needed.
 */
class FsxServiceAdapter {
  constructor(private readonly fsx: Fetcher) {}

  async read(
    path: string,
    options?: { encoding?: string; start?: number; end?: number }
  ): Promise<string | Uint8Array> {
    const response = await this.fsx.fetch('https://fsx.do/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'readFile',
        params: { path, encoding: options?.encoding },
      }),
    })

    if (!response.ok) {
      const error = await response.json() as { code?: string; message?: string }
      throw Object.assign(new Error(error.message || 'Read failed'), { code: error.code })
    }

    const result = await response.json() as { data: string | number[] }

    if (options?.encoding === 'utf-8' || options?.encoding === 'utf8') {
      return result.data as string
    }

    // Binary data comes as number array, convert to Uint8Array
    if (Array.isArray(result.data)) {
      return new Uint8Array(result.data)
    }

    return result.data as string
  }

  async write(
    path: string,
    data: string | Uint8Array,
    options?: { mode?: number; flag?: string }
  ): Promise<void> {
    const response = await this.fsx.fetch('https://fsx.do/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'writeFile',
        params: { path, data, ...options },
      }),
    })

    if (!response.ok) {
      const error = await response.json() as { code?: string; message?: string }
      throw Object.assign(new Error(error.message || 'Write failed'), { code: error.code })
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path)
      return true
    } catch {
      return false
    }
  }

  async stat(path: string): Promise<{
    size: number
    mtime: Date
    isFile(): boolean
    isDirectory(): boolean
  }> {
    const response = await this.fsx.fetch('https://fsx.do/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'stat',
        params: { path },
      }),
    })

    if (!response.ok) {
      const error = await response.json() as { code?: string; message?: string }
      throw Object.assign(new Error(error.message || 'Stat failed'), { code: error.code })
    }

    const result = await response.json() as {
      size: number
      mtime: number
      mode: number
    }

    // Mode bits: S_IFDIR = 0o40000
    const isDir = (result.mode & 0o40000) === 0o40000

    return {
      size: result.size,
      mtime: new Date(result.mtime),
      isFile: () => !isDir,
      isDirectory: () => isDir,
    }
  }

  async list(
    path: string,
    options?: { withFileTypes?: boolean }
  ): Promise<Array<string | { name: string; isDirectory(): boolean }>> {
    const response = await this.fsx.fetch('https://fsx.do/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'readdir',
        params: { path, withFileTypes: options?.withFileTypes },
      }),
    })

    if (!response.ok) {
      const error = await response.json() as { code?: string; message?: string }
      throw Object.assign(new Error(error.message || 'List failed'), { code: error.code })
    }

    const result = await response.json() as {
      entries: Array<string | { name: string; type: string }>
    }

    if (options?.withFileTypes) {
      return (result.entries as Array<{ name: string; type: string }>).map((e) => ({
        name: e.name,
        isDirectory: () => e.type === 'directory',
      }))
    }

    return result.entries as string[]
  }

  async unlink(path: string): Promise<void> {
    const response = await this.fsx.fetch('https://fsx.do/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'unlink',
        params: { path },
      }),
    })

    if (!response.ok) {
      const error = await response.json() as { code?: string; message?: string }
      throw Object.assign(new Error(error.message || 'Unlink failed'), { code: error.code })
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const response = await this.fsx.fetch('https://fsx.do/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'mkdir',
        params: { path, ...options },
      }),
    })

    if (!response.ok) {
      const error = await response.json() as { code?: string; message?: string }
      throw Object.assign(new Error(error.message || 'Mkdir failed'), { code: error.code })
    }
  }

  async rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const response = await this.fsx.fetch('https://fsx.do/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'rmdir',
        params: { path, ...options },
      }),
    })

    if (!response.ok) {
      const error = await response.json() as { code?: string; message?: string }
      throw Object.assign(new Error(error.message || 'Rmdir failed'), { code: error.code })
    }
  }
}

// ============================================================================
// SHELL DURABLE OBJECT
// ============================================================================

/**
 * ShellDO - Durable Object for shell command execution
 *
 * Provides an HTTP/RPC API for executing shell commands with:
 * - AST-based safety analysis
 * - Tiered execution (native ops, RPC services, sandbox)
 * - FsCapability integration via FSX service binding
 *
 * @example
 * ```typescript
 * // Execute a command
 * const result = await fetch(doStub, {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     method: 'exec',
 *     params: { command: 'git', args: ['status'] }
 *   })
 * })
 * ```
 */
export class ShellDO extends DurableObject<Env> {
  private app: Hono
  private bashModule: BashModule
  private fsAdapter: FsxServiceAdapter

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    // Create FSX adapter for native file operations
    this.fsAdapter = new FsxServiceAdapter(env.FSX)

    // Create tiered executor with available bindings
    const executor = createExecutor(env, this.fsAdapter as unknown as FsCapability)

    // Create BashModule with FsCapability for native ops
    this.bashModule = new BashModule(executor, {
      fs: this.fsAdapter as unknown as FsCapability,
      useNativeOps: true,
    })

    this.app = this.createApp()
  }

  private createApp(): Hono {
    const app = new Hono()

    // Health check
    app.get('/health', (c) => c.json({ status: 'ok', service: 'bashx-do' }))

    // RPC endpoint
    app.post('/rpc', async (c) => {
      const { method, params } = await c.req.json<{
        method: string
        params: Record<string, unknown>
      }>()

      try {
        const result = await this.handleMethod(method, params)
        return c.json(result)
      } catch (error: unknown) {
        const err = error as { code?: string; message?: string }
        return c.json(
          {
            error: true,
            code: err.code || 'UNKNOWN',
            message: err.message || 'Unknown error',
          },
          400
        )
      }
    })

    // Convenience endpoint for quick command execution
    app.post('/exec', async (c) => {
      const { command, args, options } = await c.req.json<{
        command: string
        args?: string[]
        options?: ExecOptions
      }>()

      try {
        const result = await this.bashModule.exec(command, args, options)
        return c.json(result)
      } catch (error: unknown) {
        const err = error as { code?: string; message?: string }
        return c.json(
          {
            error: true,
            code: err.code || 'EXEC_ERROR',
            message: err.message || 'Execution failed',
          },
          400
        )
      }
    })

    // Run script endpoint
    app.post('/run', async (c) => {
      const { script, options } = await c.req.json<{
        script: string
        options?: ExecOptions
      }>()

      try {
        const result = await this.bashModule.run(script, options)
        return c.json(result)
      } catch (error: unknown) {
        const err = error as { code?: string; message?: string }
        return c.json(
          {
            error: true,
            code: err.code || 'RUN_ERROR',
            message: err.message || 'Script execution failed',
          },
          400
        )
      }
    })

    // Safety analysis endpoint
    app.post('/analyze', async (c) => {
      const { input } = await c.req.json<{ input: string }>()

      try {
        const result = this.bashModule.analyze(input)
        return c.json(result)
      } catch (error: unknown) {
        const err = error as { message?: string }
        return c.json(
          {
            error: true,
            message: err.message || 'Analysis failed',
          },
          400
        )
      }
    })

    // Rendered output endpoint - returns terminal-rendered output based on Accept header
    app.post('/render', async (c) => {
      const { command, args, options } = await c.req.json<{
        command: string
        args?: string[]
        options?: ExecOptions
      }>()

      try {
        // Detect render tier from request
        const renderer = TerminalRenderer.fromRequest(c.req.raw)

        // Execute command
        const startTime = Date.now()
        const result = await this.bashModule.exec(command, args, options)
        const duration = Date.now() - startTime

        // Render output according to tier
        const rendered = renderer.renderCommandOutput({
          command: args?.length ? `${command} ${args.join(' ')}` : command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          duration,
        })

        // Return appropriate content type
        const contentType = renderer.tier === 'markdown'
          ? 'text/markdown'
          : renderer.tier === 'ansi'
            ? 'text/x-ansi'
            : 'text/plain'

        return new Response(rendered, {
          headers: {
            'Content-Type': `${contentType}; charset=utf-8`,
            'X-Render-Tier': renderer.tier,
            'X-Exit-Code': String(result.exitCode),
            'X-Duration-Ms': String(duration),
          },
        })
      } catch (error: unknown) {
        const err = error as { code?: string; message?: string }
        return c.json(
          {
            error: true,
            code: err.code || 'RENDER_ERROR',
            message: err.message || 'Render failed',
          },
          400
        )
      }
    })

    // Table rendering endpoint - renders structured data as a table
    app.post('/table', async (c) => {
      const { data, options: tableOptions } = await c.req.json<{
        data: Record<string, unknown>[]
        options?: {
          columns?: Array<{ header: string; key: string; width?: number; align?: 'left' | 'center' | 'right' }>
          showHeaders?: boolean
          maxRows?: number
        }
      }>()

      try {
        const renderer = TerminalRenderer.fromRequest(c.req.raw)
        const rendered = renderer.renderTable(data, tableOptions)

        const contentType = renderer.tier === 'markdown'
          ? 'text/markdown'
          : renderer.tier === 'ansi'
            ? 'text/x-ansi'
            : 'text/plain'

        return new Response(rendered, {
          headers: {
            'Content-Type': `${contentType}; charset=utf-8`,
            'X-Render-Tier': renderer.tier,
          },
        })
      } catch (error: unknown) {
        const err = error as { message?: string }
        return c.json(
          {
            error: true,
            message: err.message || 'Table render failed',
          },
          400
        )
      }
    })

    // WebSocket endpoint for streaming command output
    app.get('/stream', async (c) => {
      // Upgrade to WebSocket
      const upgradeHeader = c.req.header('Upgrade')
      if (upgradeHeader !== 'websocket') {
        return c.text('Expected WebSocket upgrade', 426)
      }

      // Get render tier from query params
      const tier = (c.req.query('tier') || 'text') as RenderTier

      // Create WebSocket pair
      const webSocketPair = new WebSocketPair()
      const [client, server] = Object.values(webSocketPair)

      // Accept the WebSocket
      this.ctx.acceptWebSocket(server)

      // Store tier preference for this connection
      ;(server as unknown as { tier: RenderTier }).tier = tier

      return new Response(null, {
        status: 101,
        webSocket: client,
      })
    })

    return app
  }

  /**
   * Handle WebSocket messages for streaming execution
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      ws.send(JSON.stringify({ type: 'error', message: 'Binary messages not supported' }))
      return
    }

    try {
      const { action, command, args, options } = JSON.parse(message) as {
        action: 'exec' | 'run'
        command?: string
        args?: string[]
        options?: ExecOptions
      }

      // Get tier from WebSocket attachment
      const tier = ((ws as unknown as { tier?: RenderTier }).tier || 'text') as RenderTier

      // Create streaming renderer
      const renderer = new StreamingRenderer({ tier }, createWebSocketCallback(ws))

      if (action === 'exec' && command) {
        const fullCommand = args?.length ? `${command} ${args.join(' ')}` : command

        // Signal start
        renderer.start(fullCommand)

        // Execute command
        const startTime = Date.now()
        const result = await this.bashModule.exec(command, args, options)
        const duration = Date.now() - startTime

        // Stream output
        if (result.stdout) {
          renderer.output(result.stdout, 'stdout')
        }
        if (result.stderr) {
          renderer.output(result.stderr, 'stderr')
        }

        // Signal completion
        renderer.end(result.exitCode, duration)
      } else if (action === 'run' && command) {
        // Signal start
        renderer.start(command)

        // Execute script
        const startTime = Date.now()
        const result = await this.bashModule.run(command, options)
        const duration = Date.now() - startTime

        // Stream output
        if (result.stdout) {
          renderer.output(result.stdout, 'stdout')
        }
        if (result.stderr) {
          renderer.output(result.stderr, 'stderr')
        }

        // Signal completion
        renderer.end(result.exitCode, duration)
      } else {
        renderer.error('Invalid action or missing command')
      }
    } catch (error: unknown) {
      const err = error as { message?: string }
      ws.send(JSON.stringify({
        type: 'error',
        message: err.message || 'Execution failed',
      }))
    }
  }

  /**
   * Handle WebSocket close
   */
  async webSocketClose(_ws: WebSocket): Promise<void> {
    // Cleanup if needed
  }

  /**
   * Handle RPC method calls
   */
  private async handleMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<BashResult | { classification: unknown; intent: unknown } | { dangerous: boolean; reason?: string }> {
    switch (method) {
      case 'exec':
        return this.bashModule.exec(
          params.command as string,
          params.args as string[] | undefined,
          params.options as ExecOptions | undefined
        )

      case 'run':
        return this.bashModule.run(
          params.script as string,
          params.options as ExecOptions | undefined
        )

      case 'analyze':
        return this.bashModule.analyze(params.input as string)

      case 'isDangerous':
        return this.bashModule.isDangerous(params.input as string)

      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }

  /**
   * Handle incoming HTTP requests
   */
  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request)
  }
}

// ============================================================================
// EXECUTOR FACTORY
// ============================================================================

/**
 * Create the appropriate executor based on available environment bindings
 */
function createExecutor(env: Env, fs: FsCapability): BashExecutor {
  // Create tiered executor with FSX integration
  return new TieredExecutor({
    fs,
    // RPC bindings can be added here for Tier 2 services
    rpcBindings: {},
    // Sandbox binding if available for Tier 4 execution
    sandbox: env.CONTAINER
      ? {
          execute: async (command: string, options?: ExecOptions): Promise<BashResult> => {
            const response = await env.CONTAINER!.fetch('https://container/exec', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ command, options }),
            })
            return response.json() as Promise<BashResult>
          },
        }
      : undefined,
  })
}

// ============================================================================
// WORKER HANDLER
// ============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Route to DO based on path or use default
    const namespace = url.pathname.split('/')[1] || 'default'
    const id = env.BASHX.idFromName(namespace)
    const stub = env.BASHX.get(id)

    // Forward request to DO, stripping the namespace from path
    const doUrl = new URL(request.url)
    doUrl.pathname = url.pathname.replace(`/${namespace}`, '') || '/'

    return stub.fetch(new Request(doUrl, request))
  },
}
