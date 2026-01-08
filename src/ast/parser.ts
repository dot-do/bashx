/**
 * Bash AST Parser
 *
 * Wraps tree-sitter-bash for parsing bash commands into AST.
 * Uses WASM version for Cloudflare Workers compatibility.
 */

import type { Program } from '../types.js'

/**
 * Parse a bash command string into an AST
 *
 * @example
 * ```typescript
 * const ast = parse('ls -la | grep foo')
 * // Returns Program with Pipeline containing two Commands
 * ```
 */
export function parse(_input: string): Program {
  // TODO: Implement with tree-sitter-bash WASM
  throw new Error('Not implemented: parse requires tree-sitter-bash integration')
}

/**
 * Check if input is syntactically valid bash
 */
export function isValidSyntax(_input: string): boolean {
  // TODO: Implement
  throw new Error('Not implemented')
}
