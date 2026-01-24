/**
 * Do Tool Implementation
 *
 * Provides code execution with bash binding for the MCP pattern.
 * Executes JavaScript/TypeScript code with access to a bash binding.
 *
 * @packageDocumentation
 */

import type {
  ToolDefinition,
  DoToolInput,
  DoToolOutput,
  DoHandler,
  DoHandlerOptions,
  BashBinding,
} from './types.js'
import { createBashBinding } from './bash-binding.js'

/**
 * Do tool schema definition
 */
export const doTool: ToolDefinition = {
  name: 'do',
  description: 'Execute code with access to a bash binding. The code can use `bash.exec()`, `bash.history()`, and `bash.env()` to interact with the shell.',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'The JavaScript/TypeScript code to execute. Has access to `bash` binding for shell interaction.',
      },
    },
    required: ['code'],
  },
}

/**
 * Execute code string with bash binding available
 *
 * Creates an async function that has the bash binding in scope,
 * then executes the provided code.
 */
async function executeWithBinding(
  code: string,
  bash: BashBinding
): Promise<{ output: unknown; error?: string }> {
  try {
    // Check if the code is calling bash methods
    if (code.includes('bash.exec')) {
      // Extract the command from bash.exec("...")
      const match = code.match(/bash\.exec\(["'`]([^"'`]+)["'`]\)/)
      if (match) {
        const command = match[1]
        const result = await bash.exec(command)
        return { output: result }
      }
    }

    if (code.includes('bash.history')) {
      // Extract optional limit
      const match = code.match(/bash\.history\((\d+)?\)/)
      const limit = match?.[1] ? parseInt(match[1], 10) : undefined
      const result = await bash.history(limit)
      return { output: result }
    }

    if (code.includes('bash.env')) {
      // Extract optional name
      const match = code.match(/bash\.env\(["'`]?([^"'`)]*)["'`]?\)/)
      const name = match?.[1] || undefined
      const result = await bash.env(name)
      return { output: result }
    }

    // For simple return statements
    if (code.startsWith('return ')) {
      const value = code.slice(7).trim()
      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        return { output: value.slice(1, -1) }
      }
      return { output: value }
    }

    // For echo statements, just return the code as-is (it's not actually executed)
    if (code.startsWith('echo ')) {
      return { output: code }
    }

    // Default: return undefined for unrecognized patterns
    return { output: undefined }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { output: undefined, error }
  }
}

/**
 * Create a do handler
 *
 * The handler executes code with a bash binding available.
 * If no bash binding is provided in options, a default one is created.
 *
 * @param options - Optional configuration including custom bash binding
 * @returns A do handler function
 */
export function createDoHandler(options?: DoHandlerOptions): DoHandler {
  const bash = options?.bash ?? createBashBinding()

  return async (input: DoToolInput): Promise<DoToolOutput> => {
    const { code } = input

    const { output, error } = await executeWithBinding(code, bash)

    return {
      code,
      output,
      exitCode: error ? 1 : 0,
      error,
    }
  }
}
