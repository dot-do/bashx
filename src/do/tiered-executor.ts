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
  executeCryptoCommand,
} from './commands/crypto.js'
import {
  executeSed,
  executeAwk,
  executeDiff,
  executePatch,
  executeTee,
  executeXargs,
} from './commands/text-processing.js'
import {
  executeCut,
  executeSort,
  executeTr,
  executeUniq,
  executeWc,
  executeBasename,
  executeDirname,
  executeEcho,
  executePrintf,
  executeDate,
  executeDd,
  executeOd,
  type CutOptions,
  type SortOptions,
  type TrOptions,
  type UniqOptions,
  type WcOptions,
  type EchoOptions,
  type DateOptions,
  type DdOptions,
  type OdOptions,
} from './commands/posix-utils.js'
import {
  executeYes,
  executeWhoami,
  executeHostname,
  executePrintenv,
  type SystemUtilsContext,
} from './commands/system-utils.js'
import {
  parseEnvArgs,
  executeEnv,
  formatEnv,
  parseIdArgs,
  executeId,
  DEFAULT_WORKER_IDENTITY,
  parseUnameArgs,
  executeUname,
  DEFAULT_WORKER_SYSINFO,
  parseTacArgs,
  executeTac,
} from './commands/extended-utils.js'
import {
  executeTest,
  createFileInfoProvider,
} from './commands/test-command.js'
import {
  executeNpmNative,
  canExecuteNativeNpm,
  extractNpmSubcommand,
  type NpmNativeOptions,
} from './commands/npm-native.js'
import {
  detectLanguage,
  type SupportedLanguage,
  type LanguageDetectionResult,
} from '../../core/classify/language-detector.js'
import {
  LanguageRouter,
} from '../../core/classify/language-router.js'
import {
  analyzeMultiLanguageSync,
  type SandboxStrategy,
} from '../../core/safety/multi-language.js'
import {
  PolyglotExecutor,
  type LanguageBinding,
} from './executors/polyglot-executor.js'
import type { TierExecutor, LanguageExecutor } from './executors/types.js'
import { PipelineExecutor } from './pipeline/index.js'

// ============================================================================
// TYPES
// ============================================================================

/**
 * Execution tier levels
 */
export type ExecutionTier = 1 | 2 | 3 | 4

/**
 * Tier classification result.
 *
 * Contains the tier level, reason for selection, and optionally an executor
 * instance that can be called directly for polymorphic dispatch.
 */
export interface TierClassification {
  /** The tier that should handle this command */
  tier: ExecutionTier
  /** Reason for the tier selection */
  reason: string
  /** The handler that will execute the command (kept for debugging/logging) */
  handler: 'native' | 'rpc' | 'loader' | 'sandbox' | 'polyglot'
  /** Specific capability or service that will be used */
  capability?: string
  /**
   * The executor instance that will handle this command.
   *
   * When present, enables polymorphic dispatch - the caller can invoke
   * `classification.executor.execute()` directly instead of going through
   * a switch statement on the handler type.
   *
   * This field is optional for backward compatibility. If not present,
   * the caller should fall back to switch-based dispatch using the handler field.
   */
  executor?: TierExecutor | LanguageExecutor
  /**
   * Sandbox strategy for non-bash languages routed to sandbox.
   * Contains resource limits, network/filesystem restrictions based on safety analysis.
   * Only present when a non-bash language is classified for sandbox execution.
   */
  sandboxStrategy?: SandboxStrategy
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

  /**
   * Tier 1.5: Language runtime worker bindings for multi-language execution.
   * Routes language-specific commands to warm runtime workers.
   *
   * @example
   * ```typescript
   * languageWorkers: {
   *   python: env.PYX_SERVICE,
   *   ruby: env.RUBY_SERVICE,
   *   node: env.NODE_SERVICE,
   * }
   * ```
   */
  languageWorkers?: Partial<Record<SupportedLanguage, LanguageBinding>>
}

// ============================================================================
// TIER 1: NATIVE COMMANDS
// ============================================================================

/**
 * Commands that can be executed natively in-Worker via nodejs_compat_v2
 */
