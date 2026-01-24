/**
 * BashBinding Implementation
 *
 * Provides a binding for executing bash commands from within the do tool.
 * Uses the existing execute() function from src/execute.ts.
 *
 * @packageDocumentation
 */

import { execute } from '../../execute.js'
import type { BashBinding, ExecResult } from './types.js'

/**
 * Command history storage
 */
const commandHistory: string[] = []

/**
 * Maximum history entries to keep
 */
const MAX_HISTORY = 1000

/**
 * Environment variable filter patterns
 * These patterns are used to filter out sensitive variables
 */
const SENSITIVE_ENV_PATTERNS = [
  /^(AWS_|AZURE_|GCP_|GOOGLE_)/i,
  /SECRET/i,
  /PASSWORD/i,
  /TOKEN/i,
  /API_KEY/i,
  /PRIVATE_KEY/i,
  /CREDENTIAL/i,
]

/**
 * Check if an environment variable is sensitive
 */
function isSensitiveEnvVar(name: string): boolean {
  return SENSITIVE_ENV_PATTERNS.some(pattern => pattern.test(name))
}

/**
 * Filter environment variables to remove sensitive ones
 */
function filterEnv(env: NodeJS.ProcessEnv, nameFilter?: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (isSensitiveEnvVar(key)) continue
    if (nameFilter && key !== nameFilter) continue
    result[key] = value
  }

  return result
}

/**
 * Add a command to the history
 */
function addToHistory(command: string): void {
  commandHistory.push(command)
  if (commandHistory.length > MAX_HISTORY) {
    commandHistory.shift()
  }
}

/**
 * Create a BashBinding instance
 *
 * The binding wraps the execute() function and provides:
 * - Command execution with safety checks
 * - Command history tracking
 * - Environment variable access (filtered)
 *
 * @returns A BashBinding implementation
 */
export function createBashBinding(): BashBinding {
  return {
    async exec(command: string): Promise<ExecResult> {
      // Add to history
      addToHistory(command)

      // Execute using the safety-gated execute function
      const result = await execute(command, { confirm: true })

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }
    },

    async history(limit?: number): Promise<string[]> {
      if (limit === undefined) {
        return [...commandHistory]
      }
      return commandHistory.slice(-limit)
    },

    async env(name?: string): Promise<Record<string, string>> {
      return filterEnv(process.env, name)
    },
  }
}

/**
 * Clear command history (useful for testing)
 */
export function clearHistory(): void {
  commandHistory.length = 0
}

/**
 * Get current history count (useful for testing)
 */
export function getHistoryCount(): number {
  return commandHistory.length
}

/**
 * Default bash binding instance
 */
export const defaultBashBinding = createBashBinding()

// ============================================================================
// DoScope Integration with @dotdo/mcp
// ============================================================================

import type { DoScope, DoPermissions } from '@dotdo/mcp'
import { createDoHandler as createMcpDoHandler } from '@dotdo/mcp'

/**
 * TypeScript type definitions for the bash binding.
 * Used by ai-evaluate to provide type information to the LLM.
 */
const BASH_BINDING_TYPES = `
interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface BashBinding {
  /**
   * Execute a shell command with safety analysis.
   * @param command - The command to execute
   * @returns Promise resolving to execution result with stdout, stderr, and exitCode
   */
  exec(command: string): Promise<ExecResult>;

  /**
   * Retrieve command history from this session.
   * @param limit - Optional limit on number of entries to return
   * @returns Promise resolving to array of previous commands
   */
  history(limit?: number): Promise<string[]>;

  /**
   * Get environment variables (sensitive values filtered).
   * @param name - Optional name to get a specific variable
   * @returns Promise resolving to key-value pairs
   */
  env(name?: string): Promise<Record<string, string>>;
}

declare const bash: BashBinding;
`

/**
 * Options for creating a bash scope
 */
export interface CreateBashScopeOptions {
  /** Execution timeout in milliseconds */
  timeout?: number
  /** Sandbox permissions */
  permissions?: DoPermissions
}

/**
 * Create a DoScope configured for bash execution.
 *
 * This creates a DoScope compatible with @dotdo/mcp's createDoHandler,
 * with the bash binding injected and TypeScript types provided.
 *
 * @param bash - The BashBinding implementation
 * @param options - Optional configuration (timeout, permissions)
 * @returns A DoScope ready for use with @dotdo/mcp createDoHandler
 *
 * @example
 * ```typescript
 * const bash = createBashBinding()
 * const scope = createBashScope(bash, { timeout: 5000 })
 * const handler = createDoHandler(scope)
 * ```
 */
export function createBashScope(
  bash: BashBinding,
  options?: CreateBashScopeOptions
): DoScope {
  return {
    bindings: {
      bash,
    },
    types: BASH_BINDING_TYPES,
    timeout: options?.timeout,
    permissions: options?.permissions,
  }
}

/**
 * MCP tool response format from @dotdo/mcp
 */
interface ToolResponse {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

/**
 * Create a do handler with bash binding using @dotdo/mcp's sandboxed execution.
 *
 * This is a convenience wrapper that:
 * 1. Creates a BashBinding if not provided
 * 2. Creates a DoScope with the binding
 * 3. Returns @dotdo/mcp's createDoHandler
 *
 * @param bash - Optional BashBinding (creates default if not provided)
 * @param options - Optional configuration
 * @returns Handler function compatible with MCP
 *
 * @example
 * ```typescript
 * // Use default binding
 * const handler = createBashDoHandler()
 *
 * // Or provide custom binding
 * const customBash = createBashBinding()
 * const handler = createBashDoHandler(customBash)
 *
 * // Execute code
 * const result = await handler({ code: 'await bash.exec("ls -la")' })
 * ```
 */
export function createBashDoHandler(
  bash?: BashBinding,
  options?: CreateBashScopeOptions
): (input: { code: string }) => Promise<ToolResponse> {
  const binding = bash ?? createBashBinding()
  const scope = createBashScope(binding, options)
  return createMcpDoHandler(scope)
}
