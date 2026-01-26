/**
 * Type Bridge for @dotdo/types/bash Integration
 *
 * This module provides interoperability between bashx's internal types
 * and the @dotdo/types/bash public API types.
 *
 * The two type systems serve different purposes:
 * - bashx internal types: Rich, detailed types for implementation
 * - @dotdo/types/bash: Simplified types for the public RPC API
 *
 * @packageDocumentation
 */

// Re-export types from @dotdo/types/bash for API consumers
export type {
  BashEncoding,
  SafetyLevel,
  SupportedLanguage as ShellLanguage,
  ShellApi,
  ShellStream,
  ShellResult,
  BashCapability as ShellCapability,
} from '@dotdo/types/bash'

// Import internal types
import type {
  BashResult as InternalBashResult,
  SafetyClassification as InternalSafetyClassification,
  Intent as InternalIntent,
} from './types.js'

// Import @dotdo/types for conversion
import type {
  BashResult as ApiBashResult,
  SafetyClassification as ApiSafetyClassification,
  Intent as ApiIntent,
  SafetyLevel,
} from '@dotdo/types/bash'

// ============================================================================
// Type Converters
// ============================================================================

/**
 * Convert internal SafetyClassification to API SafetyClassification
 *
 * Internal format:
 * - type: 'read' | 'write' | 'delete' | 'execute' | 'network' | 'system' | 'mixed'
 * - impact: 'none' | 'low' | 'medium' | 'high' | 'critical'
 * - reversible: boolean
 * - reason: string
 *
 * API format:
 * - level: 'safe' | 'low' | 'medium' | 'high' | 'critical'
 * - reasons: string[]
 * - dangerous: string[]
 * - suggestions?: string[]
 */
export function toApiSafetyClassification(
  internal: InternalSafetyClassification
): ApiSafetyClassification {
  // Map internal impact to API level
  const levelMap: Record<string, SafetyLevel> = {
    none: 'safe',
    low: 'low',
    medium: 'medium',
    high: 'high',
    critical: 'critical',
  }

  const level = levelMap[internal.impact] ?? 'medium'

  // Build reasons array
  const reasons: string[] = [internal.reason]
  if (!internal.reversible && internal.impact !== 'none') {
    reasons.push('Operation is not reversible')
  }
  if (internal.type !== 'read') {
    reasons.push(`Operation type: ${internal.type}`)
  }

  // Identify dangerous patterns
  const dangerous: string[] = []
  if (internal.impact === 'critical') {
    dangerous.push('Critical impact level')
  }
  if (internal.impact === 'high' && !internal.reversible) {
    dangerous.push('High impact and not reversible')
  }

  return {
    level,
    reasons,
    dangerous,
    suggestions: internal.suggestion ? [internal.suggestion] : undefined,
  }
}

/**
 * Convert internal Intent to API Intent
 *
 * Internal format:
 * - commands: string[]
 * - reads: string[]
 * - writes: string[]
 * - deletes: string[]
 * - network: boolean
 * - elevated: boolean
 *
 * API format:
 * - action: string
 * - target?: string
 * - flags: string[]
 * - modifiers: string[]
 * - description: string
 */
export function toApiIntent(internal: InternalIntent): ApiIntent {
  // Determine primary action
  let action = 'execute'
  let target: string | undefined

  if (internal.deletes.length > 0) {
    action = 'delete'
    target = internal.deletes[0]
  } else if (internal.writes.length > 0) {
    action = 'write'
    target = internal.writes[0]
  } else if (internal.reads.length > 0) {
    action = 'read'
    target = internal.reads[0]
  } else if (internal.network) {
    action = 'network'
  }

  // Build modifiers
  const modifiers: string[] = []
  if (internal.elevated) {
    modifiers.push('elevated')
  }
  if (internal.network) {
    modifiers.push('network')
  }
  if (internal.inlineCode) {
    modifiers.push('inline')
  }

  // Build description
  const parts: string[] = []
  if (internal.commands.length > 0) {
    parts.push(`Executes: ${internal.commands.join(', ')}`)
  }
  if (internal.reads.length > 0) {
    parts.push(`Reads: ${internal.reads.slice(0, 3).join(', ')}${internal.reads.length > 3 ? '...' : ''}`)
  }
  if (internal.writes.length > 0) {
    parts.push(`Writes: ${internal.writes.slice(0, 3).join(', ')}${internal.writes.length > 3 ? '...' : ''}`)
  }
  if (internal.deletes.length > 0) {
    parts.push(`Deletes: ${internal.deletes.slice(0, 3).join(', ')}${internal.deletes.length > 3 ? '...' : ''}`)
  }

  return {
    action,
    target,
    flags: [], // Flags would need to be extracted from command parsing
    modifiers,
    description: parts.join('. ') || 'No specific actions detected',
  }
}

/**
 * Convert internal BashResult to API BashResult
 *
 * This is a lossy conversion since the internal BashResult has more fields.
 * Use this when returning results through the public RPC API.
 */
export function toApiBashResult(internal: InternalBashResult): ApiBashResult {
  return {
    stdout: internal.stdout,
    stderr: internal.stderr,
    exitCode: internal.exitCode,
    duration: 0, // Internal type doesn't track duration
    timedOut: false,
  }
}

/**
 * Convert API BashResult to internal BashResult
 *
 * Creates a minimal internal result with required fields.
 */
export function fromApiBashResult(
  api: ApiBashResult,
  command: string
): InternalBashResult {
  return {
    input: command,
    command,
    valid: api.exitCode === 0,
    generated: false,
    stdout: api.stdout,
    stderr: api.stderr,
    exitCode: api.exitCode,
    intent: {
      commands: [command.split(' ')[0] || ''],
      reads: [],
      writes: [],
      deletes: [],
      network: false,
      elevated: false,
    },
    classification: {
      type: 'execute',
      impact: 'low',
      reversible: true,
      reason: 'Executed via API',
    },
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a value is an API SafetyLevel
 */
export function isApiSafetyLevel(value: unknown): value is SafetyLevel {
  return (
    value === 'safe' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'critical'
  )
}

/**
 * Check if a value has the API SafetyClassification structure
 */
export function isApiSafetyClassification(
  value: unknown
): value is ApiSafetyClassification {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    isApiSafetyLevel(obj.level) &&
    Array.isArray(obj.reasons) &&
    Array.isArray(obj.dangerous)
  )
}

/**
 * Check if a value has the internal SafetyClassification structure
 */
export function isInternalSafetyClassification(
  value: unknown
): value is InternalSafetyClassification {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.type === 'string' &&
    typeof obj.impact === 'string' &&
    typeof obj.reversible === 'boolean' &&
    typeof obj.reason === 'string'
  )
}
