/**
 * Tiered Execution System
 *
 * Implements a 4-tier execution model for bash commands:
 *
 * - Tier 1: Native in-Worker via nodejs_compat_v2/ofetch (fastest, most limited)
 * - Tier 2: RPC bindings for jq.do/npm.do (fast, specific tools)
 * - Tier 3: worker_loaders for dynamic npm (flexible, dynamic loading)
 * - Tier 4: Sandbox SDK for true Linux needs (slowest, full capability)
 *
 * The executor auto-detects which tier to use based on command analysis
 * and available bindings.
 *
 * @module bashx/do/tiered-executor
 */

import type { BashExecutor } from './index.js'
import type { BashResult, ExecOptions, SpawnOptions, SpawnHandle, FsCapability } from '../types.js'

// ============================================================================
// TYPES
// ============================================================================

/**
 * Execution tier levels
 */
export type ExecutionTier = 1 | 2 | 3 | 4

/**
 * Tier classification result
 */
export interface TierClassification {
  /** The tier that should handle this command */
  tier: ExecutionTier
  /** Reason for the tier selection */
  reason: string
  /** The handler that will execute the command */
  handler: 'native' | 'rpc' | 'loader' | 'sandbox'
  /** Specific capability or service that will be used */
  capability?: string
}

/**
 * RPC service binding for Tier 2 execution
 */
export interface RpcServiceBinding {
  /** Service name (e.g., 'jq', 'npm') */
  name: string
  /** RPC endpoint URL or service binding */
  endpoint: string | { fetch: typeof fetch }
  /** Supported commands */
  commands: string[]
}

/**
 * Worker loader binding for Tier 3 execution
 */
export interface WorkerLoaderBinding {
  /** Loader name */
  name: string
  /** Load function to dynamically import modules */
  load: (module: string) => Promise<unknown>
  /** Available modules */
  modules: string[]
}

/**
 * Sandbox SDK binding for Tier 4 execution
 */
export interface SandboxBinding {
  /** Execute command in sandbox */
  execute: (command: string, options?: ExecOptions) => Promise<BashResult>
  /** Spawn streaming process in sandbox */
  spawn?: (command: string, args?: string[], options?: SpawnOptions) => Promise<SpawnHandle>
}

/**
 * Configuration for the TieredExecutor
 */
export interface TieredExecutorConfig {
  /**
   * Tier 1: Native filesystem capability for in-Worker operations.
   * When provided, simple file operations (cat, ls, etc.) are executed natively.
   */
  fs?: FsCapability

  /**
   * Tier 2: RPC service bindings for external services.
   * Map of service name to RPC binding configuration.
   *
   * @example
   * ```typescript
   * rpcBindings: {
   *   jq: { endpoint: 'https://jq.do', commands: ['jq'] },
   *   npm: { endpoint: env.NPM_SERVICE, commands: ['npm', 'npx', 'pnpm'] },
   * }
   * ```
   */
  rpcBindings?: Record<string, RpcServiceBinding>

  /**
   * Tier 3: Worker loader bindings for dynamic npm modules.
   * Allows loading npm packages at runtime in Workers.
   */
  workerLoaders?: Record<string, WorkerLoaderBinding>

  /**
   * Tier 4: Sandbox SDK binding for full Linux execution.
   * Used when commands require true Linux capabilities.
   */
  sandbox?: SandboxBinding

  /**
   * Default timeout for command execution in milliseconds.
   * @default 30000
   */
  defaultTimeout?: number

  /**
   * Whether to prefer faster tiers over more capable ones.
   * When true, the executor will try Tier 1 before Tier 2, etc.
   * When false, it uses the most capable tier that can handle the command.
   * @default true
   */
  preferFaster?: boolean
}

// ============================================================================
// TIER 1: NATIVE COMMANDS
// ============================================================================

/**
 * Commands that can be executed natively in-Worker via nodejs_compat_v2
 */
const TIER_1_NATIVE_COMMANDS = new Set([
  // Basic file operations
  'cat', 'head', 'tail', 'ls', 'test',
  // Echo/print (pure computation)
  'echo', 'printf',
  // Path operations
  'pwd', 'dirname', 'basename',
  // String/text processing (pure)
  'wc', 'sort', 'uniq', 'tr', 'cut', 'rev',
  // Date/time (pure)
  'date',
  // True/false (pure)
  'true', 'false',
])

