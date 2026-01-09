/**
 * bashx Durable Object Integration Module
 *
 * Provides the BashModule class for integrating bashx capabilities into
 * dotdo Durable Objects via the WorkflowContext ($) proxy.
 *
 * @example
 * ```typescript
 * import { BashModule } from 'bashx/do'
 *
 * // In a DO class
 * class MyDO extends DO {
 *   async run() {
 *     const bash = new BashModule(this.executor)
 *     const result = await bash.exec('ls -la')
 *     console.log(result.stdout)
 *   }
 * }
 * ```
 *
 * @module bashx/do
 */

import type {
  BashResult,
  BashCapability,
  ExecOptions,
  SpawnOptions,
  SpawnHandle,
  Program,
  SafetyClassification,
  Intent,
  FsCapability,
} from '../types.js'
import { parse } from '../ast/parser.js'
import { analyze, isDangerous } from '../ast/analyze.js'

// ============================================================================
// EXECUTOR INTERFACE
// ============================================================================

/**
 * Interface for external command executors.
 *
 * BashModule delegates actual command execution to an executor,
 * which could be Cloudflare Containers, a local shell, or a mock.
 */
export interface BashExecutor {
  /**
   * Execute a command and return the result.
   */
  execute(command: string, options?: ExecOptions): Promise<BashResult>

  /**
   * Spawn a command for streaming execution (optional).
   */
  spawn?(command: string, args?: string[], options?: SpawnOptions): Promise<SpawnHandle>
}

// ============================================================================
// MODULE OPTIONS
// ============================================================================

/**
 * Options for configuring BashModule behavior.
 *
 * @example
 * ```typescript
 * const bash = new BashModule(executor, {
 *   fs: fsCapability,           // Optional FsCapability for native file ops
 *   useNativeOps: true,         // Enable native operation optimization
 * })
 * ```
 */
export interface BashModuleOptions {
  /**
   * Optional FsCapability for native file operations.
   *
   * When provided, commands like `cat`, `head`, `tail`, `ls` can be
   * executed natively using $.fs instead of spawning a subprocess.
   * This is faster (Tier 1) and works in pure Workers environments.
   */
  fs?: FsCapability

  /**
   * Whether to use native operations when available.
   * When true and fs is provided, file operations will use FsCapability.
   *
   * @default true
   */
  useNativeOps?: boolean
}

/**
 * Commands that can be executed natively via FsCapability.
 * Maps command names to their native implementation handler.
 */
const NATIVE_FS_COMMANDS = new Set(['cat', 'head', 'tail', 'ls', 'test'])

// ============================================================================
// BASH MODULE CLASS
// ============================================================================

/**
 * BashModule - Capability module for bash execution in Durable Objects.
 *
 * Implements the BashCapability interface from dotdo, providing AST-based
 * safety analysis and command execution through an external executor.
 *
 * @example
 * ```typescript
 * import { BashModule } from 'bashx/do'
 *
 * // Create with a custom executor
 * const bash = new BashModule({
 *   execute: async (cmd, opts) => {
 *     // Execute via Cloudflare Containers, RPC, etc.
 *     return await containerExecutor.run(cmd, opts)
 *   }
 * })
 *
 * // Execute commands
 * const result = await bash.exec('npm', ['install'])
 * if (result.exitCode === 0) {
 *   console.log('Dependencies installed')
 * }
 *
 * // Run scripts
 * await bash.run(`
 *   set -e
 *   npm run build
 *   npm run test
 * `)
 *
 * // Check safety
 * const check = bash.isDangerous('rm -rf /')
 * if (check.dangerous) {
 *   console.warn(check.reason)
 * }
 * ```
 */
export class BashModule implements BashCapability {
  /**
   * Capability module name identifier.
   */
  readonly name = 'bash' as const

  /**
   * The executor used for running commands.
   */
  private readonly executor: BashExecutor

  /**
   * Optional FsCapability for native file operations.
   */
  private readonly fs?: FsCapability

  /**
   * Whether to use native operations when available.
   */
  private readonly useNativeOps: boolean

