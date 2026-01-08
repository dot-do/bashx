/**
 * bashx.do - AI-enhanced bash execution
 *
 * bashx wraps bash with:
 * - Intent understanding (natural language → commands)
 * - Safety classification (before execution)
 * - Intelligent recovery (auto-fix errors)
 * - Output parsing (structured extraction)
 *
 * @example
 * ```typescript
 * import { bashx } from 'bashx'
 *
 * // Natural language
 * await bashx`deploy to staging`
 *
 * // With safety checks
 * await bashx.run({
 *   cmd: 'rm -rf ./build',
 *   intent: 'clean build directory',
 *   require: { safe: true, reversible: true }
 * })
 *
 * // Explain before running
 * const explanation = await bashx.explain('find . -name "*.log" -delete')
 * ```
 */

import { createClient, tagged, type ClientOptions, type TaggedTemplate } from 'rpc.do'
import type {
  BashxClient,
  BashxResult,
  DoOptions,
  RunOptions,
  ExecOptions,
  ExecResult,
  Explanation,
  SafetyReport,
  SafetyContext,
  GeneratedCommand,
  GenerateContext,
  PipeStep,
  PipeResult,
  HistoryEntry,
} from './types.js'
import type { McpTool } from 'mcp.do'

export * from './types.js'

/**
 * Create a bashx client with custom options
 *
 * @example
 * ```typescript
 * const client = BashX({ apiKey: 'my-key' })
 * await client.run({ cmd: 'ls -la' })
 * ```
 */
export function BashX(options?: ClientOptions): BashxClient {
  const client = createClient<BashxClient>('https://bashx.do', options)

  // Enhance with tagged template support
  const enhancedClient = client as BashxClient

  enhancedClient.do = tagged(async (query: string, opts?: DoOptions) => {
    return client.invokeTool('bash_query', { query, ...opts })
  })

  return enhancedClient
}

/**
 * Default bashx client instance
 *
 * @example
 * ```typescript
 * import { bashx } from 'bashx'
 *
 * // Natural language execution
 * await bashx`list all typescript files`
 *
 * // Explain a command
 * const explanation = await bashx.explain('grep -r "TODO" --include="*.ts"')
 *
 * // Check safety
 * const report = await bashx.safe('chmod -R 777 /')
 * ```
 */
export const bashx: BashxClient = BashX()

export default bashx
