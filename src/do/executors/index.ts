/**
 * Tier-specific Executor Modules
 *
 * This module re-exports all tier-specific executors for the TieredExecutor.
 *
 * @module bashx/do/executors
 */

// Tier 1: Native in-Worker execution
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

// Tier 2: RPC service execution
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

// Tier 3: Dynamic npm module loading
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

// Tier 4: Full Linux sandbox
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
