/**
 * Tree-sitter-bash WASM Integration (Stub)
 *
 * This module provides the interface for tree-sitter-bash WASM integration.
 * This is a stub file that defines the expected API - implementation pending.
 *
 * The actual implementation will:
 * 1. Load tree-sitter WASM module
 * 2. Load tree-sitter-bash language grammar
 * 3. Provide parsing and traversal utilities
 *
 * @see https://tree-sitter.github.io/tree-sitter/
 * @see https://github.com/tree-sitter/tree-sitter-bash
 */

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Position in source text
 */
export interface Point {
  row: number
  column: number
}

/**
 * Edit operation for incremental parsing
 */
export interface Edit {
  startIndex: number
  oldEndIndex: number
  newEndIndex: number
  startPosition: Point
  oldEndPosition: Point
  newEndPosition: Point
}

/**
 * Query capture result
 */
export interface QueryCapture {
  name: string
  node: TreeSitterNode
}

/**
 * Query match result
 */
export interface QueryMatch {
  pattern: number
  captures: QueryCapture[]
}

/**
 * Tree-sitter Query object
 */
export interface TreeSitterQuery {
  matches(node: TreeSitterNode): QueryMatch[]
  captures(node: TreeSitterNode): QueryCapture[]
}

/**
 * Tree-sitter Language object
 */
export interface TreeSitterLanguage {
  query(source: string): TreeSitterQuery
}

/**
 * Tree-sitter syntax tree node
 */
export interface TreeSitterNode {
  // Node type and text
  readonly type: string
  readonly text: string
  readonly isNamed: boolean
  readonly isError: boolean
  readonly hasError: boolean

  // Position information
  readonly startPosition: Point
  readonly endPosition: Point
  readonly startIndex: number
  readonly endIndex: number

  // Child navigation
  readonly firstChild: TreeSitterNode | null
  readonly lastChild: TreeSitterNode | null
  readonly children: TreeSitterNode[]
  readonly namedChildren: TreeSitterNode[]
  readonly childCount: number
  child(index: number): TreeSitterNode | null

  // Sibling navigation
  readonly nextSibling: TreeSitterNode | null
  readonly previousSibling: TreeSitterNode | null
  readonly nextNamedSibling: TreeSitterNode | null
  readonly previousNamedSibling: TreeSitterNode | null

  // Parent navigation
  readonly parent: TreeSitterNode | null

  // Field access
  childForFieldName(fieldName: string): TreeSitterNode | null
  childrenForFieldName(fieldName: string): TreeSitterNode[]
}

/**
 * Tree-sitter syntax tree
 */
export interface TreeSitterTree {
  readonly rootNode: TreeSitterNode

  /**
   * Edit the tree for incremental parsing
   */
  edit(edit: Edit): void
}

/**
 * Tree-sitter parser instance
 */
export interface TreeSitterParser {
  /**
   * Parse source code into a syntax tree
   * @param source - The source code to parse
   * @param oldTree - Optional previous tree for incremental parsing
   */
  parse(source: string, oldTree?: TreeSitterTree): TreeSitterTree
}

// ============================================================================
// Module State (Stub)
// ============================================================================

let _initialized = false
let _parser: TreeSitterParser | null = null
let _language: TreeSitterLanguage | null = null

// ============================================================================
// Public API (Stubs - Not Implemented)
// ============================================================================

/**
 * Initialize the tree-sitter WASM module
 *
 * Must be called before any parsing operations.
 * Safe to call multiple times - will only initialize once.
 *
 * @throws {Error} If WASM module fails to load
 *
 * @example
 * ```typescript
 * await initTreeSitter()
 * const tree = parseWithTreeSitter('ls -la')
 * ```
 */
export async function initTreeSitter(): Promise<void> {
  // TODO: Implement WASM module loading
  // 1. Load tree-sitter WASM
  // 2. Load tree-sitter-bash language grammar
  // 3. Create parser and set language
  throw new Error('Not implemented: initTreeSitter - tree-sitter-bash WASM integration pending')
}

