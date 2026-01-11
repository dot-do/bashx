/**
 * Tier-specific Executor Modules
 *
 * This module provides the building blocks for the tiered execution system.
 * Each tier implements the TierExecutor interface, allowing the TieredExecutor
 * to compose them into a unified execution strategy.
 *
 * Architecture:
 * -------------
 * - types.ts: Common interfaces and type definitions (TierExecutor, etc.)
 * - native-executor.ts: Tier 1 - In-Worker native commands
 * - rpc-executor.ts: Tier 2 - RPC service calls
 * - loader-executor.ts: Tier 3 - Dynamic npm module loading
 * - sandbox-executor.ts: Tier 4 - Full Linux sandbox
 *
 * Dependency Rules:
 * -----------------
 * 1. All executors import from types.ts (this directory) and ../../types.js
 * 2. No executor imports from another executor (prevents circular deps)
 * 3. TieredExecutor imports executors, not the reverse
 *
 * Usage:
 * ------
 * ```typescript
 * import {
 *   TierExecutor,
 *   NativeExecutor,
 *   RpcExecutor,
 *   LoaderExecutor,
 *   SandboxExecutor,
 * } from './executors/index.js'
 * ```
 *
 * @module bashx/do/executors
 */

// ============================================================================
// SHARED TYPES
// ============================================================================

export type {
  TierExecutor,
  ExecutionTier,
  TierClassification,
  CommandResult,
  ExtendedCommandResult,
  CapabilityAware,
  CommandAware,
  BaseExecutorConfig,
  ExecutorFactory,
} from './types.js'

// ============================================================================
// TIER 1: NATIVE IN-WORKER EXECUTION
// ============================================================================
// Handles commands that can be executed natively without external services:
// - Filesystem ops via FsCapability
// - HTTP via fetch API
// - Data processing (jq, base64, etc.)
// - POSIX utilities
// ============================================================================
export {
  NativeExecutor,
  createNativeExecutor,
  type NativeExecutorConfig,
  type NativeCapability,
  type NativeCommandResult,
  // Command sets
  NATIVE_COMMANDS,
  FS_COMMANDS,
  HTTP_COMMANDS,
  DATA_COMMANDS,
  CRYPTO_COMMANDS,
  TEXT_PROCESSING_COMMANDS,
  POSIX_UTILS_COMMANDS,
  SYSTEM_UTILS_COMMANDS,
  EXTENDED_UTILS_COMMANDS,
} from './native-executor.js'

// ============================================================================
// TIER 2: RPC SERVICE EXECUTION
// ============================================================================
// Handles commands via RPC calls to external services:
// - jq.do for complex jq processing
// - npm.do for npm/npx/yarn/pnpm/bun commands
// - git.do for git operations
// - Custom RPC service bindings
// ============================================================================
export {
  RpcExecutor,
  createRpcExecutor,
  type RpcExecutorConfig,
  type RpcEndpoint,
  type RpcServiceBinding,
  type RpcRequestPayload,
  type RpcResponsePayload,
  DEFAULT_RPC_SERVICES,
} from './rpc-executor.js'

// ============================================================================
// TIER 3: DYNAMIC NPM MODULE LOADING
// ============================================================================
// Handles commands via dynamically loaded npm modules:
// - JavaScript tools (esbuild, typescript, prettier, eslint)
// - Data processing (yaml, toml, zod, ajv)
// - Crypto (crypto-js, jose)
// - Utilities (lodash, date-fns, uuid)
// ============================================================================
export {
  LoaderExecutor,
  createLoaderExecutor,
  type LoaderExecutorConfig,
  type ModuleLoader,
  type WorkerLoaderBinding,
  type ModuleExecutionResult,
  type LoadableModule,
  LOADABLE_MODULES,
  MODULE_CATEGORIES,
} from './loader-executor.js'

// ============================================================================
// TIER 4: FULL LINUX SANDBOX
// ============================================================================
// Handles commands requiring full Linux environment:
// - System commands (ps, top, kill, etc.)
// - Process management
// - Compilers and runtimes (gcc, python, node, etc.)
// - Container operations
// - Any command not handled by higher tiers
// ============================================================================
export {
  SandboxExecutor,
  createSandboxExecutor,
  type SandboxExecutorConfig,
  type SandboxBackend,
  type SandboxBinding,
  type SandboxSession,
  type SandboxCapability,
  type SandboxResult,
  SANDBOX_COMMANDS,
  SANDBOX_CATEGORIES,
} from './sandbox-executor.js'