  /**
   * Whether the module has been initialized.
   */
  private initialized = false

  /**
   * Create a new BashModule instance.
   *
   * @param executor - The executor to use for running commands
   * @param options - Optional configuration including FsCapability integration
   *
   * @example
   * ```typescript
   * // Basic usage
   * const bash = new BashModule(executor)
   *
   * // With FsCapability for native file operations
   * const bash = new BashModule(executor, { fs: fsCapability })
   *
   * // Disable native ops (always use executor)
   * const bash = new BashModule(executor, { fs: fsCapability, useNativeOps: false })
   * ```
   */
  constructor(executor: BashExecutor, options?: BashModuleOptions) {
    this.executor = executor
    this.fs = options?.fs
    this.useNativeOps = options?.useNativeOps ?? true
  }

  /**
   * Check if FsCapability is available and native ops are enabled.
   */
  get hasFsCapability(): boolean {
    return this.useNativeOps && this.fs !== undefined
  }

  /**
   * Initialize the module.
   * Called when the capability is first accessed.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    // Future: initialize tree-sitter WASM, etc.
    this.initialized = true
  }

  /**
   * Clean up resources.
   * Called when the capability is unloaded.
   */
  async dispose(): Promise<void> {
    // Future: cleanup resources
    this.initialized = false
  }

  /**
   * Execute a command and wait for completion.
   *
   * @param command - The command to execute (e.g., 'git', 'npm', 'ls')
   * @param args - Optional array of command arguments
   * @param options - Optional execution options
   * @returns Promise resolving to the execution result
   *
   * @example
   * ```typescript
   * // Simple command
   * const result = await bash.exec('ls')
   *
   * // With arguments
   * const result = await bash.exec('git', ['status', '--short'])
   *
   * // With options
   * const result = await bash.exec('npm', ['install'], {
   *   cwd: '/app',
   *   timeout: 60000
   * })
   * ```
   */
  async exec(command: string, args?: string[], options?: ExecOptions): Promise<BashResult> {
    // Build full command string
    const fullCommand = args && args.length > 0 ? `${command} ${args.join(' ')}` : command

    return this.executor.execute(fullCommand, options)
  }

  /**
   * Spawn a command for streaming execution.
   * Returns a handle that can be used to interact with the running process.
   *
   * @param command - The command to spawn
   * @param args - Optional array of command arguments
   * @param options - Optional spawn options including stream callbacks
   * @returns Promise resolving to a spawn handle
   *
   * @example
   * ```typescript
   * // Stream output from a long-running process
   * const handle = await bash.spawn('tail', ['-f', '/var/log/app.log'], {
   *   onStdout: (chunk) => console.log(chunk),
   *   onStderr: (chunk) => console.error(chunk)
   * })
   *
   * // Later, stop the process
   * handle.kill()
   *
   * // Wait for it to finish
   * const result = await handle.done
   * ```
   */
  async spawn(command: string, args?: string[], options?: SpawnOptions): Promise<SpawnHandle> {
    if (!this.executor.spawn) {
      throw new Error('Spawn not supported by this executor')
    }
    return this.executor.spawn(command, args, options)
  }

  /**
   * Run a shell script.
   * Executes a multi-line bash script with full shell features.
   *
   * @param script - The bash script to execute
   * @param options - Optional execution options
   * @returns Promise resolving to the execution result
   *
   * @example
   * ```typescript
   * const result = await bash.run(`
   *   set -e
   *   cd /app
   *   npm install
   *   npm run build
   *   npm run test
   * `)
   *
   * if (result.exitCode !== 0) {
   *   throw new Error('Build failed: ' + result.stderr)
   * }
   * ```
   */
  async run(script: string, options?: ExecOptions): Promise<BashResult> {
    // Execute script as a bash -c command
    return this.executor.execute(script, options)
  }

  /**
   * Parse a command without executing it.
   * Useful for validation and analysis.
   *
   * @param input - The command or script to parse
   * @returns The parsed AST program
   */
  parse(input: string): Program {
    return parse(input)
  }

