/**
 * Dependency Tree Builder
 *
 * Builds a dependency graph from a bash AST showing how commands depend on each other.
 * Dependencies include:
 * - Pipe dependencies (data flows through stdout/stdin)
 * - File dependencies (command writes to file that another reads)
 * - Variable dependencies (command sets variable that another uses)
 * - Conditional dependencies (command runs based on another's exit status)
 * - Sequence dependencies (commands run in order)
 * - Background/parallel execution
 *
 * @packageDocumentation
 */

import type { Program, BashNode } from '../types.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Types of dependencies between commands
 */
export type DependencyType =
  | 'pipe' // Data flows through pipe (stdout -> stdin)
  | 'file' // File written by one command, read by another
  | 'variable' // Variable set by one command, used by another
  | 'conditional' // Command runs based on exit status (&&, ||)
  | 'sequence' // Command runs after another (;)
  | 'background' // Command runs in background (&)
  | 'function' // Function definition -> function call

/**
 * A node in the dependency tree representing a command
 */
export interface DependencyNode {
  /** Unique identifier for this node */
  id: string
  /** Command name (e.g., 'ls', 'grep') */
  command: string
  /** Command arguments */
  args: string[]
  /** Subshell scope ID if in a subshell */
  scope?: string
  /** Loop variable name if this is inside a for loop */
  loopVariable?: string
  /** Execution level for parallel grouping */
  level?: number
}

/**
 * An edge in the dependency graph
 */
export interface DependencyEdge {
  /** Source node ID */
  from: string
  /** Target node ID */
  to: string
  /** Type of dependency */
  type: DependencyType
  /** File path for file dependencies */
  file?: string
  /** Variable name for variable dependencies */
  variable?: string
  /** Condition type for conditional dependencies */
  condition?: 'success' | 'failure'
  /** Whether this is a parallel execution edge */
  parallel?: boolean
  /** Data flow information for pipe dependencies */
  dataFlow?: {
    sourceFd: number
    targetFd: number
  }
}

/**
 * The complete dependency tree
 */
export interface DependencyTree {
  /** All nodes (commands) in the tree */
  nodes: DependencyNode[]
  /** All dependency edges */
  edges: DependencyEdge[]
  /** Root node of the tree */
  root: DependencyNode | null
  /** Source AST this tree was built from */
  sourceAst: Program
}

// ============================================================================
// Main API (Stubs - RED Phase)
// ============================================================================

/**
 * Build a dependency tree from a bash AST
 *
 * @param ast - The parsed bash program AST
 * @returns The dependency tree
 */
export function buildDependencyTree(ast: Program): DependencyTree {
  // TODO: Implement in GREEN phase
  throw new Error('buildDependencyTree not implemented')
}

/**
 * Get the execution order of commands respecting dependencies
 *
 * @param tree - The dependency tree
 * @returns Nodes in topological order
 */
export function getExecutionOrder(tree: DependencyTree): DependencyNode[] {
  // TODO: Implement in GREEN phase
  throw new Error('getExecutionOrder not implemented')
}

/**
 * Find the data flow path between two commands
 *
 * @param tree - The dependency tree
 * @param fromId - Source node ID
 * @param toId - Target node ID
 * @returns Array of nodes in the data flow path, or empty if no path exists
 */
export function findDataFlowPath(
  tree: DependencyTree,
  fromId: string,
  toId: string
): DependencyNode[] {
  // TODO: Implement in GREEN phase
  throw new Error('findDataFlowPath not implemented')
}

/**
 * Detect if the dependency tree contains cycles
 *
 * @param tree - The dependency tree
 * @returns True if cycles are detected
 */
export function detectCycles(tree: DependencyTree): boolean {
  // TODO: Implement in GREEN phase
  throw new Error('detectCycles not implemented')
}

/**
 * Get groups of commands that can run in parallel
 *
 * @param tree - The dependency tree
 * @returns Array of node groups that can execute in parallel
 */
export function getParallelGroups(tree: DependencyTree): DependencyNode[][] {
  // TODO: Implement in GREEN phase
  throw new Error('getParallelGroups not implemented')
}
