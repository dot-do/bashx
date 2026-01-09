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
import {
  executeBc,
  executeExpr,
  executeSeq,
  executeShuf,
  executeSleep,
  executeTimeout,
  parseDuration,
  timeoutCommandNotFound,
  type SeqOptions,
  type ShufOptions,
  type TimeoutOptions,
} from './commands/math-control.js'
import {
  executeJq,
  executeYq,
  executeBase64,
  executeEnvsubst,
  parseJqArgs,
  parseYqArgs,
  parseBase64Args,
  parseEnvsubstArgs,
  JqError,
  Base64Error,
  EnvsubstError,
} from './commands/data-processing.js'
import {
  CRYPTO_COMMANDS,
  executeCryptoCommand,
} from './commands/crypto.js'
import {
  executeSed,
  executeAwk,
  executeDiff,
  executePatch,
  executeTee,
  executeXargs,
  TEXT_PROCESSING_COMMANDS,
} from './commands/text-processing.js'

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
  // Basic file operations (read)
  'cat', 'head', 'tail', 'ls', 'test', 'stat', 'readlink', 'find', 'grep',
  // File operations (write)
  'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch', 'truncate', 'ln',
  // Permission operations
  'chmod', 'chown',
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
  // HTTP operations (via fetch API)
  'curl', 'wget',
  // Math & control commands
  'bc', 'expr', 'seq', 'shuf', 'sleep', 'timeout',
  // Compression commands (native via pako/fflate)
  'gzip', 'gunzip', 'zcat', 'tar', 'zip', 'unzip',
  // Data processing commands (native implementations)
  'jq', 'yq', 'base64', 'envsubst',
  // Crypto commands (native via Web Crypto API)
  'sha256sum', 'sha1sum', 'sha512sum', 'sha384sum', 'md5sum',
  'uuidgen', 'uuid', 'cksum', 'sum', 'openssl',
  // Text processing commands (native implementations)
  'sed', 'awk', 'diff', 'patch', 'tee', 'xargs',
])

/**
 * Commands that specifically require filesystem access for Tier 1
 */
const TIER_1_FS_COMMANDS = new Set([
  // Read operations
  'cat', 'head', 'tail', 'ls', 'test', 'stat', 'readlink', 'find', 'grep',
  // Write operations
  'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch', 'truncate', 'ln',
  // Permission operations
  'chmod', 'chown',
  // Compression commands (need filesystem access)
  'gzip', 'gunzip', 'zcat', 'tar', 'zip', 'unzip',
])

/**
 * Commands that use native HTTP (fetch API) for Tier 1
 */
const TIER_1_HTTP_COMMANDS = new Set(['curl', 'wget'])

/**
 * Data processing commands with native implementations
 */
const TIER_1_DATA_COMMANDS = new Set(['jq', 'yq', 'base64', 'envsubst'])

/**
 * Crypto commands with native Web Crypto API implementations
 */
const TIER_1_CRYPTO_COMMANDS = new Set([
  'sha256sum', 'sha1sum', 'sha512sum', 'sha384sum', 'md5sum',
  'uuidgen', 'uuid', 'cksum', 'sum', 'openssl',
])

/**
 * Text processing commands with native implementations
 */
