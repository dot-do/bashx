/**
 * bashx.do - AI-enhanced bash with AST-based validation
 *
 * ONE tool. ONE interface. Maximum intelligence.
 *
 * @example
 * ```typescript
 * import { bash } from 'bashx'
 *
 * // Just run commands
 * await bash`ls -la`
 *
 * // Or describe what you want
 * await bash`find all typescript files over 100 lines`
 *
 * // Dangerous commands are blocked
 * await bash`rm -rf /`  // → { blocked: true, requiresConfirm: true }
 *
 * // Unless you confirm
 * await bash('rm -rf /', { confirm: true })  // → executes
 * ```
 */

import { createClient, type ClientOptions } from 'rpc.do'
import type { BashResult, BashOptions, BashClient } from './types.js'

export * from './types.js'

/**
 * Create a bash client with custom options
 */
export function Bash(clientOptions?: ClientOptions): BashClient {
  const rpcClient = createClient<{ bash: (input: string, options?: BashOptions) => Promise<BashResult> }>(
    'https://bashx.do',
    clientOptions
  )

  // Create the dual-mode function (tagged template + direct call)
  const bashFn = function (
    inputOrStrings: string | TemplateStringsArray,
    ...values: unknown[]
  ): Promise<BashResult> {
    // Tagged template: bash`command`
    if (Array.isArray(inputOrStrings) && 'raw' in inputOrStrings) {
      const strings = inputOrStrings as TemplateStringsArray
      const input = strings.reduce(
        (acc, str, i) => acc + str + (values[i] !== undefined ? String(values[i]) : ''),
        ''
      )
      return rpcClient.bash(input)
    }

    // Direct call: bash('command', options)
    const input = inputOrStrings as string
    const options = values[0] as BashOptions | undefined
    return rpcClient.bash(input, options)
  } as BashClient

  return bashFn
}

/**
 * Default bash client
 *
 * @example
 * ```typescript
 * import { bash } from 'bashx'
 *
 * // Tagged template
 * const result = await bash`git status`
 *
 * // With interpolation
 * const file = 'package.json'
 * const result = await bash`cat ${file}`
 *
 * // With options
 * const result = await bash('rm -rf build', { confirm: true })
 * ```
 */
export const bash: BashClient = Bash()

export default bash