const TIER_1_NATIVE_COMMANDS = new Set([
  // Basic file operations (read)
  'cat', 'head', 'tail', 'ls', 'test', '[', 'stat', 'readlink', 'find', 'grep',
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
  // System utility commands (native implementations)
  'yes', 'whoami', 'hostname', 'printenv',
  // Extended utility commands (native implementations)
  'env', 'id', 'uname', 'tac',
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

/**
 * POSIX utility commands with native implementations
 * These include: cut, sort, tr, uniq, wc, basename, dirname, echo, printf, date, dd, od
 */
const TIER_1_POSIX_UTILS_COMMANDS = new Set([
  'cut', 'sort', 'tr', 'uniq', 'wc',
  'basename', 'dirname', 'echo', 'printf',
  'date', 'dd', 'od',
])

/**
 * System utility commands with native implementations
 * These include: yes, whoami, hostname, printenv
 * (sleep, seq, pwd are already handled in other command groups)
 */
const TIER_1_SYSTEM_UTILS_COMMANDS = new Set([
  'yes', 'whoami', 'hostname', 'printenv',
])

/**
 * Extended utility commands with native implementations
 * These include: env, id, uname, timeout, tac, shuf
 * Note: timeout and shuf are also in math-control, but extended-utils provides more options
 */
const TIER_1_EXTENDED_UTILS_COMMANDS = new Set([
  'env', 'id', 'uname', 'tac',
  // Note: timeout and shuf have extended implementations but also exist in math-control
])

/**
 * npm commands that can be executed natively via npmx registry client
 * These are read-only operations that don't require file system writes:
 * - npm view/info/show: Get package metadata
 * - npm search/find/s: Search packages
 *
 * More complex npm operations (install, run, etc.) go through Tier 2 RPC
 */
const TIER_1_NPM_NATIVE_COMMANDS = new Set([
  'npm',  // Will check subcommand to determine if native execution is possible
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
  pyx: {
    commands: ['python', 'python3', 'pip', 'pip3', 'pipx', 'uvx', 'pyx'],
    endpoint: 'https://pyx.do',
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
  // Compilers and runtimes (python moved to Tier 2 via pyx.do RPC)
  'gcc', 'g++', 'clang', 'rustc', 'cargo', 'go', 'ruby', 'perl',
  // System utilities (chmod/chown moved to Tier 1 via FsCapability)
  'sudo', 'su', 'chgrp',
  // Archive (gzip, tar, zip moved to Tier 1 via pako/fflate)
  // Process substitution, pipes, complex shell features
  'bash', 'sh', 'zsh',
])

// ============================================================================
// EXECUTOR ADAPTERS FOR POLYMORPHIC DISPATCH
// ============================================================================

/**
 * ExecutorAdapter - Base class for tier-specific executor adapters.
 *
 * These adapters implement TierExecutor and delegate to the TieredExecutor's
 * internal methods, enabling polymorphic dispatch from TierClassification.
 *
 * @internal
 */
abstract class ExecutorAdapter implements TierExecutor {
  protected readonly tieredExecutor: TieredExecutor
  protected readonly classification: TierClassification

  constructor(tieredExecutor: TieredExecutor, classification: TierClassification) {
    this.tieredExecutor = tieredExecutor
    this.classification = classification
  }

  abstract canExecute(command: string): boolean
  abstract execute(command: string, options?: ExecOptions): Promise<BashResult>
}

/**
 * NativeExecutorAdapter - Adapter for Tier 1 native command execution.
 * @internal
 */
class NativeExecutorAdapter extends ExecutorAdapter {
  canExecute(command: string): boolean {
    const cmd = command.split(/\s+/)[0]
    return TIER_1_NATIVE_COMMANDS.has(cmd)
  }

  async execute(command: string, options?: ExecOptions): Promise<BashResult> {
    // Access the private method via any cast - this is internal implementation
    return (this.tieredExecutor as any).executeTier1(command, this.classification, options)
  }
}

/**
 * RpcExecutorAdapter - Adapter for Tier 2 RPC command execution.
 * @internal
 */
class RpcExecutorAdapter extends ExecutorAdapter {
  canExecute(_command: string): boolean {
    return this.classification.handler === 'rpc'
  }

  async execute(command: string, options?: ExecOptions): Promise<BashResult> {
    return (this.tieredExecutor as any).executeTier2(command, this.classification, options)
  }
}

/**
 * LoaderExecutorAdapter - Adapter for Tier 3 loader command execution.
 * @internal
 */
class LoaderExecutorAdapter extends ExecutorAdapter {
  canExecute(_command: string): boolean {
    return this.classification.handler === 'loader'
  }

  async execute(command: string, options?: ExecOptions): Promise<BashResult> {
    return (this.tieredExecutor as any).executeTier3(command, this.classification, options)
  }
}

/**
 * SandboxExecutorAdapter - Adapter for Tier 4 sandbox command execution.
 * @internal
 */
class SandboxExecutorAdapter extends ExecutorAdapter {
  canExecute(_command: string): boolean {
    return true // Sandbox can execute any command
  }

  async execute(command: string, options?: ExecOptions): Promise<BashResult> {
    return (this.tieredExecutor as any).executeTier4(command, this.classification, options)
  }
}

/**
 * PolyglotExecutorAdapter - Adapter for polyglot (language runtime) execution.
 * @internal
 */
class PolyglotExecutorAdapter extends ExecutorAdapter {
  canExecute(_command: string): boolean {
    return this.classification.handler === 'polyglot'
  }

  async execute(command: string, options?: ExecOptions): Promise<BashResult> {
    return (this.tieredExecutor as any).executePolyglot(command, this.classification, options)
  }
}

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
/**
 * LRU cache for tier classification results.
 * Caches command-name-based classifications to avoid repeated lookups.
 *
 * @internal
 */
class ClassificationCache {
  private readonly cache = new Map<string, TierClassification>()
  private readonly maxSize: number

  constructor(maxSize = 1000) {
    this.maxSize = maxSize
  }

  get(key: string): TierClassification | undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      // Move to end for LRU behavior
      this.cache.delete(key)
      this.cache.set(key, value)
    }
    return value
  }

  set(key: string, value: TierClassification): void {
    // Evict oldest entry if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }
    this.cache.set(key, value)
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }
}

/**
 * Metrics for tier usage tracking.
 *
 * Tracks execution counts and timing per tier to help with
 * performance analysis and optimization decisions.
 */
export interface TierMetrics {
  /** Total classifications performed */
  totalClassifications: number
  /** Classifications served from cache */
  cacheHits: number
  /** Classifications computed fresh */
  cacheMisses: number
  /** Execution counts per tier */
  tierCounts: Record<ExecutionTier, number>
  /** Execution counts per handler type */
  handlerCounts: Record<string, number>
  /** Cache hit ratio (0-1) */
  cacheHitRatio: number
}

export class TieredExecutor implements BashExecutor {
  private readonly fs?: FsCapability
  private readonly rpcBindings: Record<string, RpcServiceBinding>
  private readonly workerLoaders: Record<string, WorkerLoaderBinding>
  private readonly sandbox?: SandboxBinding
  private readonly defaultTimeout: number
  /** @internal Reserved for future optimization strategy selection */
  public readonly preferFaster: boolean
  private readonly languageWorkers: Partial<Record<SupportedLanguage, LanguageBinding>>
  private readonly polyglotExecutor?: PolyglotExecutor
  private readonly pipelineExecutor: PipelineExecutor
  private readonly languageRouter: LanguageRouter

  // Caching infrastructure
  private readonly classificationCache: ClassificationCache
  private readonly languageDetectionCache = new Map<string, LanguageDetectionResult>()
  private readonly languageDetectionCacheMaxSize = 500

  // Metrics tracking
  private metricsEnabled = false
  private totalClassifications = 0
  private cacheHits = 0
  private cacheMisses = 0
  private readonly tierCounts: Record<ExecutionTier, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
  private readonly handlerCounts: Record<string, number> = {}

  // Pre-computed lookup sets for fast-path optimization
  private readonly rpcCommandSet: Set<string>

  constructor(config: TieredExecutorConfig) {
    this.fs = config.fs
    this.rpcBindings = config.rpcBindings ?? {}
    this.workerLoaders = config.workerLoaders ?? {}
    this.sandbox = config.sandbox
    this.defaultTimeout = config.defaultTimeout ?? 30000
    this.preferFaster = config.preferFaster ?? true
    this.languageWorkers = config.languageWorkers ?? {}
    this.languageRouter = new LanguageRouter()

    // Initialize PolyglotExecutor if language workers are configured
    if (Object.keys(this.languageWorkers).length > 0) {
      this.polyglotExecutor = new PolyglotExecutor({
        bindings: this.languageWorkers,
        defaultTimeout: this.defaultTimeout,
      })
    }

    // Initialize PipelineExecutor with a bound executor function
    // This allows pipeline orchestration to be separated from command execution
    this.pipelineExecutor = new PipelineExecutor(
      (cmd, opts) => this.executeSingleCommand(cmd, opts)
    )

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

    // Initialize classification cache
    this.classificationCache = new ClassificationCache(1000)

    // Pre-compute RPC command set for O(1) lookups in hot path
    this.rpcCommandSet = new Set<string>()
    for (const binding of Object.values(this.rpcBindings)) {
      for (const cmd of binding.commands) {
        this.rpcCommandSet.add(cmd)
      }
    }
  }

  // ============================================================================
  // METRICS AND CACHE MANAGEMENT
  // ============================================================================

  /**
   * Enable metrics collection for tier usage analysis.
   * When enabled, tracks classification counts, cache hits, and tier usage.
   */
  enableMetrics(): void {
    this.metricsEnabled = true
  }

  /**
   * Disable metrics collection.
   */
  disableMetrics(): void {
    this.metricsEnabled = false
  }

  /**
   * Get current tier usage metrics.
   *
   * @returns TierMetrics with counts and cache statistics
   *
   * @example
   * ```typescript
   * executor.enableMetrics()
   * await executor.execute('echo hello')
   * await executor.execute('echo world')
   * const metrics = executor.getMetrics()
   * console.log(metrics.cacheHitRatio) // 0.5 (second call hit cache)
   * ```
   */
  getMetrics(): TierMetrics {
    const total = this.cacheHits + this.cacheMisses
    return {
      totalClassifications: this.totalClassifications,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      tierCounts: { ...this.tierCounts },
      handlerCounts: { ...this.handlerCounts },
      cacheHitRatio: total > 0 ? this.cacheHits / total : 0,
    }
  }

  /**
   * Reset all metrics to zero.
   */
  resetMetrics(): void {
    this.totalClassifications = 0
    this.cacheHits = 0
    this.cacheMisses = 0
    this.tierCounts[1] = 0
    this.tierCounts[2] = 0
    this.tierCounts[3] = 0
    this.tierCounts[4] = 0
    for (const key of Object.keys(this.handlerCounts)) {
      delete this.handlerCounts[key]
    }
  }

  /**
   * Clear all caches (classification and language detection).
   * Useful for testing or when configuration changes.
   */
  clearCaches(): void {
    this.classificationCache.clear()
    this.languageDetectionCache.clear()
  }

  /**
   * Get cache statistics for debugging.
   */
  getCacheStats(): { classificationCacheSize: number; languageDetectionCacheSize: number } {
    return {
      classificationCacheSize: this.classificationCache.size,
      languageDetectionCacheSize: this.languageDetectionCache.size,
    }
  }

  /**
   * Detect the language of a command or code input.
   * Results are cached for performance.
   *
   * @param input - The command or code to analyze
   * @returns Language detection result with language, confidence, and method
   */
  detectLanguage(input: string): LanguageDetectionResult {
    // Check cache first
    const cached = this.languageDetectionCache.get(input)
    if (cached !== undefined) {
      return cached
    }

    // Compute and cache result
    const result = detectLanguage(input)

    // LRU eviction for language detection cache
    if (this.languageDetectionCache.size >= this.languageDetectionCacheMaxSize) {
      const firstKey = this.languageDetectionCache.keys().next().value
      if (firstKey !== undefined) {
        this.languageDetectionCache.delete(firstKey)
      }
    }
    this.languageDetectionCache.set(input, result)

    return result
  }

  /**
   * Check if a language worker is available.
   *
   * @param language - The language to check
   * @returns true if a worker is configured for the language
   */
  hasLanguageWorker(language: SupportedLanguage): boolean {
    return this.languageWorkers[language] !== undefined
  }

  /**
   * Get list of languages with configured workers.
   *
   * @returns Array of language names with workers
   */
  getAvailableLanguages(): SupportedLanguage[] {
    return Object.keys(this.languageWorkers).filter(
      (key) => this.languageWorkers[key as SupportedLanguage] !== undefined
    ) as SupportedLanguage[]
  }

  /**
   * Create an executor adapter for a classification.
   *
   * This method attaches the appropriate executor instance to the classification,
   * enabling polymorphic dispatch. The executor can be called directly via
   * `classification.executor.execute()` instead of using a switch statement.
   *
   * @param classification - The base classification without executor
   * @returns The classification with executor attached
   * @internal
   */
  private withExecutor(classification: Omit<TierClassification, 'executor'>): TierClassification {
    let executor: TierExecutor | LanguageExecutor | undefined

    switch (classification.handler) {
      case 'native':
        executor = new NativeExecutorAdapter(this, classification as TierClassification)
        break
      case 'rpc':
        executor = new RpcExecutorAdapter(this, classification as TierClassification)
        break
      case 'loader':
        executor = new LoaderExecutorAdapter(this, classification as TierClassification)
        break
      case 'sandbox':
        executor = new SandboxExecutorAdapter(this, classification as TierClassification)
        break
      case 'polyglot':
        executor = new PolyglotExecutorAdapter(this, classification as TierClassification)
        break
    }

    return {
      ...classification,
      executor,
    }
  }

  /**
   * Classify a command to determine which tier should execute it.
   *
   * For non-bash languages that route to sandbox (Tier 4), this method
   * performs safety analysis to determine appropriate resource limits
   * via the sandboxStrategy field.
   *
   * Results are cached based on the command name for fast repeated lookups.
   * Commands that depend on arguments (like `npm`) bypass the cache.
   *
   * @param command - The command to classify
   * @returns TierClassification with tier level, handler info, and optional sandboxStrategy
   *
   * @example
   * ```typescript
   * // Bash command - no sandboxStrategy
   * const bashClass = executor.classifyCommand('ls -la')
   * // bashClass.sandboxStrategy === undefined
   *
   * // Python command without worker - includes sandboxStrategy
   * const pyClass = executor.classifyCommand('python -c "eval(input())"')
   * // pyClass.sandboxStrategy.network === 'none' (dangerous pattern detected)
   * ```
   */
  classifyCommand(command: string): TierClassification {
    // Track metrics
    if (this.metricsEnabled) {
      this.totalClassifications++
    }

    const cmd = this.extractCommandName(command)

    // Fast path: Check cache for command-name-based classifications
    // Note: Some commands (like npm) depend on args, so they use full command as key
    const cacheKey = this.getCacheKey(cmd, command)
    const cached = this.classificationCache.get(cacheKey)
    if (cached !== undefined) {
      if (this.metricsEnabled) {
        this.cacheHits++
        this.tierCounts[cached.tier]++
        this.handlerCounts[cached.handler] = (this.handlerCounts[cached.handler] || 0) + 1
      }
      return cached
    }

    if (this.metricsEnabled) {
      this.cacheMisses++
    }

    // Compute classification
    const classification = this.classifyCommandInternal(cmd, command)

    // Track metrics
    if (this.metricsEnabled) {
      this.tierCounts[classification.tier]++
      this.handlerCounts[classification.handler] = (this.handlerCounts[classification.handler] || 0) + 1
    }

    // Cache the result (unless it involves safety analysis which is command-specific)
    if (!classification.sandboxStrategy) {
      this.classificationCache.set(cacheKey, classification)
    }

    return classification
  }

  /**
   * Generate cache key for a command.
   * Most commands only need the command name, but some (like npm) depend on subcommands.
   *
   * @internal
   */
  private getCacheKey(cmd: string, fullCommand: string): string {
    // Commands that need full command for cache key (subcommand-dependent)
    if (cmd === 'npm' || cmd === 'python' || cmd === 'python3') {
      return fullCommand.trim()
    }
    // Most commands can be cached by name alone
    return cmd
  }

  /**
   * Internal classification logic (without caching).
   *
   * @internal
   */
  private classifyCommandInternal(cmd: string, command: string): TierClassification {
    // ========================================================================
    // FAST PATH: Tier 1 Native Commands (most common)
    // ========================================================================
    // Use Set.has() for O(1) lookup - this is the hot path
    if (TIER_1_NATIVE_COMMANDS.has(cmd)) {
      return this.classifyTier1Command(cmd, command)
    }

    // Check if npm command can be executed natively via npmx registry client
    // This handles simple read-only operations like npm view, npm search
    if (TIER_1_NPM_NATIVE_COMMANDS.has(cmd)) {
      const args = this.extractArgs(command)
      if (canExecuteNativeNpm(args)) {
        const subcommand = extractNpmSubcommand(command)
        return this.withExecutor({
          tier: 1,
          reason: `Native npm registry operation via npmx (${subcommand})`,
          handler: 'native',
          capability: 'npm-native',
        })
      }
      // Fall through to Tier 2 RPC for complex npm operations
    }

    // ========================================================================
    // Tier 1.5: Polyglot (language workers)
    // ========================================================================
    // Use LanguageRouter for unified language detection and routing
    const availableWorkers = this.getAvailableLanguages()
    const routingResult = this.languageRouter.route(command, availableWorkers)

    // Route non-bash languages based on worker availability
    if (routingResult.language !== 'bash') {
      if (routingResult.routeTo === 'polyglot' && routingResult.worker) {
        const reason = routingResult.packageManager
          ? `polyglot execution via ${routingResult.language} worker (${routingResult.packageManager})`
          : `polyglot execution via ${routingResult.language} worker`
        return this.withExecutor({
          tier: 2, // Using tier 2 slot since there's no 1.5 in ExecutionTier type
          reason,
          handler: 'polyglot',
          capability: routingResult.language,
        })
      } else {
        // No language worker configured for this language - skip RPC and go to sandbox
        // Perform safety analysis to determine sandbox resource limits
        return this.classifyForSandboxWithSafetyAnalysis(
          command,
          routingResult.language
        )
      }
    }

    // Handle package managers that route to polyglot (e.g., pip -> python worker)
    if (routingResult.packageManager && routingResult.routeTo === 'polyglot' && routingResult.worker) {
      return this.withExecutor({
        tier: 2,
        reason: `polyglot execution via ${routingResult.language} worker (${routingResult.packageManager})`,
        handler: 'polyglot',
        capability: routingResult.language,
      })
    }

    // ========================================================================
    // Tier 2: RPC service commands
    // ========================================================================
    // Use pre-computed Set for O(1) lookup instead of iterating bindings
    if (this.rpcCommandSet.has(cmd)) {
      // Find the specific service (still need to iterate for service name)
      for (const [serviceName, binding] of Object.entries(this.rpcBindings)) {
        if (binding.commands.includes(cmd)) {
          return this.withExecutor({
            tier: 2,
            reason: `RPC service available (${serviceName})`,
            handler: 'rpc',
            capability: serviceName,
          })
        }
      }
    }

    // ========================================================================
    // Tier 3: Worker loaders
    // ========================================================================
    const workerLoaderMatch = this.matchWorkerLoader(command)
    if (workerLoaderMatch) {
      return this.withExecutor({
        tier: 3,
        reason: `Dynamic npm module available (${workerLoaderMatch})`,
        handler: 'loader',
        capability: workerLoaderMatch,
      })
    }

    // ========================================================================
    // Tier 4: Sandbox (fallback)
    // ========================================================================
    return this.withExecutor({
      tier: 4,
      reason: TIER_4_SANDBOX_COMMANDS.has(cmd)
        ? `Requires Linux sandbox (${cmd})`
        : 'No higher tier available for this command',
      handler: 'sandbox',
      capability: 'container',
    })
  }

  /**
   * Classify a Tier 1 native command based on its capability type.
   * This is extracted for readability and to keep the hot path lean.
   *
   * @internal
   */
  private classifyTier1Command(cmd: string, _command: string): TierClassification {
    // Filesystem commands - need to check if fs capability is available
    if (TIER_1_FS_COMMANDS.has(cmd)) {
      if (this.fs) {
        return this.withExecutor({
          tier: 1,
          reason: `Native filesystem operation via FsCapability`,
          handler: 'native',
          capability: 'fs',
        })
      }
      // Fall through to sandbox if no fs capability
      return this.withExecutor({
        tier: 4,
        reason: 'Filesystem command requires FsCapability (not available)',
        handler: 'sandbox',
        capability: 'container',
      })
    }

    // HTTP commands via native fetch API
    if (TIER_1_HTTP_COMMANDS.has(cmd)) {
      return this.withExecutor({
        tier: 1,
        reason: `Native HTTP operation via fetch API (${cmd})`,
        handler: 'native',
        capability: 'http',
      })
    }

    // Data processing commands (jq, yq, base64, envsubst)
    if (TIER_1_DATA_COMMANDS.has(cmd)) {
      return this.withExecutor({
        tier: 1,
        reason: `Native data processing command (${cmd})`,
        handler: 'native',
        capability: cmd, // Use command name as capability
      })
    }

    // Crypto commands via Web Crypto API
    if (TIER_1_CRYPTO_COMMANDS.has(cmd)) {
      return this.withExecutor({
        tier: 1,
        reason: `Native crypto command via Web Crypto API (${cmd})`,
        handler: 'native',
        capability: 'crypto',
      })
    }

    // Text processing commands (sed, awk, diff, patch, tee, xargs)
    if (TIER_1_TEXT_PROCESSING_COMMANDS.has(cmd)) {
      return this.withExecutor({
        tier: 1,
        reason: `Native text processing command (${cmd})`,
        handler: 'native',
        capability: 'text',
      })
    }

    // POSIX utility commands
    if (TIER_1_POSIX_UTILS_COMMANDS.has(cmd)) {
      return this.withExecutor({
        tier: 1,
        reason: `Native POSIX utility command (${cmd})`,
        handler: 'native',
        capability: 'posix',
      })
    }

    // System utility commands
    if (TIER_1_SYSTEM_UTILS_COMMANDS.has(cmd)) {
      return this.withExecutor({
        tier: 1,
        reason: `Native system utility command (${cmd})`,
        handler: 'native',
        capability: 'system',
      })
    }

    // Extended utility commands
    if (TIER_1_EXTENDED_UTILS_COMMANDS.has(cmd)) {
      return this.withExecutor({
        tier: 1,
        reason: `Native extended utility command (${cmd})`,
        handler: 'native',
        capability: 'extended',
      })
    }

    // Pure computation commands (default for Tier 1)
    return this.withExecutor({
      tier: 1,
      reason: `Pure computation command (${cmd})`,
      handler: 'native',
      capability: 'compute',
    })
  }

  /**
   * Create a Tier 4 (sandbox) classification with multi-language safety analysis.
   *
   * This helper performs safety analysis for non-bash languages to determine
   * appropriate sandbox resource limits based on detected dangerous patterns.
   *
   * @param command - The command being classified
   * @param language - The detected programming language
   * @returns TierClassification with sandboxStrategy included
   */
  private classifyForSandboxWithSafetyAnalysis(
    command: string,
    language: SupportedLanguage
  ): TierClassification {
    const safetyAnalysis = analyzeMultiLanguageSync(command)
    return this.withExecutor({
      tier: 4,
      reason: `No language worker for ${language}, using sandbox`,
      handler: 'sandbox',
      capability: 'container',
      sandboxStrategy: safetyAnalysis.sandboxStrategy,
    })
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

    // Delegate to PipelineExecutor for all commands (handles both pipelines and single commands)
    return this.pipelineExecutor.execute(command, options)
  }

  /**
   * Execute a single command (no pipeline handling).
   * This is called by the PipelineExecutor for each segment.
   *
   * Uses polymorphic dispatch when an executor is present in the classification,
   * falling back to switch-based dispatch for backward compatibility.
   */
  private async executeSingleCommand(command: string, options?: ExecOptions): Promise<BashResult> {
    const classification = this.classifyCommand(command)

    try {
      // Polymorphic dispatch: use the executor instance if present
      // This is the preferred execution path - no switch statement needed
      if (classification.executor) {
        // Handle LanguageExecutor (polyglot) separately since it has a different signature
        if (classification.handler === 'polyglot') {
          return await this.executePolyglot(command, classification, options)
        }
        // TierExecutor can be called directly - type assertion needed since
        // the executor type is TierExecutor | LanguageExecutor but we've
        // already handled LanguageExecutor case above
        const executor = classification.executor as TierExecutor
        return await executor.execute(command, options)
      }

      // Fallback: switch-based dispatch for backward compatibility
      // This path is kept for cases where executor might not be set
      if (classification.handler === 'polyglot') {
        return await this.executePolyglot(command, classification, options)
      }

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
   * Execute a command via the PolyglotExecutor (Tier 1.5).
   * Routes to language-specific warm runtime workers.
   * Falls back to sandbox on RPC failure.
   */
  private async executePolyglot(
    command: string,
    classification: TierClassification,
    options?: ExecOptions
  ): Promise<BashResult> {
    const language = classification.capability as SupportedLanguage
    if (!language) {
      throw new Error('No language specified for polyglot execution')
    }

    if (!this.polyglotExecutor) {
      throw new Error('PolyglotExecutor not initialized')
    }

    try {
      const result = await this.polyglotExecutor.execute(command, language, options)

      // Check if the result indicates an RPC failure that should trigger fallback
      if (result.exitCode !== 0 && result.stderr?.includes('Network error')) {
        // RPC failed - throw to trigger fallback to sandbox
        throw new Error(`Polyglot RPC failed: ${result.stderr}`)
      }

      // Enhance result with polyglot-specific classification info
      return {
        ...result,
        classification: {
          ...result.classification,
          handler: 'polyglot',
          language,
          reason: `polyglot execution via ${language} worker`,
        } as typeof result.classification & { handler: string; language: string },
      }
    } catch (error) {
      // If sandbox is available, fall back to it
      if (this.sandbox) {
        console.warn(
          `Polyglot execution failed for "${command}", falling back to sandbox:`,
          error
        )
        return this.executeTier4(command, { ...classification, tier: 4, handler: 'sandbox' }, options)
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

    // Handle POSIX utility commands (cut, sort, tr, uniq, wc, basename, dirname, echo, printf, date, dd, od)
    if (TIER_1_POSIX_UTILS_COMMANDS.has(cmd)) {
      return this.executePosixUtils(cmd, args, command, options)
    }

    // Handle system utility commands (yes, whoami, hostname, printenv)
    if (TIER_1_SYSTEM_UTILS_COMMANDS.has(cmd)) {
      return this.executeSystemUtilsCommands(cmd, args, command, options)
    }

    // Handle extended utility commands (env, id, uname, tac)
    if (TIER_1_EXTENDED_UTILS_COMMANDS.has(cmd)) {
      return this.executeExtendedUtilsCommands(cmd, args, command, options)
    }

    // Handle npm native commands via npmx registry client
    if (classification.capability === 'npm-native') {
      return this.executeNpmNative(cmd, args, command, options)
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
      let stderr = ''
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
          // Parse options: -n N, -n -N (exclude last N), -q (quiet, no headers)
          let headQuiet = false
          let headLines = 10
          let headExcludeLast = false
          const headFiles: string[] = []
          for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (arg === '-q' || arg === '--quiet' || arg === '--silent') {
              headQuiet = true
            } else if (arg === '-n' && args[i + 1]) {
              const nArg = args[++i]
              if (nArg.startsWith('-')) {
                // -n -N means exclude last N lines
                headExcludeLast = true
                headLines = parseInt(nArg.slice(1), 10)
              } else {
                headLines = parseInt(nArg, 10)
              }
            } else if (arg.startsWith('-n')) {
              const nArg = arg.slice(2)
              if (nArg.startsWith('-')) {
                headExcludeLast = true
                headLines = parseInt(nArg.slice(1), 10)
              } else {
                headLines = parseInt(nArg, 10)
              }
            } else if (!arg.startsWith('-')) {
              headFiles.push(arg)
            }
          }
          if (headFiles.length === 0) {
            // Read from stdin
            const stdinContent = options?.stdin || ''
            const stdinLines = stdinContent.split('\n')
            if (headExcludeLast) {
              // Exclude last N lines
              stdout = stdinLines.slice(0, -headLines).join('\n') + '\n'
            } else {
              stdout = stdinLines.slice(0, headLines).join('\n') + '\n'
            }
          } else {
            const results: string[] = []
            for (let fi = 0; fi < headFiles.length; fi++) {
              const file = headFiles[fi]
              const content = await this.fs.read(file, { encoding: 'utf-8' }) as string
              const fileLines = content.split('\n')
              let selectedLines: string[]
              if (headExcludeLast) {
                selectedLines = fileLines.slice(0, -headLines)
              } else {
                selectedLines = fileLines.slice(0, headLines)
              }
              // Add header if multiple files and not quiet
              if (headFiles.length > 1 && !headQuiet) {
                if (fi > 0) results.push('')
                results.push(`==> ${file} <==`)
              }
              results.push(...selectedLines)
            }
            stdout = results.join('\n') + '\n'
          }
          break
        }

        case 'tail': {
          // Parse options: -n N, -n +N (start from line N), -q (quiet, no headers)
          let tailQuiet = false
          let tailLines = 10
          let tailStartFrom = false // +N means start from line N
          const tailFiles: string[] = []
          for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (arg === '-q' || arg === '--quiet' || arg === '--silent') {
              tailQuiet = true
            } else if (arg === '-n' && args[i + 1]) {
              const nArg = args[++i]
              if (nArg.startsWith('+')) {
                // -n +N means start from line N (1-indexed)
                tailStartFrom = true
                tailLines = parseInt(nArg.slice(1), 10)
              } else {
                tailLines = parseInt(nArg, 10)
              }
            } else if (arg.startsWith('-n')) {
              const nArg = arg.slice(2)
              if (nArg.startsWith('+')) {
                tailStartFrom = true
                tailLines = parseInt(nArg.slice(1), 10)
              } else {
                tailLines = parseInt(nArg, 10)
              }
            } else if (!arg.startsWith('-')) {
              tailFiles.push(arg)
            }
          }
          if (tailFiles.length === 0) {
            // Read from stdin
            const stdinContent = options?.stdin || ''
            const stdinLines = stdinContent.split('\n')
            const effectiveStdinLines = stdinLines[stdinLines.length - 1] === '' ? stdinLines.slice(0, -1) : stdinLines
            if (tailStartFrom) {
              // +N means output starting from line N (1-indexed)
              stdout = effectiveStdinLines.slice(tailLines - 1).join('\n') + '\n'
            } else {
              stdout = effectiveStdinLines.slice(-tailLines).join('\n') + '\n'
            }
          } else {
            const results: string[] = []
            for (let fi = 0; fi < tailFiles.length; fi++) {
              const file = tailFiles[fi]
              const content = await this.fs.read(file, { encoding: 'utf-8' }) as string
              const allLines = content.split('\n')
              const effectiveLines = allLines[allLines.length - 1] === '' ? allLines.slice(0, -1) : allLines
              let selectedLines: string[]
              if (tailStartFrom) {
                selectedLines = effectiveLines.slice(tailLines - 1)
              } else {
                selectedLines = effectiveLines.slice(-tailLines)
              }
              // Add header if multiple files and not quiet
              if (tailFiles.length > 1 && !tailQuiet) {
                if (fi > 0) results.push('')
                results.push(`==> ${file} <==`)
              }
              results.push(...selectedLines)
            }
            stdout = results.join('\n') + '\n'
          }
          break
        }

        case 'test':
        case '[': {
          // Full test/[ implementation with all POSIX operators
          const fileInfoProvider = this.fs ? createFileInfoProvider(this.fs) : undefined
          const result = await executeTest(args, fileInfoProvider)
          exitCode = result.exitCode
          if (result.stderr) {
            stderr = result.stderr
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
          let grepPerlRegex = false // -P flag: use JavaScript regex (supports lookahead, non-greedy, etc.)
          let grepPattern = ''
          const grepFiles: string[] = []
          for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (arg === '-i') grepIgnoreCase = true
            else if (arg === '-n') grepShowLineNumbers = true
            else if (arg === '-v') grepInvertMatch = true
            else if (arg === '-r' || arg === '-R') grepRecursive = true
            else if (arg === '-P') grepPerlRegex = true // Enable Perl-compatible regex (JavaScript regex)
            else if (!arg.startsWith('-')) {
              if (!grepPattern) grepPattern = arg
              else grepFiles.push(arg)
            }
          }
          if (!grepPattern) {
            return this.createResult('grep', '', 'grep: missing pattern', 1, 1)
          }
          // When -P is used, pattern is already JavaScript regex syntax
          // When -P is not used, convert basic grep pattern to JavaScript regex
          let grepRegexPattern = grepPattern
          if (!grepPerlRegex) {
            // Basic grep uses BRE (Basic Regular Expression)
            // In BRE, () {} + ? | need to be escaped to be special
            // For simplicity, we treat the pattern as-is since JavaScript regex is close to ERE
            grepRegexPattern = grepPattern
          }
          const grepRegex = new RegExp(grepRegexPattern, grepIgnoreCase ? 'i' : '')
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

      return this.createResult(`${cmd} ${args.join(' ')}`, stdout, stderr, exitCode, 1)
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
   * Execute POSIX utility commands (cut, sort, tr, uniq, wc, basename, dirname, echo, printf, date, dd, od)
   */
  private async executePosixUtils(
    cmd: string,
    args: string[],
    fullCommand: string,
    options?: ExecOptions
  ): Promise<BashResult> {
    try {
      const input = options?.stdin || ''

      switch (cmd) {
        case 'cut': {
          // Parse cut options
          const cutOptions: CutOptions = {}
          for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (arg === '-b' && args[i + 1]) {
              cutOptions.bytes = args[++i]
            } else if (arg.startsWith('-b')) {
              cutOptions.bytes = arg.slice(2)
            } else if (arg === '-c' && args[i + 1]) {
              cutOptions.chars = args[++i]
            } else if (arg.startsWith('-c')) {
              cutOptions.chars = arg.slice(2)
            } else if (arg === '-f' && args[i + 1]) {
              cutOptions.fields = args[++i]
            } else if (arg.startsWith('-f')) {
              cutOptions.fields = arg.slice(2)
            } else if (arg === '-d' && args[i + 1]) {
              cutOptions.delimiter = args[++i]
            } else if (arg.startsWith('-d')) {
              cutOptions.delimiter = arg.slice(2)
            } else if (arg === '--output-delimiter' && args[i + 1]) {
              cutOptions.outputDelimiter = args[++i]
            } else if (arg === '-s' || arg === '--only-delimited') {
              cutOptions.onlyDelimited = true
            } else if (arg === '--complement') {
              cutOptions.complement = true
            }
          }
          const stdout = executeCut(input, cutOptions)
          return this.createResult(fullCommand, stdout, '', 0, 1)
        }

        case 'sort': {
          // Parse sort options
          const sortOptions: SortOptions = {}
          for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (arg === '-n' || arg === '--numeric-sort') {
              sortOptions.numeric = true
            } else if (arg === '-r' || arg === '--reverse') {
              sortOptions.reverse = true
            } else if (arg === '-u' || arg === '--unique') {
              sortOptions.unique = true
            } else if (arg === '-f' || arg === '--ignore-case') {
              sortOptions.ignoreCase = true
            } else if (arg === '-b' || arg === '--ignore-leading-blanks') {
              sortOptions.ignoreLeadingBlanks = true
            } else if (arg === '-h' || arg === '--human-numeric-sort') {
              sortOptions.humanNumeric = true
            } else if (arg === '-c' || arg === '--check') {
              sortOptions.check = true
            } else if (arg === '-k' && args[i + 1]) {
              sortOptions.key = args[++i]
            } else if (arg.startsWith('-k')) {
              sortOptions.key = arg.slice(2)
            } else if (arg === '-t' && args[i + 1]) {
              sortOptions.separator = args[++i]
            } else if (arg.startsWith('-t')) {
              sortOptions.separator = arg.slice(2)
            }
          }
          const lines = input.split('\n').filter((l, i, arr) => i < arr.length - 1 || l !== '')
          const sorted = executeSort(lines, sortOptions)
          const stdout = sorted.join('\n') + (sorted.length > 0 ? '\n' : '')
          return this.createResult(fullCommand, stdout, '', 0, 1)
        }

        case 'tr': {
          // Parse tr options
          const trOptions: TrOptions = {}
          let set1 = ''
          let set2: string | undefined
          const nonFlagArgs: string[] = []

          for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (arg === '-d' || arg === '--delete') {
              trOptions.delete = true
            } else if (arg === '-s' || arg === '--squeeze-repeats') {
              trOptions.squeeze = true
            } else if (arg === '-c' || arg === '-C' || arg === '--complement') {
              trOptions.complement = true
            } else if (!arg.startsWith('-')) {
              nonFlagArgs.push(arg)
            }
          }

          set1 = nonFlagArgs[0] || ''
          set2 = nonFlagArgs[1]

          const stdout = executeTr(input, set1, set2, trOptions)
          return this.createResult(fullCommand, stdout, '', 0, 1)
        }

        case 'uniq': {
          // Parse uniq options
          const uniqOptions: UniqOptions = {}
          for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (arg === '-c' || arg === '--count') {
              uniqOptions.count = true
            } else if (arg === '-d' || arg === '--repeated') {
              uniqOptions.repeated = true
            } else if (arg === '-u' || arg === '--unique') {
              uniqOptions.unique = true
            } else if (arg === '-i' || arg === '--ignore-case') {
              uniqOptions.ignoreCase = true
            } else if (arg === '-f' && args[i + 1]) {
              uniqOptions.skipFields = parseInt(args[++i], 10)
            } else if (arg.startsWith('-f')) {
              uniqOptions.skipFields = parseInt(arg.slice(2), 10)
            } else if (arg === '-s' && args[i + 1]) {
              uniqOptions.skipChars = parseInt(args[++i], 10)
            } else if (arg.startsWith('-s')) {
              uniqOptions.skipChars = parseInt(arg.slice(2), 10)
            }
          }
          const lines = input.split('\n').filter((l, i, arr) => i < arr.length - 1 || l !== '')
          const unique = executeUniq(lines, uniqOptions)
          const stdout = unique.join('\n') + (unique.length > 0 ? '\n' : '')
          return this.createResult(fullCommand, stdout, '', 0, 1)
        }

        case 'wc': {
          // Parse wc options
          const wcOptions: WcOptions = {}
          let hasOptions = false
          for (const arg of args) {
            if (arg === '-l' || arg === '--lines') {
              wcOptions.lines = true
              hasOptions = true
            } else if (arg === '-w' || arg === '--words') {
              wcOptions.words = true
              hasOptions = true
            } else if (arg === '-c' || arg === '--bytes') {
              wcOptions.bytes = true
              hasOptions = true
            } else if (arg === '-m' || arg === '--chars') {
              wcOptions.chars = true
              hasOptions = true
            }
          }
          const result = executeWc(input, wcOptions)

          // Format output like GNU wc
          let stdout = ''
          if (!hasOptions) {
            // Default: lines, words, bytes
            stdout = `${result.lines} ${result.words} ${result.bytes}\n`
          } else {
            const parts: number[] = []
            if (wcOptions.lines) parts.push(result.lines)
            if (wcOptions.words) parts.push(result.words)
            if (wcOptions.bytes) parts.push(result.bytes)
            if (wcOptions.chars) parts.push(result.chars)
            stdout = parts.join(' ') + '\n'
          }
          return this.createResult(fullCommand, stdout, '', 0, 1)
        }

        case 'basename': {
          const path = args.find(a => !a.startsWith('-')) || ''
          const suffix = args.filter(a => !a.startsWith('-'))[1]
          const stdout = executeBasename(path, suffix) + '\n'
          return this.createResult(fullCommand, stdout, '', 0, 1)
        }

        case 'dirname': {
          const path = args.find(a => !a.startsWith('-')) || ''
          const stdout = executeDirname(path) + '\n'
          return this.createResult(fullCommand, stdout, '', 0, 1)
        }

        case 'echo': {
          // Parse echo options
          const echoOptions: EchoOptions = {}
          let startIdx = 0

          for (let i = 0; i < args.length; i++) {
            if (args[i] === '-n') {
              echoOptions.noNewline = true
              startIdx = i + 1
            } else if (args[i] === '-e') {
              echoOptions.interpretEscapes = true
              startIdx = i + 1
            } else if (args[i] === '-E') {
              echoOptions.interpretEscapes = false
              startIdx = i + 1
            } else if (args[i] === '-en' || args[i] === '-ne') {
              echoOptions.noNewline = true
              echoOptions.interpretEscapes = true
              startIdx = i + 1
            } else {
              break
            }
          }

          const stdout = executeEcho(args.slice(startIdx), echoOptions)
          return this.createResult(fullCommand, stdout, '', 0, 1)
        }

        case 'printf': {
          if (args.length === 0) {
            return this.createResult(fullCommand, '', '', 0, 1)
          }
          const format = args[0]
          const formatArgs = args.slice(1)
          const stdout = executePrintf(format, formatArgs)
          return this.createResult(fullCommand, stdout, '', 0, 1)
        }

        case 'date': {
          // Parse date options
          const dateOptions: DateOptions = {}
          let format: string | undefined

          for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (arg === '-u' || arg === '--utc' || arg === '--universal') {
              dateOptions.utc = true
            } else if (arg === '-d' && args[i + 1]) {
              dateOptions.date = args[++i]
            } else if (arg.startsWith('--date=')) {
              dateOptions.date = arg.slice(7)
            } else if (arg.startsWith('+')) {
              format = arg
            }
          }

          const stdout = executeDate(format, dateOptions) + '\n'
          return this.createResult(fullCommand, stdout, '', 0, 1)
        }

        case 'dd': {
          // Parse dd options (dd uses operand=value format)
          const ddOptions: DdOptions = {}
          let inputFile: string | undefined
          let outputFile: string | undefined
          let convOptions: string[] = []

          for (const arg of args) {
            if (arg.startsWith('bs=')) {
              ddOptions.bs = parseInt(arg.slice(3), 10)
            } else if (arg.startsWith('count=')) {
              ddOptions.count = parseInt(arg.slice(6), 10)
            } else if (arg.startsWith('skip=')) {
              ddOptions.skip = parseInt(arg.slice(5), 10)
            } else if (arg.startsWith('seek=')) {
              ddOptions.seek = parseInt(arg.slice(5), 10)
            } else if (arg.startsWith('ibs=')) {
              ddOptions.ibs = parseInt(arg.slice(4), 10)
            } else if (arg.startsWith('obs=')) {
              ddOptions.obs = parseInt(arg.slice(4), 10)
            } else if (arg.startsWith('if=')) {
              inputFile = arg.slice(3)
            } else if (arg.startsWith('of=')) {
              outputFile = arg.slice(3)
            } else if (arg.startsWith('conv=')) {
              convOptions = arg.slice(5).split(',')
            }
          }

          // Get input data from file or stdin
          let inputData: Uint8Array
          if (inputFile) {
            if (!this.fs) {
              return this.createResult(fullCommand, '', 'dd: no filesystem capability for if=', 1, 1)
            }
            try {
              const content = await this.fs.read(inputFile)
              inputData = typeof content === 'string' ? new TextEncoder().encode(content) : content
            } catch (e) {
              return this.createResult(fullCommand, '', `dd: ${inputFile}: No such file or directory`, 1, 1)
            }
          } else {
            inputData = new TextEncoder().encode(input)
          }

          // Execute dd
          let outputData = executeDd(inputData, ddOptions)

          // Apply conv options
          if (convOptions.includes('ucase')) {
            const text = new TextDecoder().decode(outputData)
            outputData = new TextEncoder().encode(text.toUpperCase())
          }
          if (convOptions.includes('lcase')) {
            const text = new TextDecoder().decode(outputData)
            outputData = new TextEncoder().encode(text.toLowerCase())
          }

          // Calculate stats for stderr
          const bs = ddOptions.bs || 512
          const recordsIn = Math.ceil(inputData.length / bs)
          const recordsOut = Math.ceil(outputData.length / bs)
          const stderr = `${recordsIn}+0 records in\n${recordsOut}+0 records out\n${outputData.length} bytes copied`

          // Write output to file or stdout
          if (outputFile) {
            if (!this.fs) {
              return this.createResult(fullCommand, '', 'dd: no filesystem capability for of=', 1, 1)
            }
            await this.fs.write(outputFile, outputData)
            return this.createResult(fullCommand, '', stderr, 0, 1)
          }

          const stdout = new TextDecoder().decode(outputData)
          return this.createResult(fullCommand, stdout, stderr, 0, 1)
        }

        case 'od': {
          // Parse od options
          const odOptions: OdOptions = {}
          for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (arg === '-A' && args[i + 1]) {
              odOptions.addressFormat = args[++i]
            } else if (arg.startsWith('-A')) {
              odOptions.addressFormat = arg.slice(2)
            } else if (arg === '-t' && args[i + 1]) {
              odOptions.format = args[++i]
            } else if (arg.startsWith('-t')) {
              odOptions.format = arg.slice(2)
            } else if (arg === '-x') {
              odOptions.format = 'x'
            } else if (arg === '-c') {
              odOptions.format = 'c'
            } else if (arg === '-d') {
              odOptions.format = 'd'
            } else if (arg === '-o') {
              odOptions.format = 'o'
            } else if (arg === '-w' && args[i + 1]) {
              odOptions.width = parseInt(args[++i], 10)
            } else if (arg.startsWith('-w')) {
              odOptions.width = parseInt(arg.slice(2), 10)
            } else if (arg === '-j' && args[i + 1]) {
              odOptions.skip = parseInt(args[++i], 10)
            } else if (arg.startsWith('-j')) {
              odOptions.skip = parseInt(arg.slice(2), 10)
            } else if (arg === '-N' && args[i + 1]) {
              odOptions.count = parseInt(args[++i], 10)
            } else if (arg.startsWith('-N')) {
              odOptions.count = parseInt(arg.slice(2), 10)
            }
          }
          const inputData = new TextEncoder().encode(input)
          const stdout = executeOd(inputData, odOptions)
          return this.createResult(fullCommand, stdout, '', 0, 1)
        }

        default:
          throw new Error(`Unsupported POSIX utility command: ${cmd}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.createResult(fullCommand, '', message, 1, 1)
    }
  }

  /**
   * Execute system utility commands (yes, whoami, hostname, printenv)
   */
  private async executeSystemUtilsCommands(
    cmd: string,
    args: string[],
    fullCommand: string,
    options?: ExecOptions
  ): Promise<BashResult> {
    try {
      // Build context from execution options
      const context: SystemUtilsContext = {
        cwd: options?.cwd,
        env: options?.env,
        stdin: options?.stdin,
      }

      switch (cmd) {
        case 'yes': {
          // Parse yes options (there are none in standard yes)
          // Limit to 1000 lines for safety in non-streaming environment
          const result = executeYes(args, { maxLines: 1000 })
          return this.createResult(fullCommand, result.stdout, result.stderr, result.exitCode, 1)
        }

        case 'whoami': {
          const result = executeWhoami(args, context)
          return this.createResult(fullCommand, result.stdout, result.stderr, result.exitCode, 1)
        }

        case 'hostname': {
          const result = executeHostname(args, context)
          return this.createResult(fullCommand, result.stdout, result.stderr, result.exitCode, 1)
        }

        case 'printenv': {
          // Parse printenv options
          const printenvOpts = {
            null: args.includes('-0') || args.includes('--null'),
          }
          const varArgs = args.filter(a => a !== '-0' && a !== '--null')
          const result = executePrintenv(varArgs, context, printenvOpts)
          return this.createResult(fullCommand, result.stdout, result.stderr, result.exitCode, 1)
        }

        default:
          throw new Error(`Unsupported system utility command: ${cmd}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.createResult(fullCommand, '', message, 1, 1)
    }
  }

  /**
   * Execute extended utility commands (env, id, uname, tac)
   */
  private async executeExtendedUtilsCommands(
    cmd: string,
    args: string[],
    fullCommand: string,
    options?: ExecOptions
  ): Promise<BashResult> {
    try {
      switch (cmd) {
        case 'env': {
          const envArgs = parseEnvArgs(args)
          const baseEnv = options?.env ?? {}
          const result = executeEnv(baseEnv, envArgs)

          if (result.command && result.command.length > 0) {
            // Execute the command with the modified environment
            const cmdToRun = result.command.join(' ')
            return this.execute(cmdToRun, { ...options, env: result.env })
          }

          // No command - print the environment
          const output = formatEnv(result.env)
          return this.createResult(fullCommand, output, '', 0, 1)
        }

        case 'id': {
          const idArgs = parseIdArgs(args)
          // Use worker identity (could be configurable in future)
          const output = executeId(DEFAULT_WORKER_IDENTITY, idArgs)
          return this.createResult(fullCommand, output + '\n', '', 0, 1)
        }

        case 'uname': {
          const unameArgs = parseUnameArgs(args)
          // Use worker system info (could be configurable in future)
          const output = executeUname(DEFAULT_WORKER_SYSINFO, unameArgs)
          return this.createResult(fullCommand, output + '\n', '', 0, 1)
        }

        case 'tac': {
          const { options: tacOptions, files } = parseTacArgs(args)

          // Get input - from files or stdin
          let input: string
          if (files.length > 0 && this.fs) {
            // Read from files
            const contents: string[] = []
            for (const file of files) {
              const content = await this.fs.read(file, { encoding: 'utf-8' }) as string
              contents.push(content)
            }
            input = contents.join('')
          } else {
            // Use stdin
            input = options?.stdin ?? ''
          }

          const output = executeTac(input, tacOptions)
          return this.createResult(fullCommand, output, '', 0, 1)
        }

        default:
          throw new Error(`Unsupported extended utility command: ${cmd}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.createResult(fullCommand, '', message, 1, 1)
    }
  }

  /**
   * Execute npm commands natively via npmx registry client
   *
   * Handles simple read-only npm operations that only need registry access:
   * - npm view/info/show: Get package metadata
   * - npm search/find/s: Search packages
   *
   * For complex operations (install, run, etc.), returns null to fall through
   * to Tier 2 RPC execution.
   */
  private async executeNpmNative(
    _cmd: string,
    args: string[],
    fullCommand: string,
    options?: ExecOptions
  ): Promise<BashResult> {
    try {
      // Build npm native options from exec options
      const npmOptions: NpmNativeOptions = {
        timeout: options?.timeout,
        cache: true,
      }

      // Check for registry override in environment
      const env = options?.env as Record<string, string> | undefined
      if (env?.npm_config_registry) {
        npmOptions.registry = env.npm_config_registry
      }
      if (env?.NPM_CONFIG_REGISTRY) {
        npmOptions.registry = env.NPM_CONFIG_REGISTRY
      }

      // Check for auth token
      if (env?.npm_config_token) {
        npmOptions.token = env.npm_config_token
      }
      if (env?.NPM_TOKEN) {
        npmOptions.token = env.NPM_TOKEN
      }

      // Execute the npm command natively
      const result = await executeNpmNative(fullCommand, args, npmOptions)

      if (result === null) {
        // Command not supported natively, this shouldn't happen if classification
        // worked correctly, but throw to fall back to RPC
        throw new Error('npm command not supported natively')
      }

      return this.createResult(fullCommand, result.stdout, result.stderr, result.exitCode, 1)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.createResult(fullCommand, '', `npm: ${message}`, 1, 1)
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
    _options?: ExecOptions
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
    _classification: TierClassification,
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
  _env: Record<string, unknown>,
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
