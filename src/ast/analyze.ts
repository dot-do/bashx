/**
 * AST Analysis
 *
 * Analyzes parsed AST to extract safety classification and intent.
 */

import type { Program, CommandClassification, Intent } from '../types.js'

/**
 * Analyze an AST for safety classification
 */
export function analyze(_ast: Program): { classification: CommandClassification; intent: Intent } {
  // TODO: Implement structural analysis
  throw new Error('Not implemented: analyze requires AST traversal')
}

/**
 * Classify a single command from AST
 */
export function classifyCommand(_commandName: string, _args: string[]): CommandClassification {
  // TODO: Implement
  throw new Error('Not implemented')
}

/**
 * Check if command is dangerous based on AST structure
 */
export function isDangerous(_ast: Program): { dangerous: boolean; reason?: string } {
  // TODO: Implement structural detection (not regex!)
  throw new Error('Not implemented')
}