  /**
   * Analyze a command for safety classification.
   * Returns the safety classification and intent without executing.
   *
   * @param input - The command or script to analyze
   * @returns Analysis result with classification and intent
   */
  analyze(input: string): { classification: SafetyClassification; intent: Intent } {
    const ast = parse(input)
    return analyze(ast)
  }

  /**
   * Check if a command is dangerous.
   * Quick safety check without full analysis.
   *
   * @param input - The command to check
   * @returns Object indicating if dangerous and why
   */
  isDangerous(input: string): { dangerous: boolean; reason?: string } {
    const ast = parse(input)
    return isDangerous(ast)
  }
}

// ============================================================================
// MIXIN FUNCTION
// ============================================================================

/**
 * Type helper for classes with bash capability.
 */
export interface WithBashCapability {
  /** The bash module for executing commands */
  readonly bash: BashModule
}

/**
 * Constructor type helper for mixin composition.
 */
export type Constructor<T = object> = new (...args: any[]) => T

/**
 * Mixin function to add bash capability to a Durable Object class.
 *
 * This mixin provides lazy initialization of the BashModule, meaning
 * the executor is only created when the `bash` property is first accessed.
 * The BashModule instance is then cached for subsequent accesses.
 *
 * @param Base - The base DO class to extend
 * @param createExecutor - Factory function to create the executor.
 *   Receives the instance as its argument, allowing access to instance
 *   properties like `env` for configuring the executor.
 * @returns Extended class with bash capability
 *
 * @example Basic usage
 * ```typescript
 * import { withBash } from 'bashx/do'
 * import { DO } from 'dotdo'
 *
 * class MyDO extends withBash(DO, (instance) => ({
 *   execute: async (cmd, opts) => {
 *     // Use instance.env.CONTAINER_SERVICE or similar
 *     return await containerService.run(cmd, opts)
 *   }
 * })) {
 *   async deploy() {
 *     const result = await this.bash.exec('npm', ['run', 'build'])
 *     return result.exitCode === 0
 *   }
 * }
 * ```
 *
 * @example With environment bindings
 * ```typescript
 * import { withBash } from 'bashx/do'
 * import { DO } from 'dotdo'
 *
 * interface Env {
 *   CONTAINER_SERVICE: Fetcher
 * }
 *
 * class MyDO extends withBash(DO<Env>, (instance) => ({
 *   execute: async (cmd, opts) => {
 *     const response = await instance.env.CONTAINER_SERVICE.fetch(
 *       'https://container/exec',
 *       { method: 'POST', body: JSON.stringify({ cmd, opts }) }
 *     )
 *     return response.json()
 *   }
 * })) {
 *   // this.bash is now available with type safety
 * }
 * ```
 *
 * @example Chaining with other mixins
 * ```typescript
 * import { withBash } from 'bashx/do'
 * import { withFs } from 'fsx/do'
 * import { DO } from 'dotdo'
 *
 * // Compose multiple capabilities
 * const BaseDO = withBash(withFs(DO, fsExecutor), bashExecutor)
 *
 * class MyDO extends BaseDO {
 *   async build() {
 *     // Access both capabilities
 *     await this.fs.write('config.json', JSON.stringify(config))
 *     await this.bash.exec('npm', ['run', 'build'])
 *   }
 * }
 * ```
 */
export function withBash<TBase extends Constructor>(
  Base: TBase,
  createExecutor: (instance: InstanceType<TBase>) => BashExecutor,
): TBase & Constructor<WithBashCapability> {
  // Use abstract class to properly type the mixin
  abstract class BashMixin extends Base implements WithBashCapability {
    private _bashModule?: BashModule

    get bash(): BashModule {
      if (!this._bashModule) {
        this._bashModule = new BashModule(createExecutor(this as InstanceType<TBase>))
      }
      return this._bashModule
    }
  }

  return BashMixin as TBase & Constructor<WithBashCapability>
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { BashResult, BashCapability, ExecOptions, SpawnOptions, SpawnHandle }
