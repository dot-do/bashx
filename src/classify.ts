/**
 * Input Classification Module
 *
 * Classifies input as either a bash command or natural language intent.
 * This is a critical component for AI-enhanced bash execution.
 *
 * NOTE: This is a stub implementation for TDD RED phase.
 * The actual implementation will be done in the GREEN phase.
 */

/**
 * Alternative interpretation for ambiguous inputs
 */
export interface ClassificationAlternative {
  type: 'command' | 'intent'
  interpretation: string
}

/**
 * Result of classifying user input.
 */
export interface InputClassification {
  /**
   * Type of input detected:
   * - 'command': Valid bash command syntax
   * - 'intent': Natural language request
   * - 'invalid': Empty or invalid input
   */
  type: 'command' | 'intent' | 'invalid'

  /**
   * Confidence score between 0 and 1.
   * Higher values indicate more certainty in the classification.
   */
  confidence: number

  /**
   * The original input (trimmed)
   */
  input: string

  /**
   * Human-readable explanation of the classification decision
   */
  reason: string

  /**
   * Whether the input is ambiguous (could be either command or intent)
   */
  ambiguous: boolean

  /**
   * For intent type: suggested bash command to execute
   */
  suggestedCommand?: string

  /**
   * For ambiguous inputs: alternative interpretations
   */
  alternatives?: ClassificationAlternative[]
}

/**
 * Classify input as command or natural language intent.
 *
 * @param input - The user input to classify
 * @returns Classification result with type, confidence, and metadata
 *
 * @example
 * ```typescript
 * const result = await classifyInput('ls -la')
 * // { type: 'command', confidence: 0.95, ... }
 *
 * const result = await classifyInput('show me all files')
 * // { type: 'intent', confidence: 0.9, suggestedCommand: 'ls -la', ... }
 * ```
 */
export async function classifyInput(input: string): Promise<InputClassification> {
  // TODO: Implement in GREEN phase
  // This stub always fails tests to satisfy RED phase requirements

  throw new Error('classifyInput is not yet implemented')
}