const TIER_1_TEXT_PROCESSING_COMMANDS = new Set([
  'sed', 'awk', 'diff', 'patch', 'tee', 'xargs',
])

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
  // Network tools (curl/wget moved to Tier 1 via native fetch)
  'ping', 'ssh', 'scp', 'nc', 'netstat',
  // Package managers (when not via RPC)
  'apt', 'apt-get', 'yum', 'dnf', 'brew',
  // Containers
  'docker', 'docker-compose', 'podman', 'kubectl',
  // Compilers and runtimes
  'gcc', 'g++', 'clang', 'rustc', 'cargo', 'go', 'python', 'python3', 'ruby', 'perl',
  // System utilities (chmod/chown moved to Tier 1 via FsCapability)
  'sudo', 'su', 'chgrp',
  // Archive (gzip, tar, zip moved to Tier 1 via pako/fflate)
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
      } else if (TIER_1_HTTP_COMMANDS.has(cmd)) {
        // HTTP commands via native fetch API
        return {
          tier: 1,
          reason: `Native HTTP operation via fetch API (${cmd})`,
          handler: 'native',
          capability: 'http',
        }
      } else if (TIER_1_DATA_COMMANDS.has(cmd)) {
        // Data processing commands (jq, yq, base64, envsubst)
        return {
          tier: 1,
          reason: `Native data processing command (${cmd})`,
          handler: 'native',
          capability: cmd, // Use command name as capability
        }
      } else if (TIER_1_CRYPTO_COMMANDS.has(cmd)) {
        // Crypto commands via Web Crypto API
        return {
          tier: 1,
          reason: `Native crypto command via Web Crypto API (${cmd})`,
          handler: 'native',
          capability: 'crypto',
        }
      } else if (TIER_1_TEXT_PROCESSING_COMMANDS.has(cmd)) {
        // Text processing commands (sed, awk, diff, patch, tee, xargs)
        return {
          tier: 1,
          reason: `Native text processing command (${cmd})`,
          handler: 'native',
          capability: 'text',
        }
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
    // Handle input redirection (< filename)
    const redirectMatch = command.match(/^(.+?)\s*<\s*(\S+)\s*$/)
    if (redirectMatch && this.fs) {
      const actualCommand = redirectMatch[1].trim()
      const inputFile = redirectMatch[2]
      try {
        const inputContent = await this.fs.read(inputFile, { encoding: 'utf-8' }) as string
        return this.execute(actualCommand, { ...options, stdin: inputContent })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return this.createResult(command, '', message, 1, 1)
      }
    }

    // Handle pipelines - split by | and execute in sequence
    const pipelineSegments = this.splitPipeline(command)
    if (pipelineSegments.length > 1) {
      return this.executePipeline(pipelineSegments, options)
    }

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

  /**
   * Split a command into pipeline segments, respecting quotes
   */
  private splitPipeline(command: string): string[] {
    const segments: string[] = []
    let current = ''
    let inSingleQuote = false
    let inDoubleQuote = false

    for (let i = 0; i < command.length; i++) {
      const char = command[i]

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote
        current += char
      } else if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote
        current += char
      } else if (char === '\\' && !inSingleQuote && command[i + 1] === '|') {
        // Escaped pipe - keep it as \|, don't split
        current += '\\|'
        i++
      } else if (char === '|' && !inSingleQuote && !inDoubleQuote) {
        // Check if it's || (logical OR) - skip if so
        if (command[i + 1] === '|') {
          current += '||'
          i++
        } else {
          segments.push(current.trim())
          current = ''
        }
      } else {
        current += char
      }
    }

    if (current.trim()) {
      segments.push(current.trim())
    }

    return segments
  }

  /**
   * Execute a pipeline of commands, passing stdout of each to stdin of next
   */
  private async executePipeline(segments: string[], options?: ExecOptions): Promise<BashResult> {
    let stdin = options?.stdin || ''
    let lastResult: BashResult | null = null

    for (const segment of segments) {
      const segmentOptions: ExecOptions = {
        ...options,
        stdin,
      }

      lastResult = await this.execute(segment, segmentOptions)

      // If command failed, stop the pipeline
      if (lastResult.exitCode !== 0) {
        return lastResult
      }

      // Pass stdout to next command's stdin
      stdin = lastResult.stdout
    }

    return lastResult!
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

    // Handle HTTP commands via native fetch API
    if (classification.capability === 'http') {
      if (cmd === 'curl') {
        return this.executeCurl(args)
      } else if (cmd === 'wget') {
        return this.executeWget(args)
      }
    }

    // Handle data processing commands
    if (TIER_1_DATA_COMMANDS.has(cmd)) {
      return this.executeDataProcessing(cmd, args, command, options)
    }

    // Handle crypto commands via Web Crypto API
    if (TIER_1_CRYPTO_COMMANDS.has(cmd)) {
      return this.executeNativeCrypto(cmd, args, options)
    }

    // Handle text processing commands (sed, awk, diff, patch, tee, xargs)
    if (TIER_1_TEXT_PROCESSING_COMMANDS.has(cmd)) {
      return this.executeTextProcessing(cmd, args, command, options)
    }

    // Handle pure computation commands
    return this.executeNativeCompute(cmd, args, options)
  }

  /**
   * Execute native filesystem operations via FsCapability (from fsx.do)
   *
   * fsx.do provides a comprehensive POSIX-like filesystem API. This method
   * uses the following fsx.do methods:
   * - read(path, { encoding: 'utf-8' }) - returns string for text operations
   * - list(path, { withFileTypes: true }) - returns Dirent[] for directory listing
   * - exists(path) - returns boolean for existence checks
   * - stat(path) - returns Stats with isFile()/isDirectory() methods
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
          // Use encoding: 'utf-8' to ensure we get strings back from fsx.do
          const contents = await Promise.all(
            args.filter(a => !a.startsWith('-')).map(f =>
              this.fs!.read(f, { encoding: 'utf-8' })
            )
          )
          stdout = contents.join('')
          break
        }

        case 'ls': {
          const path = args.find(a => !a.startsWith('-')) || '.'
          // Use withFileTypes: true to get Dirent objects from fsx.do
          const entries = await this.fs.list(path, { withFileTypes: true })
          // fsx.do returns Dirent[] when withFileTypes is true
          // Dirent has isDirectory() as a method
          stdout = (entries as Array<{ name: string; isDirectory(): boolean }>)
            .map(e => e.isDirectory() ? `${e.name}/` : e.name)
            .join('\n') + '\n'
          break
        }

        case 'head': {
          const file = args.find(a => !a.startsWith('-'))
          if (!file) return this.createResult('head', '', 'head: missing operand', 1, 1)
          const lines = parseInt(args.find(a => a.startsWith('-n'))?.slice(2) || '10', 10)
          // Use encoding: 'utf-8' to ensure we get a string back
          const content = await this.fs.read(file, { encoding: 'utf-8' }) as string
          stdout = content.split('\n').slice(0, lines).join('\n') + '\n'
          break
        }

        case 'tail': {
          const file = args.find(a => !a.startsWith('-'))
          if (!file) return this.createResult('tail', '', 'tail: missing operand', 1, 1)
          const lines = parseInt(args.find(a => a.startsWith('-n'))?.slice(2) || '10', 10)
          // Use encoding: 'utf-8' to ensure we get a string back
          const content = await this.fs.read(file, { encoding: 'utf-8' }) as string
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
              // fsx.do Stats class has isFile() as a method, not a property
              exitCode = stat.isFile() ? 0 : 1
              break
            }
            case '-d': {
              const exists = await this.fs.exists(path)
              if (!exists) { exitCode = 1; break }
              const stat = await this.fs.stat(path)
              // fsx.do Stats class has isDirectory() as a method, not a property
              exitCode = stat.isDirectory() ? 0 : 1
              break
            }
            default:
              exitCode = 2
          }
          break
        }


        // ========================================================================
        // NEW FILESYSTEM COMMANDS
        // ========================================================================

        case 'mkdir': {
          const mkdirRecursive = args.includes('-p')
          const mkdirPath = args.filter(a => !a.startsWith('-'))[0]
          if (!mkdirPath) {
            return this.createResult('mkdir', '', 'mkdir: missing operand', 1, 1)
          }
          await this.fs.mkdir(mkdirPath, { recursive: mkdirRecursive })
          break
        }

        case 'rmdir': {
          const rmdirPath = args.filter(a => !a.startsWith('-'))[0]
          if (!rmdirPath) {
            return this.createResult('rmdir', '', 'rmdir: missing operand', 1, 1)
          }
          await this.fs.rmdir(rmdirPath)
          break
        }

        case 'rm': {
          const rmRecursive = args.includes('-r') || args.includes('-rf') || args.includes('-R')
          const rmForce = args.includes('-f') || args.includes('-rf')
          const rmPaths = args.filter(a => !a.startsWith('-'))
          if (rmPaths.length === 0) {
            return this.createResult('rm', '', 'rm: missing operand', 1, 1)
          }
          for (const p of rmPaths) {
            await this.fs.rm(p, { recursive: rmRecursive, force: rmForce })
          }
          break
        }

        case 'cp': {
          const cpRecursive = args.includes('-r') || args.includes('-R')
          const cpPaths = args.filter(a => !a.startsWith('-'))
          if (cpPaths.length < 2) {
            return this.createResult('cp', '', 'cp: missing destination file operand', 1, 1)
          }
          const [cpSrc, cpDest] = cpPaths
          await this.fs.copyFile(cpSrc, cpDest, { recursive: cpRecursive })
          break
        }

        case 'mv': {
          const mvPaths = args.filter(a => !a.startsWith('-'))
          if (mvPaths.length < 2) {
            return this.createResult('mv', '', 'mv: missing destination file operand', 1, 1)
          }
          const [mvSrc, mvDest] = mvPaths
          await this.fs.rename(mvSrc, mvDest)
          break
        }

        case 'touch': {
          const touchPath = args.filter(a => !a.startsWith('-'))[0]
          if (!touchPath) {
            return this.createResult('touch', '', 'touch: missing file operand', 1, 1)
          }
          const touchNow = new Date()
          try {
            await this.fs.utimes(touchPath, touchNow, touchNow)
          } catch {
            await this.fs.write(touchPath, '')
          }
          break
        }

        case 'truncate': {
          let truncSize = 0
          let truncPath = ''
          for (let i = 0; i < args.length; i++) {
            if (args[i] === '-s' && args[i + 1]) {
              truncSize = parseInt(args[++i], 10)
            } else if (!args[i].startsWith('-')) {
              truncPath = args[i]
            }
          }
          if (!truncPath) {
            return this.createResult('truncate', '', 'truncate: missing file operand', 1, 1)
          }
          await this.fs.truncate(truncPath, truncSize)
          break
        }

        case 'stat': {
          const statPath = args.filter(a => !a.startsWith('-'))[0]
          if (!statPath) {
            return this.createResult('stat', '', 'stat: missing operand', 1, 1)
          }
          const fileStat = await this.fs.stat(statPath)
          const statLines = [
            `  File: ${statPath}`,
            `  Size: ${fileStat.size}`,
            `  Mode: ${fileStat.mode.toString(8)}`,
            `Access: ${fileStat.atime}`,
            `Modify: ${fileStat.mtime}`,
            `Change: ${fileStat.ctime}`,
          ]
          stdout = statLines.join('\n') + '\n'
          break
        }

        case 'readlink': {
          const readlinkPath = args.filter(a => !a.startsWith('-'))[0]
          if (!readlinkPath) {
            return this.createResult('readlink', '', 'readlink: missing operand', 1, 1)
          }
          const linkTarget = await this.fs.readlink(readlinkPath)
          stdout = linkTarget + '\n'
          break
        }

        case 'ln': {
          const lnSymbolic = args.includes('-s')
          const lnPaths = args.filter(a => !a.startsWith('-'))
          if (lnPaths.length < 2) {
            return this.createResult('ln', '', 'ln: missing file operand', 1, 1)
          }
          const [lnTarget, lnPath] = lnPaths
          if (lnSymbolic) {
            await this.fs.symlink(lnTarget, lnPath)
          } else {
            await this.fs.link(lnTarget, lnPath)
          }
          break
        }

        case 'chmod': {
          const chmodNonFlags = args.filter(a => !a.startsWith('-'))
          if (chmodNonFlags.length < 2) {
            return this.createResult('chmod', '', 'chmod: missing operand', 1, 1)
          }
          const [chmodModeStr, chmodPath] = chmodNonFlags
          let chmodMode: number
          if (/^[0-7]+$/.test(chmodModeStr)) {
            chmodMode = parseInt(chmodModeStr, 8)
          } else {
            return this.createResult('chmod', '', 'chmod: symbolic modes not yet supported', 1, 1)
          }
          await this.fs.chmod(chmodPath, chmodMode)
          break
        }

        case 'chown': {
          const chownNonFlags = args.filter(a => !a.startsWith('-'))
          if (chownNonFlags.length < 2) {
            return this.createResult('chown', '', 'chown: missing operand', 1, 1)
          }
          const [chownOwnerGroup, chownPath] = chownNonFlags
          const [chownUidStr, chownGidStr] = chownOwnerGroup.split(':')
          const chownUid = parseInt(chownUidStr, 10) || 0
          const chownGid = chownGidStr ? parseInt(chownGidStr, 10) || 0 : chownUid
          await this.fs.chown(chownPath, chownUid, chownGid)
          break
        }

        case 'find': {
          let findSearchPath = '.'
          let findNamePattern: string | null = null
          let findTypeFilter: 'f' | 'd' | null = null
          for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (arg === '-name' && args[i + 1]) {
              findNamePattern = args[++i]
            } else if (arg === '-type' && args[i + 1]) {
              findTypeFilter = args[++i] as 'f' | 'd'
            } else if (!arg.startsWith('-')) {
              findSearchPath = arg
            }
          }
          const findEntries = await this.fs.list(findSearchPath, { recursive: true, withFileTypes: true })
          const findResults: string[] = []
          for (const entry of findEntries as Array<{ name: string; path: string; isDirectory(): boolean; isFile(): boolean }>) {
            if (findTypeFilter === 'f' && !entry.isFile()) continue
            if (findTypeFilter === 'd' && !entry.isDirectory()) continue
            if (findNamePattern) {
              const findGlobPattern = findNamePattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')
              const findRegex = new RegExp(`^${findGlobPattern}$`)
              if (!findRegex.test(entry.name)) continue
            }
            findResults.push(entry.path || `${findSearchPath}/${entry.name}`)
          }
          stdout = findResults.join('\n') + (findResults.length ? '\n' : '')
          break
        }

        case 'grep': {
          let grepIgnoreCase = false
          let grepShowLineNumbers = false
          let grepInvertMatch = false
          let grepRecursive = false
          let grepPattern = ''
          const grepFiles: string[] = []
          for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (arg === '-i') grepIgnoreCase = true
            else if (arg === '-n') grepShowLineNumbers = true
            else if (arg === '-v') grepInvertMatch = true
            else if (arg === '-r' || arg === '-R') grepRecursive = true
            else if (!arg.startsWith('-')) {
              if (!grepPattern) grepPattern = arg
              else grepFiles.push(arg)
            }
          }
          if (!grepPattern) {
            return this.createResult('grep', '', 'grep: missing pattern', 1, 1)
          }
          const grepRegex = new RegExp(grepPattern, grepIgnoreCase ? 'i' : '')
          const grepResults: string[] = []
          let grepMatchFound = false
          const grepProcessFile = async (filePath: string) => {
            const grepContent = await this.fs!.read(filePath, { encoding: 'utf-8' }) as string
            const grepFileLines = grepContent.split('\n')
            for (let lineNum = 0; lineNum < grepFileLines.length; lineNum++) {
              const line = grepFileLines[lineNum]
              const matches = grepRegex.test(line)
              if (matches !== grepInvertMatch) {
                grepMatchFound = true
                let output = ''
                if (grepFiles.length > 1) output += `${filePath}:`
                if (grepShowLineNumbers) output += `${lineNum + 1}:`
                output += line
                grepResults.push(output)
              }
            }
          }
          if (grepFiles.length === 0) {
            const grepInput = options?.stdin || ''
            const grepInputLines = grepInput.split('\n')
            for (let lineNum = 0; lineNum < grepInputLines.length; lineNum++) {
              const line = grepInputLines[lineNum]
              const matches = grepRegex.test(line)
              if (matches !== grepInvertMatch) {
                grepMatchFound = true
                let output = ''
                if (grepShowLineNumbers) output += `${lineNum + 1}:`
                output += line
                grepResults.push(output)
              }
            }
          } else {
            for (const file of grepFiles) {
              if (grepRecursive) {
                const grepFileStat = await this.fs!.stat(file)
                if (grepFileStat.isDirectory()) {
                  const grepDirEntries = await this.fs!.list(file, { recursive: true, withFileTypes: true })
                  for (const entry of grepDirEntries as Array<{ name: string; path: string; isFile(): boolean }>) {
                    if (entry.isFile()) await grepProcessFile(entry.path || `${file}/${entry.name}`)
                  }
                } else {
                  await grepProcessFile(file)
                }
              } else {
                await grepProcessFile(file)
              }
            }
          }
          stdout = grepResults.join('\n') + (grepResults.length ? '\n' : '')
          exitCode = grepMatchFound ? 0 : 1
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
      case 'echo': {
        // Handle echo flags: -e (enable escapes), -n (no newline), -E (disable escapes)
        let enableEscapes = false
        let addNewline = true
        let startIdx = 0

        // Parse flags
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-e') {
            enableEscapes = true
            startIdx = i + 1
          } else if (args[i] === '-n') {
            addNewline = false
            startIdx = i + 1
          } else if (args[i] === '-E') {
            enableEscapes = false
            startIdx = i + 1
          } else if (args[i] === '-en' || args[i] === '-ne') {
            enableEscapes = true
            addNewline = false
            startIdx = i + 1
          } else {
            break
          }
        }

        let output = args.slice(startIdx).join(' ')
        if (enableEscapes) {
          output = output
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\r/g, '\r')
            .replace(/\\a/g, '\x07')
            .replace(/\\b/g, '\b')
            .replace(/\\f/g, '\f')
            .replace(/\\v/g, '\v')
            .replace(/\\\\/g, '\\')
        }
        stdout = output + (addNewline ? '\n' : '')
        break
      }

      case 'printf':
        // Simple printf implementation
        stdout = args.join(' ')
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\0/g, '\0')  // Handle null characters
          .replace(/\\r/g, '\r')
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

      // ========================================================================
      // MATH & CONTROL COMMANDS
      // ========================================================================

      case 'bc': {
        // bc receives expression from stdin (piped) or as a file/expression arg
        const input = options?.stdin || args.join(' ')
        const mathLib = args.includes('-l')
        const result = executeBc(input, { mathLib })
        stdout = result.result ? result.result + '\n' : ''
        exitCode = result.exitCode
        if (result.stderr) {
          return this.createResult(`${cmd} ${args.join(' ')}`, stdout, result.stderr, exitCode, 1)
        }
        break
      }

      case 'expr': {
        const result = executeExpr(args)
        stdout = result.result ? result.result + '\n' : ''
        exitCode = result.exitCode
        if (result.stderr) {
          return this.createResult(`${cmd} ${args.join(' ')}`, stdout, result.stderr, exitCode, 1)
        }
        break
      }

      case 'seq': {
        // Parse seq options: -s separator, -w equal-width, -f format
        const seqOptions: SeqOptions = {}
        const numArgs: number[] = []

        for (let i = 0; i < args.length; i++) {
          const arg = args[i]
          if (arg === '-s' && args[i + 1] !== undefined) {
            seqOptions.separator = args[++i].replace(/\\t/g, '\t').replace(/\\n/g, '\n')
          } else if (arg === '-w') {
            seqOptions.equalWidth = true
          } else if (arg === '-f' && args[i + 1] !== undefined) {
            seqOptions.format = args[++i]
          } else if (!arg.startsWith('-') || /^-?\d/.test(arg)) {
            numArgs.push(parseFloat(arg))
          }
        }

        const result = executeSeq(numArgs, seqOptions)
        stdout = result.result ? result.result + '\n' : ''
        exitCode = result.exitCode
        break
      }

      case 'shuf': {
        // Parse shuf options
        const shufOptions: ShufOptions = {}
        const input = options?.stdin || ''
        let inputLines = input.split('\n').filter(l => l.length > 0)

        for (let i = 0; i < args.length; i++) {
          const arg = args[i]
          if ((arg === '-n' || arg === '--head-count') && args[i + 1] !== undefined) {
            shufOptions.count = parseInt(args[++i], 10)
          } else if (arg.startsWith('--head-count=')) {
            shufOptions.count = parseInt(arg.slice(13), 10)
          } else if (arg === '-r' || arg === '--repeat') {
            shufOptions.replacement = true
          } else if (arg === '-e' || arg === '--echo') {
            // Collect remaining args as echo args
            shufOptions.echoArgs = args.slice(i + 1).filter(a => !a.startsWith('-') || /^-?\d/.test(a))
          } else if (arg === '-i' && args[i + 1] !== undefined) {
            const range = args[++i]
            const [start, end] = range.split('-').map(Number)
            shufOptions.inputRange = { start, end }
          } else if (arg === '-o' && args[i + 1] !== undefined) {
            shufOptions.outputFile = args[++i]
          } else if (arg.startsWith('--random-source=') || arg === '--random-source') {
            shufOptions.randomSource = arg.includes('=') ? arg.split('=')[1] : args[++i]
          }
        }

        const result = executeShuf(inputLines, shufOptions)
        stdout = result.result ? result.result + '\n' : ''
        exitCode = result.exitCode
        break
      }

      case 'sleep': {
        if (args.length === 0) {
          return this.createResult('sleep', '', 'sleep: missing operand', 1, 1)
        }
        const result = await executeSleep(args)
        exitCode = result.exitCode
        if (result.stderr) {
          return this.createResult(`${cmd} ${args.join(' ')}`, '', result.stderr, exitCode, 1)
        }
        break
      }

      case 'timeout': {
        // Parse timeout options
        const timeoutOptions: TimeoutOptions = { duration: '' }
        let commandStartIndex = -1

        for (let i = 0; i < args.length; i++) {
          const arg = args[i]
          if (arg === '-k' && args[i + 1] !== undefined) {
            timeoutOptions.killAfter = args[++i]
          } else if (arg.startsWith('--kill-after=')) {
            timeoutOptions.killAfter = arg.slice(13)
          } else if (arg === '-s' && args[i + 1] !== undefined) {
            timeoutOptions.signal = args[++i]
          } else if (arg.startsWith('--signal=')) {
            timeoutOptions.signal = arg.slice(9)
          } else if (arg === '--preserve-status') {
            timeoutOptions.preserveStatus = true
          } else if (arg === '--foreground') {
            timeoutOptions.foreground = true
          } else if (arg === '-v' || arg === '--verbose') {
            timeoutOptions.verbose = true
          } else if (!arg.startsWith('-') || /^[0-9.]/.test(arg)) {
            if (timeoutOptions.duration === '') {
              timeoutOptions.duration = arg
            } else {
              commandStartIndex = i
              break
            }
          }
        }

        if (timeoutOptions.duration === '' || commandStartIndex < 0) {
          return this.createResult('timeout', '', 'timeout: missing operand', 125, 1)
        }

        const subCommand = args.slice(commandStartIndex).join(' ')

        // Check if the sub-command is a path to a non-existent command
        // (paths like /nonexistent/cmd are not supported natively)
        const firstWord = subCommand.trim().split(/\s+/)[0]
        if (firstWord.startsWith('/')) {
          // Full path command - not supported natively
          const notFoundResult = timeoutCommandNotFound(firstWord)
          return this.createResult(`timeout ${args.join(' ')}`, '', notFoundResult.stderr, notFoundResult.exitCode, 1)
        }

        // Execute with timeout
        const result = await executeTimeout(
          timeoutOptions,
          subCommand,
          async (cmd) => {
            const subResult = await this.execute(cmd, options)
            return {
              exitCode: subResult.exitCode,
              stdout: subResult.stdout,
              stderr: subResult.stderr,
            }
          }
        )

        return this.createResult(
          `timeout ${args.join(' ')}`,
          result.stdout,
          result.stderr,
          result.exitCode,
          1
        )
      }

      default:
        throw new Error(`Unsupported native compute command: ${cmd}`)
    }

    return this.createResult(`${cmd} ${args.join(' ')}`, stdout, '', exitCode, 1)
  }

  /**
   * Execute data processing commands (jq, yq, base64, envsubst)
   */
  private async executeDataProcessing(
    cmd: string,
    args: string[],
    fullCommand: string,
    options?: ExecOptions
  ): Promise<BashResult> {
    try {
      let stdout = ''
      const stderr = ''
      const exitCode = 0

      switch (cmd) {
        case 'jq': {
          const { query, file, options: jqOptions } = parseJqArgs(args)

          // Get input from file or stdin
          let input: string
          if (file) {
            if (this.fs) {
              input = (await this.fs.read(file, { encoding: 'utf-8' })) as string
            } else {
              throw new Error(`ENOENT: no such file: ${file}`)
            }
          } else if (options?.stdin) {
            input = options.stdin
          } else {
            return this.createResult(fullCommand, '', 'jq: no input', 1, 1)
          }

          stdout = executeJq(query || '.', input, jqOptions)
          break
        }

        case 'yq': {
          const { query, file, options: yqOptions } = parseYqArgs(args)

          // Get input from file or stdin
          let input: string
          if (file) {
            if (this.fs) {
              input = (await this.fs.read(file, { encoding: 'utf-8' })) as string
            } else {
              throw new Error(`ENOENT: no such file: ${file}`)
            }
          } else if (options?.stdin) {
            input = options.stdin
          } else {
            return this.createResult(fullCommand, '', 'yq: no input', 1, 1)
          }

          stdout = executeYq(query, input, yqOptions)
          break
        }

        case 'base64': {
          const { file, options: b64Options } = parseBase64Args(args)

          // Get input from file or stdin
          let input: string
          if (file) {
            if (this.fs) {
              input = (await this.fs.read(file, { encoding: 'utf-8' })) as string
            } else {
              throw new Error(`ENOENT: no such file: ${file}`)
            }
          } else if (options?.stdin !== undefined) {
            input = options.stdin
          } else {
            // Default to empty for encode, error for decode
            if (b64Options.decode) {
              return this.createResult(fullCommand, '', 'base64: no input', 1, 1)
            }
            input = ''
          }

          stdout = executeBase64(input, b64Options)
          break
        }

        case 'envsubst': {
          // Parse args and handle input redirect
          const { options: envOptions, inputRedirect } = parseEnvsubstArgs(
            args,
            (options?.env as Record<string, string>) || {}
          )

          // Get input from redirect, stdin, or empty
          let input: string
          if (inputRedirect) {
            if (this.fs) {
              input = (await this.fs.read(inputRedirect, { encoding: 'utf-8' })) as string
            } else {
              throw new Error(`ENOENT: no such file: ${inputRedirect}`)
            }
          } else if (options?.stdin !== undefined) {
            input = options.stdin
          } else {
            input = ''
          }

          stdout = executeEnvsubst(input, envOptions)
          break
        }

        default:
          throw new Error(`Unknown data processing command: ${cmd}`)
      }

      return this.createResult(fullCommand, stdout, stderr, exitCode, 1)
    } catch (error) {
      if (error instanceof JqError) {
        return this.createResult(fullCommand, '', `jq: ${error.message}`, error.exitCode, 1)
      }
      if (error instanceof Base64Error) {
        return this.createResult(fullCommand, '', `base64: ${error.message}`, 1, 1)
      }
      if (error instanceof EnvsubstError) {
        return this.createResult(fullCommand, '', `envsubst: ${error.message}`, 1, 1)
      }
      const message = error instanceof Error ? error.message : String(error)
      return this.createResult(fullCommand, '', message, 1, 1)
    }
  }

  /**
   * Execute curl command via native fetch() API
   *
   * Supports common curl flags:
   * - -X METHOD: HTTP method (GET, POST, PUT, DELETE, etc.)
   * - -H "Header: Value": Custom headers
   * - -d "data": Request body (implies POST if no -X specified)
   * - -o filename: Output to file
   * - -s: Silent mode (suppress progress)
   * - -L: Follow redirects
   * - -u user:pass: Basic authentication
   * - -I: HEAD request (headers only)
   * - --data-raw "data": Raw data without processing
   */
  private async executeCurl(args: string[]): Promise<BashResult> {
    let method = 'GET'
    let url = ''
    const headers: Record<string, string> = {}
    let body: string | undefined
    let outputFile: string | undefined
    let silent = false
    let followRedirects = false
    let headersOnly = false
    let includeHeaders = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '-X' && args[i + 1]) {
        method = args[++i]
      } else if (arg === '-H' && args[i + 1]) {
        const headerValue = args[++i]
        const colonIndex = headerValue.indexOf(':')
        if (colonIndex > 0) {
          const key = headerValue.slice(0, colonIndex).trim()
          const val = headerValue.slice(colonIndex + 1).trim()
          headers[key] = val
        }
      } else if ((arg === '-d' || arg === '--data' || arg === '--data-raw') && args[i + 1]) {
        body = args[++i]
        // -d implies POST if method wasn't explicitly set
        if (method === 'GET') method = 'POST'
      } else if (arg === '-o' && args[i + 1]) {
        outputFile = args[++i]
      } else if (arg === '-s' || arg === '--silent') {
        silent = true
      } else if (arg === '-L' || arg === '--location') {
        followRedirects = true
      } else if (arg === '-I' || arg === '--head') {
        headersOnly = true
        method = 'HEAD'
      } else if (arg === '-i' || arg === '--include') {
        includeHeaders = true
      } else if (arg === '-u' && args[i + 1]) {
        const credentials = args[++i]
        const encoded = btoa(credentials)
        headers['Authorization'] = `Basic ${encoded}`
      } else if (!arg.startsWith('-') && !url) {
        url = arg
      }
    }

    if (!url) {
      return this.createResult('curl', '', 'curl: no URL specified', 1, 1)
    }

    // Ensure URL has protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url
    }

    try {
      const response = await fetch(url, {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body,
        redirect: followRedirects ? 'follow' : 'manual',
      })

      let output = ''

      // Build headers string if needed
      if (headersOnly || includeHeaders) {
        const headerLines = [`HTTP/1.1 ${response.status} ${response.statusText}`]
        response.headers.forEach((value, key) => {
          headerLines.push(`${key}: ${value}`)
        })
        headerLines.push('')
        output = headerLines.join('\r\n')
      }

      // Get body content (unless HEAD request)
      if (!headersOnly) {
        const content = await response.text()
        output += content
      }

      // Write to file if -o specified
      if (outputFile && this.fs) {
        await this.fs.write(outputFile, output)
        return this.createResult(`curl ${args.join(' ')}`, silent ? '' : '', '', 0, 1)
      }

      return this.createResult(`curl ${args.join(' ')}`, output, '', response.ok ? 0 : 1, 1)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.createResult(`curl ${args.join(' ')}`, '', `curl: ${message}`, 1, 1)
    }
  }

  /**
   * Execute wget command via native fetch() API
   *
   * Supports common wget flags:
   * - -O filename: Output to file (use "-" for stdout)
   * - -q: Quiet mode
   * - --header "Header: Value": Custom headers
   * - -S: Print server response headers
   * - --no-check-certificate: Skip SSL verification (ignored in fetch)
   */
  private async executeWget(args: string[]): Promise<BashResult> {
    let url = ''
    const headers: Record<string, string> = {}
    let outputFile: string | undefined
    let quiet = false
    let printHeaders = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '-O' && args[i + 1]) {
        outputFile = args[++i]
      } else if (arg === '-q' || arg === '--quiet') {
        quiet = true
      } else if (arg === '--header' && args[i + 1]) {
        const headerValue = args[++i]
        const colonIndex = headerValue.indexOf(':')
        if (colonIndex > 0) {
          const key = headerValue.slice(0, colonIndex).trim()
          const val = headerValue.slice(colonIndex + 1).trim()
          headers[key] = val
        }
      } else if (arg === '-S' || arg === '--server-response') {
        printHeaders = true
      } else if (arg === '--no-check-certificate') {
        // Ignored - fetch handles SSL automatically
      } else if (!arg.startsWith('-') && !url) {
        url = arg
      }
    }

    if (!url) {
      return this.createResult('wget', '', 'wget: missing URL', 1, 1)
    }

    // Ensure URL has protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        redirect: 'follow',
      })

      let stderr = ''

      // Print server response headers if -S
      if (printHeaders && !quiet) {
        const headerLines = [`  HTTP/1.1 ${response.status} ${response.statusText}`]
        response.headers.forEach((value, key) => {
          headerLines.push(`  ${key}: ${value}`)
        })
        stderr = headerLines.join('\n') + '\n'
      }

      const content = await response.text()

      // Determine output filename if not specified
      if (!outputFile) {
        // Extract filename from URL path
        const urlObj = new URL(url)
        const pathParts = urlObj.pathname.split('/')
        outputFile = pathParts[pathParts.length - 1] || 'index.html'
      }

      // Output to stdout if "-"
      if (outputFile === '-') {
        return this.createResult(`wget ${args.join(' ')}`, content, stderr, response.ok ? 0 : 1, 1)
      }

      // Write to file
      if (this.fs) {
        await this.fs.write(outputFile, content)
        const successMsg = quiet ? '' : `'${outputFile}' saved\n`
        return this.createResult(`wget ${args.join(' ')}`, '', stderr + successMsg, 0, 1)
      }

      // No fs available, output to stdout
      return this.createResult(`wget ${args.join(' ')}`, content, stderr, response.ok ? 0 : 1, 1)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.createResult(`wget ${args.join(' ')}`, '', `wget: ${message}`, 1, 1)
    }
  }

  /**
   * Execute crypto commands via Web Crypto API (sha256sum, md5sum, uuidgen, etc.)
   */
  private async executeNativeCrypto(
    cmd: string,
    args: string[],
    options?: ExecOptions
  ): Promise<BashResult> {
    try {
      const result = await executeCryptoCommand(cmd, args, {
        fs: this.fs,
        stdin: options?.stdin,
      })
      return this.createResult(`${cmd} ${args.join(' ')}`, result.stdout, result.stderr, result.exitCode, 1)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.createResult(`${cmd} ${args.join(' ')}`, '', message, 1, 1)
    }
  }

  /**
   * Execute text processing commands (sed, awk, diff, patch, tee, xargs)
   */
  private async executeTextProcessing(
    cmd: string,
    args: string[],
    fullCommand: string,
    options?: ExecOptions
  ): Promise<BashResult> {
    try {
      const input = options?.stdin || ''

      switch (cmd) {
        case 'sed': {
          // For sed, we need to get file content if a file is specified
          const files = args.filter(a => !a.startsWith('-') && !a.startsWith('s/') && !a.startsWith("'") && !a.startsWith('"'))
          let content = input
          if (files.length > 0 && this.fs) {
            content = await this.fs.read(files[files.length - 1], { encoding: 'utf-8' }) as string
          }
          const result = executeSed(args, content, this.fs)
          return this.createResult(fullCommand, result.stdout, result.stderr, result.exitCode, 1)
        }

        case 'awk': {
          // For awk, get file content if specified
          let content = input
          // Skip the first non-flag arg which is usually the program
          const nonFlagArgs = args.filter(a => !a.startsWith('-'))
          if (nonFlagArgs.length > 1 && this.fs) {
            // Last arg is file
            content = await this.fs.read(nonFlagArgs[nonFlagArgs.length - 1], { encoding: 'utf-8' }) as string
          }
          const result = executeAwk(args, content)
          return this.createResult(fullCommand, result.stdout, result.stderr, result.exitCode, 1)
        }

        case 'diff': {
          // diff requires two file contents
          const diffFiles = args.filter(a => !a.startsWith('-'))
          if (diffFiles.length >= 2 && this.fs) {
            const file1Content = await this.fs.read(diffFiles[0], { encoding: 'utf-8' }) as string
            const file2Content = await this.fs.read(diffFiles[1], { encoding: 'utf-8' }) as string
            const unified = args.includes('-u') || args.includes('--unified')
            const context = args.includes('-c') || args.includes('--context')
            const result = executeDiff(file1Content, file2Content, diffFiles[0], diffFiles[1], { unified, context })
            return this.createResult(fullCommand, result.stdout, result.stderr, result.exitCode, 1)
          }
          return this.createResult(fullCommand, '', 'diff: missing operand', 1, 1)
        }

        case 'patch': {
          // patch applies a diff to a file
          const reverse = args.includes('-R') || args.includes('--reverse')
          const dryRun = args.includes('--dry-run')
          let stripLevel = 0
          const stripArg = args.find(a => a.startsWith('-p'))
          if (stripArg) {
            stripLevel = parseInt(stripArg.slice(2), 10)
          }

          // Input is the patch content - parse it to find target file
          const patchContent = input
          const fileMatch = patchContent.match(/^---\s+(\S+)/m)
          const newFileMatch = patchContent.match(/^\+\+\+\s+(\S+)/m)
          let targetFile = newFileMatch?.[1] || fileMatch?.[1] || ''

          // Strip prefix from target file
          if (stripLevel > 0 && targetFile) {
            const parts = targetFile.split('/')
            targetFile = parts.slice(stripLevel).join('/')
          }

          // Resolve relative path against cwd if not absolute
          const cwd = options?.cwd || '/test'
          if (!targetFile.startsWith('/') && cwd) {
            targetFile = `${cwd.replace(/\/$/, '')}/${targetFile}`
          }

          // Read original file content
          let originalContent = ''
          if (targetFile && this.fs) {
            try {
              originalContent = await this.fs.read(targetFile, { encoding: 'utf-8' }) as string
            } catch {
              // File might not exist, continue with empty
            }
          }

          const result = executePatch(originalContent, patchContent, { reverse, dryRun, stripLevel })

          // Write result back to file if not dry run and successful
          if (!dryRun && result.exitCode === 0 && result.result && targetFile && this.fs) {
            await this.fs.write(targetFile, result.result)
          }

          return this.createResult(fullCommand, result.stdout, result.stderr, result.exitCode, 1)
        }

        case 'tee': {
          const result = await executeTee(input, args, this.fs)
          return this.createResult(fullCommand, result.stdout, result.stderr, result.exitCode, 1)
        }

        case 'xargs': {
          const result = await executeXargs(input, args, async (cmd) => {
            const subResult = await this.execute(cmd, options)
            return {
              stdout: subResult.stdout,
              stderr: subResult.stderr,
              exitCode: subResult.exitCode,
            }
          })
          return this.createResult(fullCommand, result.stdout, result.stderr, result.exitCode, 1)
        }

        default:
          throw new Error(`Unsupported text processing command: ${cmd}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.createResult(fullCommand, '', message, 1, 1)
    }
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
   * Tokenize command respecting quotes and escape sequences
   */
  private tokenize(input: string): string[] {
    const tokens: string[] = []
    let current = ''
    let inSingleQuote = false
    let inDoubleQuote = false

    for (let i = 0; i < input.length; i++) {
      const char = input[i]

      // Handle escape sequences in double quotes
      if (char === '\\' && inDoubleQuote && i + 1 < input.length) {
        const nextChar = input[i + 1]
        // Keep the escape sequence for later processing
        current += char + nextChar
        i++ // Skip the escaped character
        continue
      }

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
   * Strip outer quotes from a string and unescape inner quotes
   */
  private stripQuotes(s: string): string {
    if (s.startsWith('"') && s.endsWith('"')) {
      // Remove outer double quotes and unescape inner escaped quotes
      return s.slice(1, -1).replace(/\\"/g, '"')
    }
    if (s.startsWith("'") && s.endsWith("'")) {
      // Remove outer single quotes (no escaping in single quotes)
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
