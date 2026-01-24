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