/**
 * Commands that specifically require filesystem access for Tier 1
 */
const TIER_1_FS_COMMANDS = new Set(['cat', 'head', 'tail', 'ls', 'test'])

// ============================================================================
// TIER 2: RPC COMMANDS
// ============================================================================

/**
 * Default RPC services and their commands
 */
const DEFAULT_RPC_SERVICES: Record<string, { commands: string[]; endpoint: string }> = {
  jq: {
    commands: ['jq'],
    endpoint: 'https://jq.do',
  },
  npm: {
    commands: ['npm', 'npx', 'pnpm', 'yarn', 'bun'],
    endpoint: 'https://npm.do',
  },
  git: {
    commands: ['git'],
    endpoint: 'https://git.do',
  },
}

// ============================================================================
// TIER 3: WORKER LOADER MODULES
// ============================================================================

/**
 * NPM packages that can be dynamically loaded in Workers
 */
const TIER_3_LOADABLE_MODULES = new Set([
  // JavaScript/TypeScript tools
  'esbuild', 'typescript', 'prettier', 'eslint',
  // Data processing
  'zod', 'ajv', 'yaml', 'toml',
  // Crypto
  'crypto-js', 'jose',
  // Utility
  'lodash', 'date-fns', 'uuid',
])

// ============================================================================
// TIER 4: SANDBOX-ONLY COMMANDS
// ============================================================================

/**
 * Commands that require true Linux sandbox execution
 */
const TIER_4_SANDBOX_COMMANDS = new Set([
  // System/process management
  'ps', 'kill', 'killall', 'top', 'htop',
  // Network tools
  'ping', 'curl', 'wget', 'ssh', 'scp', 'nc', 'netstat',
  // Package managers (when not via RPC)
  'apt', 'apt-get', 'yum', 'dnf', 'brew',
  // Containers
  'docker', 'docker-compose', 'podman', 'kubectl',
  // Compilers and runtimes
  'gcc', 'g++', 'clang', 'rustc', 'cargo', 'go', 'python', 'python3', 'ruby', 'perl',
  // System utilities
  'sudo', 'su', 'chmod', 'chown', 'chgrp',
  // Archive
  'tar', 'gzip', 'gunzip', 'zip', 'unzip',
  // Process substitution, pipes, complex shell features
  'bash', 'sh', 'zsh',
])

// ============================================================================
// TIERED EXECUTOR CLASS
// ============================================================================

/**
 * TieredExecutor - Smart executor that routes commands to the appropriate tier.
 *
 * The executor analyzes each command and determines the optimal execution tier:
 * - Tier 1: Fast, in-Worker native operations (cat, ls, echo, etc.)
 * - Tier 2: RPC calls to external services (jq.do, npm.do, git.do)
 * - Tier 3: Dynamic npm module loading (esbuild, prettier, etc.)
 * - Tier 4: Full sandbox execution for Linux-specific commands
 *
 * @example
 * ```typescript
 * const executor = new TieredExecutor({
 *   fs: fsCapability,
 *   rpcBindings: {
 *     jq: { endpoint: 'https://jq.do', commands: ['jq'] },
 *   },
 *   sandbox: sandboxBinding,
 * })
 *
 * // Auto-routed to Tier 1 (native)
 * await executor.execute('cat file.txt')
 *
 * // Auto-routed to Tier 2 (RPC)
 * await executor.execute('jq .name package.json')
 *
 * // Auto-routed to Tier 4 (sandbox)
 * await executor.execute('docker ps')
 * ```
 */
export class TieredExecutor implements BashExecutor {
  private readonly fs?: FsCapability
  private readonly rpcBindings: Record<string, RpcServiceBinding>
  private readonly workerLoaders: Record<string, WorkerLoaderBinding>
  private readonly sandbox?: SandboxBinding
  private readonly defaultTimeout: number
  private readonly preferFaster: boolean

