/**
 * AST Type Definitions and Type Guards
 *
 * This module provides type guards, factory functions, and serialization utilities
 * for working with bash AST nodes.
 *
 * NOTE: This is a stub file for RED phase TDD. All functions throw or return stub
 * values. The GREEN phase will implement these functions properly.
 */

import type {
  BashNode,
  Program,
  Command,
  Pipeline,
  List,
  Word,
  Redirect,
  Assignment,
  Subshell,
  CompoundCommand,
  FunctionDef,
  Expansion,
  ParseError,
} from '../types.js'

// Re-export types for convenience
export type {
  BashNode,
  Program,
  Command,
  Pipeline,
  List,
  Word,
  Redirect,
  Assignment,
  Subshell,
  CompoundCommand,
  FunctionDef,
  Expansion,
  ParseError,
}

// ============================================================================
// Node Type Constants (STUB)
// ============================================================================

/**
 * Enum of all AST node types
 */
export const NodeType = {
  Program: 'Program',
  Command: 'Command',
  Pipeline: 'Pipeline',
  List: 'List',
  Subshell: 'Subshell',
  CompoundCommand: 'CompoundCommand',
  FunctionDef: 'FunctionDef',
  Word: 'Word',
  Redirect: 'Redirect',
  Assignment: 'Assignment',
} as const

/**
 * Array of all node type strings
 */
export const NODE_TYPES: string[] = []  // STUB: Should contain all node types

// ============================================================================
// Type Guards (STUB - All return false or throw)
// ============================================================================

/**
 * Check if a value is a Program node
 */
export function isProgram(value: unknown): value is Program {
  // STUB: Not implemented
  throw new Error('isProgram not implemented')
}

/**
 * Check if a value is a Command node
 */
export function isCommand(value: unknown): value is Command {
  // STUB: Not implemented
  throw new Error('isCommand not implemented')
}

/**
 * Check if a value is a Pipeline node
 */
export function isPipeline(value: unknown): value is Pipeline {
  // STUB: Not implemented
  throw new Error('isPipeline not implemented')
}

/**
 * Check if a value is a List node
 */
export function isList(value: unknown): value is List {
  // STUB: Not implemented
  throw new Error('isList not implemented')
}

/**
 * Check if a value is a Word node
 */
export function isWord(value: unknown): value is Word {
  // STUB: Not implemented
  throw new Error('isWord not implemented')
}

/**
 * Check if a value is a Redirect node
 */
export function isRedirect(value: unknown): value is Redirect {
  // STUB: Not implemented
  throw new Error('isRedirect not implemented')
}

/**
 * Check if a value is an Assignment node
 */
export function isAssignment(value: unknown): value is Assignment {
  // STUB: Not implemented
  throw new Error('isAssignment not implemented')
}

/**
 * Check if a value is a Subshell node
 */
export function isSubshell(value: unknown): value is Subshell {
  // STUB: Not implemented
  throw new Error('isSubshell not implemented')
}

/**
 * Check if a value is a CompoundCommand node
 */
export function isCompoundCommand(value: unknown): value is CompoundCommand {
  // STUB: Not implemented
  throw new Error('isCompoundCommand not implemented')
}

/**
 * Check if a value is a FunctionDef node
 */
export function isFunctionDef(value: unknown): value is FunctionDef {
  // STUB: Not implemented
  throw new Error('isFunctionDef not implemented')
}

/**
 * Check if a value is an Expansion object
 */
export function isExpansion(value: unknown): value is Expansion {
  // STUB: Not implemented
  throw new Error('isExpansion not implemented')
}

/**
 * Check if a value is any valid BashNode
 */
export function isBashNode(value: unknown): value is BashNode {
  // STUB: Not implemented
  throw new Error('isBashNode not implemented')
}

/**
 * Get the type of a node, or undefined if not a valid node
 */
export function getNodeType(value: unknown): string | undefined {
  // STUB: Not implemented
  throw new Error('getNodeType not implemented')
}

// ============================================================================
// Factory Functions (STUB - All throw)
// ============================================================================

/**
 * Create a Program node
 */
export function createProgram(body?: BashNode[], errors?: ParseError[]): Program {
  // STUB: Not implemented
  throw new Error('createProgram not implemented')
}

/**
 * Create a Command node
 */
export function createCommand(
  name: string | null,
  args?: string[],
  redirects?: Redirect[],
  prefix?: Assignment[]
): Command {
  // STUB: Not implemented
  throw new Error('createCommand not implemented')
}

/**
 * Create a Pipeline node
 */
export function createPipeline(commands: Command[], negated?: boolean): Pipeline {
  // STUB: Not implemented
  throw new Error('createPipeline not implemented')
}

/**
 * Create a List node
 */
export function createList(
  left: BashNode,
  operator: '&&' | '||' | ';' | '&',
  right: BashNode
): List {
  // STUB: Not implemented
  throw new Error('createList not implemented')
}

/**
 * Create a Word node
 */
export function createWord(
  value: string,
  quoted?: 'single' | 'double' | 'ansi-c' | 'locale'
): Word {
  // STUB: Not implemented
  throw new Error('createWord not implemented')
}

/**
 * Create a Redirect node
 */
export function createRedirect(
  op: Redirect['op'],
  target: string,
  fd?: number
): Redirect {
  // STUB: Not implemented
  throw new Error('createRedirect not implemented')
}

/**
 * Create an Assignment node
 */
export function createAssignment(
  name: string,
  value: string | null,
  operator?: '=' | '+='
): Assignment {
  // STUB: Not implemented
  throw new Error('createAssignment not implemented')
}

// ============================================================================
// Serialization Functions (STUB - All throw)
// ============================================================================

/**
 * Serialize an AST to a JSON string
 */
export function serializeAST(ast: Program): string {
  // STUB: Not implemented
  throw new Error('serializeAST not implemented')
}

/**
 * Deserialize a JSON string to an AST
 */
export function deserializeAST(json: string): Program {
  // STUB: Not implemented
  throw new Error('deserializeAST not implemented')
}
