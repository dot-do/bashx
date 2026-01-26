/**
 * bashx Safety Module
 *
 * Exports safety analysis utilities for command validation.
 *
 * @example
 * ```typescript
 * import { analyze, isDangerous, classifyCommand } from 'bashx/safety'
 * import { parse } from 'bashx/ast'
 *
 * const ast = parse('rm -rf /')
 * const { dangerous, reason } = isDangerous(ast)
 * if (dangerous) {
 *   console.warn('Dangerous command:', reason)
 * }
 * ```
 *
 * @module bashx/safety
 */

export { analyze, isDangerous, classifyCommand } from '../ast/analyze.js'
export type { SafetyClassification, Intent, CommandClassification } from '../types.js'

// Re-export @dotdo/types/bash safety types for API consumers
export type {
  SafetyLevel,
  SafetyClassification as ApiSafetyClassification,
  Intent as ApiIntent,
} from '@dotdo/types/bash'

// Re-export converters for interoperability
export {
  toApiSafetyClassification,
  toApiIntent,
  isApiSafetyLevel,
  isApiSafetyClassification,
  isInternalSafetyClassification,
} from '../types-bridge.js'