  constructor(config: TieredExecutorConfig) {
    this.fs = config.fs
    this.rpcBindings = config.rpcBindings ?? {}
    this.workerLoaders = config.workerLoaders ?? {}
    this.sandbox = config.sandbox
    this.defaultTimeout = config.defaultTimeout ?? 30000
    this.preferFaster = config.preferFaster ?? true

    // Merge default RPC services with provided bindings
    for (const [name, service] of Object.entries(DEFAULT_RPC_SERVICES)) {
      if (!this.rpcBindings[name]) {
        this.rpcBindings[name] = {
          name,
          endpoint: service.endpoint,
          commands: service.commands,
        }
      }
    }
  }

  /**
   * Classify a command to determine which tier should execute it.
   *
   * @param command - The command to classify
   * @returns TierClassification with tier level and handler info
   */
  classifyCommand(command: string): TierClassification {
    const cmd = this.extractCommandName(command)

    // Tier 1: Native in-Worker commands
    if (TIER_1_NATIVE_COMMANDS.has(cmd)) {
      // If it's a filesystem command, check if fs capability is available
      if (TIER_1_FS_COMMANDS.has(cmd)) {
        if (this.fs) {
          return {
            tier: 1,
            reason: `Native filesystem operation via FsCapability`,
            handler: 'native',
            capability: 'fs',
          }
        }
        // Fall through to sandbox if no fs capability
      } else {
        // Pure computation commands
        return {
          tier: 1,
          reason: `Pure computation command (${cmd})`,
          handler: 'native',
          capability: 'compute',
        }
      }
    }

    // Tier 2: RPC service commands
    for (const [serviceName, binding] of Object.entries(this.rpcBindings)) {
      if (binding.commands.includes(cmd)) {
        return {
          tier: 2,
          reason: `RPC service available (${serviceName})`,
          handler: 'rpc',
          capability: serviceName,
        }
      }
    }

    // Tier 3: Check for commands that can use dynamically loaded modules
    // This is for Node.js tools that can run in Workers with worker_loaders
    const workerLoaderMatch = this.matchWorkerLoader(command)
    if (workerLoaderMatch) {
      return {
        tier: 3,
        reason: `Dynamic npm module available (${workerLoaderMatch})`,
        handler: 'loader',
        capability: workerLoaderMatch,
      }
    }

    // Tier 4: Sandbox for everything else
    return {
      tier: 4,
      reason: TIER_4_SANDBOX_COMMANDS.has(cmd)
        ? `Requires Linux sandbox (${cmd})`
        : 'No higher tier available for this command',
      handler: 'sandbox',
      capability: 'container',
    }
  }

  /**
   * Execute a command, automatically routing to the appropriate tier.
   *
   * @param command - The command to execute
   * @param options - Optional execution options
   * @returns Promise resolving to the execution result
   */
  async execute(command: string, options?: ExecOptions): Promise<BashResult> {
    const classification = this.classifyCommand(command)

    try {
      switch (classification.tier) {
        case 1:
          return await this.executeTier1(command, classification, options)
        case 2:
          return await this.executeTier2(command, classification, options)
        case 3:
          return await this.executeTier3(command, classification, options)
        case 4:
          return await this.executeTier4(command, classification, options)
        default:
          throw new Error(`Unknown tier: ${classification.tier}`)
      }
    } catch (error) {
      // If a higher tier fails, try falling back to a lower tier
      if (classification.tier < 4 && this.sandbox) {
        console.warn(
          `Tier ${classification.tier} failed for "${command}", falling back to sandbox:`,
          error
        )
        return this.executeTier4(command, { ...classification, tier: 4 }, options)
      }
      throw error
    }
  }

  /**
   * Spawn a streaming process. Routes to sandbox for full streaming support.
   */
  async spawn(command: string, args?: string[], options?: SpawnOptions): Promise<SpawnHandle> {
    if (!this.sandbox?.spawn) {
      throw new Error('Spawn requires sandbox with spawn support')
    }
    return this.sandbox.spawn(command, args, options)
  }

  // ============================================================================
  // TIER EXECUTION METHODS
  // ============================================================================

