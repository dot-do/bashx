/**
 * Tier Executor Type Definitions
 *
 * This module defines the shared interfaces and types for all tier-specific
 * executors. These interfaces form the contract between the TieredExecutor
 * orchestrator and the individual tier implementations.
 *
 * Architecture Overview:
 * ---------------------
 * The tiered execution system uses a strategy pattern where each tier
 * implements a common interface. The TieredExecutor acts as an orchestrator
 * that delegates to the appropriate tier based on command analysis.
 *
 * ```
 * TieredExecutor (orchestrator)
 *   |
 *   +-- Tier 1: NativeExecutor (in-Worker commands)
 *   |     - Filesystem operations via FsCapability
 *   |     - HTTP via fetch API
 *   |     - Data processing (jq, base64, etc.)
 *   |     - POSIX utilities
 *   |
 *   +-- Tier 2: RpcExecutor (external services)
 *   |     - jq.do for complex jq processing
 *   |     - npm.do for package management
 *   |     - git.do for git operations
 *   |
 *   +-- Tier 3: LoaderExecutor (dynamic npm modules)
 *   |     - Runtime module loading
 *   |     - esbuild, typescript, prettier, etc.
 *   |
 *   +-- Tier 4: SandboxExecutor (full Linux sandbox)
 *         - System commands (ps, kill, etc.)
 *         - Compilers and runtimes
 *         - Full Linux capabilities
 * ```
 *
 * Dependency Rules:
 * -----------------
 * - All executors depend ONLY on types.ts (this file) and ../../types.js
 * - No circular dependencies between executor modules
 * - The index.ts re-exports all modules for external consumers
 * - TieredExecutor imports individual executors, not the other way around
 *
 * @module bashx/do/executors/types
 */

import type { BashResult, ExecOptions } from '../../types.js'

// ============================================================================
// CORE EXECUTOR INTERFACE
// ============================================================================

/**
 * Base interface for all tier-specific executors.
 *
 * Each tier executor must implement this interface to be composable
 * within the TieredExecutor orchestrator.
 *
 * @example
 * ```typescript
 * class MyExecutor implements TierExecutor {
 *   canExecute(command: string): boolean {
 *     // Return true if this executor can handle the command
 *   }
 *
 *   async execute(command: string, options?: ExecOptions): Promise<BashResult> {
 *     // Execute the command and return a BashResult
 *   }
 * }
 * ```
 */
export interface TierExecutor {
  /**
   * Check if this executor can handle a given command.
   *
   * This method is used by the TieredExecutor to determine which
   * executor should handle a command. It should be fast and not
   * perform any side effects.
   *
   * @param command - The command string to check
   * @returns true if this executor can handle the command
   */
  canExecute(command: string): boolean

  /**
   * Execute a command and return the result.
   *
   * This is the main execution method. It should:
   * - Execute the command according to the tier's capabilities
   * - Return a properly formatted BashResult
   * - Handle errors gracefully and return appropriate exit codes
   *
   * @param command - The command string to execute
   * @param options - Optional execution options (cwd, env, stdin, timeout)
   * @returns A promise resolving to a BashResult
   * @throws May throw if the command cannot be executed (but prefer returning error in result)
   */
  execute(command: string, options?: ExecOptions): Promise<BashResult>
}

// ============================================================================
// EXECUTOR METADATA
// ============================================================================

/**
 * Execution tier levels.
 *
 * Each tier represents a different execution environment with
 * different capabilities and performance characteristics:
 *
 * - Tier 1: Fastest, runs in-Worker with limited capabilities
 * - Tier 2: Fast, RPC calls to external services
 * - Tier 3: Flexible, dynamic npm module loading
 * - Tier 4: Full capability, Linux sandbox (slowest)
 */
export type ExecutionTier = 1 | 2 | 3 | 4

/**
 * Tier classification result.
 *
 * Describes which tier should handle a command and why.
 */
export interface TierClassification {
  /** The tier that should handle this command */
  tier: ExecutionTier
  /** Human-readable reason for the tier selection */
  reason: string
  /** The handler type that will execute the command */
  handler: 'native' | 'rpc' | 'loader' | 'sandbox'
  /** Optional: specific capability or service name */
  capability?: string
}

// ============================================================================
// COMMON RESULT TYPES
// ============================================================================

/**
 * Basic command result without full BashResult metadata.
 *
 * This is used internally by executors before they wrap
 * the result in a full BashResult structure.
 */
export interface CommandResult {
  /** Standard output from the command */
  stdout: string
  /** Standard error from the command */
  stderr: string
  /** Exit code (0 for success, non-zero for failure) */
  exitCode: number
}

/**
 * Extended result with optional execution metadata.
 */
export interface ExtendedCommandResult extends CommandResult {
  /** Execution duration in milliseconds */
  duration?: number
  /** Memory usage in bytes */
  memoryUsage?: number
  /** CPU time in milliseconds */
  cpuTime?: number
}

// ============================================================================
// CAPABILITY DETECTION
// ============================================================================

/**
 * Interface for executors that can report their capabilities.
 *
 * Implementing this interface allows the TieredExecutor to make
 * better decisions about which executor to use.
 */
export interface CapabilityAware {
  /**
   * Get the list of capabilities this executor provides.
   *
   * @returns Array of capability names
   */
  getCapabilities(): string[]

  /**
   * Check if this executor has a specific capability.
   *
   * @param capability - The capability to check for
   * @returns true if the executor has the capability
   */
  hasCapability(capability: string): boolean
}

/**
 * Interface for executors that can report supported commands.
 */
export interface CommandAware {
  /**
   * Get the set of commands this executor supports.
   *
   * @returns Set of command names
   */
  getSupportedCommands(): Set<string>
}

// ============================================================================
// CONFIGURATION BASE TYPES
// ============================================================================

/**
 * Base configuration interface for all executors.
 *
 * Individual executors extend this with their specific configuration.
 */
export interface BaseExecutorConfig {
  /**
   * Default timeout for command execution in milliseconds.
   * @default 30000
   */
  defaultTimeout?: number
}

// ============================================================================
// FACTORY FUNCTION TYPE
// ============================================================================

/**
 * Factory function type for creating executor instances.
 *
 * All executor modules should export a factory function
 * that follows this pattern for consistent instantiation.
 *
 * @example
 * ```typescript
 * export const createNativeExecutor: ExecutorFactory<NativeExecutorConfig, NativeExecutor> =
 *   (config) => new NativeExecutor(config)
 * ```
 */
export type ExecutorFactory<TConfig extends BaseExecutorConfig, TExecutor extends TierExecutor> = (
  config?: TConfig
) => TExecutor