/**
 * Check if tree-sitter is initialized and ready
 */
export function isTreeSitterReady(): boolean {
  return _initialized
}

/**
 * Get the tree-sitter-bash language object
 *
 * @throws {Error} If tree-sitter is not initialized
 */
export function getTreeSitterLanguage(): TreeSitterLanguage {
  if (!_initialized || !_language) {
    throw new Error('Tree-sitter not initialized. Call initTreeSitter() first.')
  }
  return _language
}

/**
 * Create a new parser instance
 *
 * Useful when you need to maintain multiple parse states
 * or do incremental parsing.
 *
 * @throws {Error} If tree-sitter is not initialized
 *
 * @example
 * ```typescript
 * const parser = createParser()
 * const tree1 = parser.parse('ls')
 * tree1.edit(...)
 * const tree2 = parser.parse('ls -la', tree1)
 * ```
 */
export function createParser(): TreeSitterParser {
  if (!_initialized) {
    throw new Error('Tree-sitter not initialized. Call initTreeSitter() first.')
  }
  // TODO: Create and return new parser instance
  throw new Error('Not implemented: createParser - tree-sitter-bash WASM integration pending')
}

/**
 * Parse bash source code using tree-sitter
 *
 * Convenience function that uses the shared parser instance.
 * For incremental parsing, use createParser() instead.
 *
 * @param source - The bash source code to parse
 * @returns The parsed syntax tree
 * @throws {Error} If tree-sitter is not initialized
 *
 * @example
 * ```typescript
 * await initTreeSitter()
 *
 * const tree = parseWithTreeSitter('ls -la | grep foo')
 * console.log(tree.rootNode.type) // 'program'
 *
 * const pipeline = tree.rootNode.firstChild
 * console.log(pipeline.type) // 'pipeline'
 * ```
 */
export function parseWithTreeSitter(source: string): TreeSitterTree {
  if (!_initialized || !_parser) {
    throw new Error('Tree-sitter not initialized. Call initTreeSitter() first.')
  }
  return _parser.parse(source)
}

// ============================================================================
// Utility Functions (Stubs)
// ============================================================================

/**
 * Walk the syntax tree and call visitor for each node
 *
 * @param node - The root node to start walking from
 * @param visitor - Callback called for each node
 *
 * @example
 * ```typescript
 * walkTree(tree.rootNode, (node) => {
 *   if (node.type === 'command') {
 *     console.log('Found command:', node.text)
 *   }
 * })
 * ```
 */
export function walkTree(
  node: TreeSitterNode,
  visitor: (node: TreeSitterNode) => void
): void {
  visitor(node)
  for (const child of node.children) {
    walkTree(child, visitor)
  }
}

/**
 * Find all nodes of a specific type in the tree
 *
 * @param node - The root node to search from
 * @param type - The node type to find
 * @returns Array of matching nodes
 *
 * @example
 * ```typescript
 * const commands = findNodesByType(tree.rootNode, 'command')
 * for (const cmd of commands) {
 *   console.log(cmd.text)
 * }
 * ```
 */
export function findNodesByType(node: TreeSitterNode, type: string): TreeSitterNode[] {
  const results: TreeSitterNode[] = []

  walkTree(node, (n) => {
    if (n.type === type) {
      results.push(n)
    }
  })

  return results
}

/**
 * Get all error nodes in the tree
 *
 * Useful for detecting and reporting syntax errors.
 *
 * @param node - The root node to search from
 * @returns Array of error nodes
 */
export function getErrorNodes(node: TreeSitterNode): TreeSitterNode[] {
  const errors: TreeSitterNode[] = []

  walkTree(node, (n) => {
    if (n.type === 'ERROR' || n.isError) {
      errors.push(n)
    }
  })

  return errors
}

/**
 * Check if the tree has any syntax errors
 *
 * @param tree - The syntax tree to check
 * @returns true if the tree contains errors
 */
export function hasErrors(tree: TreeSitterTree): boolean {
  return tree.rootNode.hasError
}