  /**
   * Tier 1: Execute command natively in-Worker
   */
  private async executeTier1(
    command: string,
    classification: TierClassification,
    options?: ExecOptions
  ): Promise<BashResult> {
    const cmd = this.extractCommandName(command)
    const args = this.extractArgs(command)

    // Handle filesystem commands via FsCapability
    if (classification.capability === 'fs' && this.fs) {
      return this.executeNativeFs(cmd, args, options)
    }

    // Handle pure computation commands
    return this.executeNativeCompute(cmd, args, options)
  }

  /**
   * Execute native filesystem operations via FsCapability
   */
  private async executeNativeFs(
    cmd: string,
    args: string[],
    options?: ExecOptions
  ): Promise<BashResult> {
    if (!this.fs) {
      throw new Error('FsCapability not available')
    }

    try {
      let stdout = ''
      let exitCode = 0

      switch (cmd) {
        case 'cat': {
          if (args.length === 0) {
            return this.createResult(`cat ${args.join(' ')}`, '', 'cat: missing operand', 1, 1)
          }
          const contents = await Promise.all(args.filter(a => !a.startsWith('-')).map(f => this.fs!.read(f)))
          stdout = contents.join('')
          break
        }

        case 'ls': {
          const path = args.find(a => !a.startsWith('-')) || '.'
          const entries = await this.fs.list(path)
          stdout = entries.map(e => e.isDirectory ? `${e.name}/` : e.name).join('\n') + '\n'
          break
        }

        case 'head': {
          const file = args.find(a => !a.startsWith('-'))
          if (!file) return this.createResult('head', '', 'head: missing operand', 1, 1)
          const lines = parseInt(args.find(a => a.startsWith('-n'))?.slice(2) || '10', 10)
          const content = await this.fs.read(file)
          stdout = content.split('\n').slice(0, lines).join('\n') + '\n'
          break
        }

        case 'tail': {
          const file = args.find(a => !a.startsWith('-'))
          if (!file) return this.createResult('tail', '', 'tail: missing operand', 1, 1)
          const lines = parseInt(args.find(a => a.startsWith('-n'))?.slice(2) || '10', 10)
          const content = await this.fs.read(file)
          const allLines = content.split('\n')
          // Handle trailing newline - if last element is empty, exclude it from count
          const effectiveLines = allLines[allLines.length - 1] === '' ? allLines.slice(0, -1) : allLines
          stdout = effectiveLines.slice(-lines).join('\n') + '\n'
          break
        }

        case 'test': {
          const flag = args[0]
          const path = args[1]
          if (!flag || !path) {
            exitCode = 2
            break
          }
          switch (flag) {
            case '-e':
              exitCode = (await this.fs.exists(path)) ? 0 : 1
              break
            case '-f': {
              const exists = await this.fs.exists(path)
              if (!exists) { exitCode = 1; break }
              const stat = await this.fs.stat(path)
              exitCode = stat.isFile ? 0 : 1
              break
            }
            case '-d': {
              const exists = await this.fs.exists(path)
              if (!exists) { exitCode = 1; break }
              const stat = await this.fs.stat(path)
              exitCode = stat.isDirectory ? 0 : 1
              break
            }
            default:
              exitCode = 2
          }
          break
        }

        default:
          throw new Error(`Unsupported native fs command: ${cmd}`)
      }

      return this.createResult(`${cmd} ${args.join(' ')}`, stdout, '', exitCode, 1)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.createResult(`${cmd} ${args.join(' ')}`, '', message, 1, 1)
    }
  }

  /**
   * Execute pure computation commands natively
   */
  private async executeNativeCompute(
    cmd: string,
    args: string[],
    options?: ExecOptions
  ): Promise<BashResult> {
    let stdout = ''
    let exitCode = 0

    switch (cmd) {
      case 'echo':
        stdout = args.join(' ') + '\n'
        break

      case 'printf':
        // Simple printf implementation
        stdout = args.join(' ').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        break

      case 'pwd':
        stdout = (options?.cwd || process.cwd?.() || '/') + '\n'
        break

      case 'date':
        stdout = new Date().toString() + '\n'
        break

      case 'true':
        exitCode = 0
        break

      case 'false':
        exitCode = 1
        break

      case 'basename': {
        const path = args[0] || ''
        stdout = path.split('/').pop() || ''
        if (stdout) stdout += '\n'
        break
      }

      case 'dirname': {
        const path = args[0] || ''
        const parts = path.split('/')
        parts.pop()
        stdout = (parts.join('/') || (path.startsWith('/') ? '/' : '.')) + '\n'
        break
      }

      case 'wc': {
        // Count lines/words/chars from stdin or return empty
        const input = options?.stdin || ''
        const lines = input.split('\n').length - (input.endsWith('\n') ? 1 : 0)
        const words = input.split(/\s+/).filter(Boolean).length
        const chars = input.length
        if (args.includes('-l')) {
          stdout = `${lines}\n`
        } else if (args.includes('-w')) {
          stdout = `${words}\n`
        } else if (args.includes('-c')) {
          stdout = `${chars}\n`
        } else {
          stdout = `${lines} ${words} ${chars}\n`
        }
        break
      }

      case 'sort': {
        const input = options?.stdin || ''
        const lines = input.split('\n').filter(Boolean)
        lines.sort()
        if (args.includes('-r')) lines.reverse()
        stdout = lines.join('\n') + (lines.length ? '\n' : '')
        break
      }

      case 'uniq': {
        const input = options?.stdin || ''
        const lines = input.split('\n')
        const unique = lines.filter((line, i) => i === 0 || line !== lines[i - 1])
        stdout = unique.join('\n')
        break
      }

      case 'tr': {
        const input = options?.stdin || ''
        const set1 = args[0] || ''
        const set2 = args[1] || ''
        let result = input
        for (let i = 0; i < set1.length && i < set2.length; i++) {
          result = result.replace(new RegExp(set1[i], 'g'), set2[i])
        }
        stdout = result
        break
      }

      case 'rev': {
        const input = options?.stdin || ''
        stdout = input.split('\n').map(line => line.split('').reverse().join('')).join('\n')
        break
      }

      case 'cut': {
        const input = options?.stdin || ''
        const delimiter = args.includes('-d') ? args[args.indexOf('-d') + 1] : '\t'
        const fieldArg = args.includes('-f') ? args[args.indexOf('-f') + 1] : '1'
        const field = parseInt(fieldArg, 10) - 1
        stdout = input.split('\n').map(line => {
          const parts = line.split(delimiter)
          return parts[field] || ''
        }).join('\n')
        break
      }

      default:
        throw new Error(`Unsupported native compute command: ${cmd}`)
    }

    return this.createResult(`${cmd} ${args.join(' ')}`, stdout, '', exitCode, 1)
  }

  /**
   * Tier 2: Execute command via RPC service
   */
  private async executeTier2(
    command: string,
    classification: TierClassification,
    options?: ExecOptions
  ): Promise<BashResult> {
    const serviceName = classification.capability
    if (!serviceName) {
      throw new Error('No RPC service specified for Tier 2 execution')
    }

    const binding = this.rpcBindings[serviceName]
    if (!binding) {
      throw new Error(`RPC binding not found: ${serviceName}`)
    }

    try {
      const endpoint = typeof binding.endpoint === 'string'
        ? binding.endpoint
        : null

      if (!endpoint) {
        // Use the binding's fetch method directly
        const fetcher = binding.endpoint as { fetch: typeof fetch }
        const response = await fetcher.fetch('/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command,
            cwd: options?.cwd,
            env: options?.env,
            timeout: options?.timeout ?? this.defaultTimeout,
          }),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return this.createResult(command, '', `RPC error: ${errorText}`, 1, 2)
        }

        const result = await response.json() as { stdout: string; stderr: string; exitCode: number }
        return this.createResult(command, result.stdout, result.stderr, result.exitCode, 2)
      }

      // Make HTTP request to RPC endpoint
      const response = await fetch(`${endpoint}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command,
          cwd: options?.cwd,
          env: options?.env,
          timeout: options?.timeout ?? this.defaultTimeout,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        return this.createResult(command, '', `RPC error: ${errorText}`, 1, 2)
      }

      const result = await response.json() as { stdout: string; stderr: string; exitCode: number }
      return this.createResult(command, result.stdout, result.stderr, result.exitCode, 2)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Tier 2 RPC execution failed: ${message}`)
    }
  }

  /**
   * Tier 3: Execute via worker_loaders (dynamic npm modules)
   */
  private async executeTier3(
    command: string,
    classification: TierClassification,
    options?: ExecOptions
  ): Promise<BashResult> {
    const moduleName = classification.capability
    if (!moduleName) {
      throw new Error('No module specified for Tier 3 execution')
    }

    const loader = this.workerLoaders[moduleName]
    if (!loader) {
      throw new Error(`Worker loader not found: ${moduleName}`)
    }

    try {
      // Load the module dynamically
      const module = await loader.load(moduleName)

      // Execute command based on module type
      // This is a simplified implementation - real implementation would
      // need to know how to invoke each module's CLI
      const result = await this.executeLoadedModule(module, command, options)
      return this.createResult(command, result.stdout, result.stderr, result.exitCode, 3)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Tier 3 worker loader execution failed: ${message}`)
    }
  }

  /**
   * Execute a dynamically loaded module
   */
  private async executeLoadedModule(
    module: unknown,
    command: string,
    options?: ExecOptions
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // This is a placeholder for module-specific execution logic
    // Real implementation would handle each module type appropriately
    const cmd = this.extractCommandName(command)
    const args = this.extractArgs(command)

    // Check if module has a CLI-like interface
    const mod = module as Record<string, unknown>

    // Try common patterns for CLI modules
    if (typeof mod.run === 'function') {
      const result = await mod.run(args)
      return { stdout: String(result), stderr: '', exitCode: 0 }
    }

    if (typeof mod.main === 'function') {
      const result = await mod.main(args)
      return { stdout: String(result), stderr: '', exitCode: 0 }
    }

    if (typeof mod.default === 'function') {
      const result = await mod.default(args)
      return { stdout: String(result), stderr: '', exitCode: 0 }
    }

    throw new Error(`Module ${cmd} does not have a callable interface`)
  }

  /**
   * Tier 4: Execute via Sandbox SDK
   */
  private async executeTier4(
    command: string,
    classification: TierClassification,
    options?: ExecOptions
  ): Promise<BashResult> {
    if (!this.sandbox) {
      throw new Error('Sandbox not configured. Tier 4 execution requires a sandbox binding.')
    }

    const result = await this.sandbox.execute(command, options)

    // Add tier info to result
    return {
      ...result,
      classification: {
        ...result.classification,
        reason: `${result.classification.reason} (Tier 4: Sandbox)`,
      },
    }
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  /**
   * Extract command name from a full command string
   */
  private extractCommandName(command: string): string {
    const trimmed = command.trim()
    // Handle env vars prefix: VAR=value cmd
    const withoutEnvVars = trimmed.replace(/^(\w+=\S+\s+)+/, '')
    // Get first word
    const match = withoutEnvVars.match(/^[\w\-\.\/]+/)
    if (!match) return ''
    // Handle path: /usr/bin/cmd -> cmd
    const name = match[0].split('/').pop() || ''
    return name
  }

  /**
   * Extract arguments from a full command string
   */
  private extractArgs(command: string): string[] {
    const trimmed = command.trim()
    // Remove env vars prefix
    const withoutEnvVars = trimmed.replace(/^(\w+=\S+\s+)+/, '')
    // Split by whitespace, respecting quotes
    const parts = this.tokenize(withoutEnvVars)
    // Skip the command name
    return parts.slice(1)
  }

  /**
   * Tokenize command respecting quotes
   */
  private tokenize(input: string): string[] {
    const tokens: string[] = []
    let current = ''
    let inSingleQuote = false
    let inDoubleQuote = false

    for (let i = 0; i < input.length; i++) {
      const char = input[i]

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote
        current += char
      } else if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote
        current += char
      } else if (/\s/.test(char) && !inSingleQuote && !inDoubleQuote) {
        if (current) {
          tokens.push(this.stripQuotes(current))
          current = ''
        }
      } else {
        current += char
      }
    }

    if (current) {
      tokens.push(this.stripQuotes(current))
    }

    return tokens
  }

  /**
   * Strip outer quotes from a string
   */
  private stripQuotes(s: string): string {
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
      return s.slice(1, -1)
    }
    return s
  }

  /**
   * Check if a command can use a worker loader
   */
  private matchWorkerLoader(command: string): string | null {
    const cmd = this.extractCommandName(command)

    // Check if we have a loader for this command
    for (const [name, loader] of Object.entries(this.workerLoaders)) {
      if (loader.modules.includes(cmd)) {
        return name
      }
    }

    // Check if it's a known loadable module
    if (TIER_3_LOADABLE_MODULES.has(cmd)) {
      return cmd
    }

    return null
  }

  /**
   * Create a BashResult with tier information
   */
  private createResult(
    command: string,
    stdout: string,
    stderr: string,
    exitCode: number,
    tier: ExecutionTier
  ): BashResult {
    return {
      input: command,
      command,
      valid: true,
      generated: false,
      stdout,
      stderr,
      exitCode,
      intent: {
        commands: [this.extractCommandName(command)],
        reads: [],
        writes: [],
        deletes: [],
        network: false,
        elevated: false,
      },
      classification: {
        type: 'execute',
        impact: 'none',
        reversible: true,
        reason: `Executed via Tier ${tier}`,
      },
    }
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Get tier capabilities summary
   */
  getCapabilities(): {
    tier1: { available: boolean; commands: string[] }
    tier2: { available: boolean; services: string[] }
    tier3: { available: boolean; loaders: string[] }
    tier4: { available: boolean }
  } {
    return {
      tier1: {
        available: true, // Always available for pure compute
        commands: Array.from(TIER_1_NATIVE_COMMANDS),
      },
      tier2: {
        available: Object.keys(this.rpcBindings).length > 0,
        services: Object.keys(this.rpcBindings),
      },
      tier3: {
        available: Object.keys(this.workerLoaders).length > 0,
        loaders: Object.keys(this.workerLoaders),
      },
      tier4: {
        available: this.sandbox !== undefined,
      },
    }
  }

  /**
   * Check if a specific tier is available for a command
   */
  isTierAvailable(tier: ExecutionTier, command?: string): boolean {
    switch (tier) {
      case 1:
        if (!command) return true
        const cmd1 = this.extractCommandName(command)
        if (TIER_1_FS_COMMANDS.has(cmd1)) return this.fs !== undefined
        return TIER_1_NATIVE_COMMANDS.has(cmd1)
      case 2:
        if (!command) return Object.keys(this.rpcBindings).length > 0
        const cmd2 = this.extractCommandName(command)
        return Object.values(this.rpcBindings).some(b => b.commands.includes(cmd2))
      case 3:
        if (!command) return Object.keys(this.workerLoaders).length > 0
        return this.matchWorkerLoader(command) !== null
      case 4:
        return this.sandbox !== undefined
      default:
        return false
    }
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create a TieredExecutor from environment bindings.
 *
 * @param env - Worker environment with bindings
 * @param options - Additional configuration options
 * @returns Configured TieredExecutor
 *
 * @example
 * ```typescript
 * // In your Worker
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const executor = createTieredExecutor(env, {
 *       rpcBindings: {
 *         jq: { endpoint: env.JQ_SERVICE, commands: ['jq'] },
 *       },
 *       sandbox: {
 *         execute: async (cmd, opts) => containerExecutor.run(cmd, opts),
 *       },
 *     })
 *
 *     // Commands are auto-routed to the best tier
 *     const result = await executor.execute('echo hello')
 *     return new Response(result.stdout)
 *   }
 * }
 * ```
 */
export function createTieredExecutor(
  env: Record<string, unknown>,
  options?: Partial<TieredExecutorConfig>
): TieredExecutor {
  return new TieredExecutor({
    fs: options?.fs,
    rpcBindings: options?.rpcBindings,
    workerLoaders: options?.workerLoaders,
    sandbox: options?.sandbox,
    defaultTimeout: options?.defaultTimeout,
    preferFaster: options?.preferFaster,
  })
}
