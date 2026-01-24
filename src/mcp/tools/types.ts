/**
 * Type definitions for MCP Search/Fetch/Do Tools
 *
 * Defines the interfaces for:
 * - Tool input/output types
 * - BashBinding interface for code execution
 *
 * @packageDocumentation
 */

// ============================================================================
// Search Tool Types
// ============================================================================

/**
 * Input for the search tool
 */
export interface SearchToolInput {
  /** The search query string */
  query: string
}

/**
 * A single search result
 */
export interface SearchResult {
  /** Unique identifier for the result */
  id: string
  /** Display title for the result */
  title: string
  /** Optional description or content preview */
  description?: string
  /** Optional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Output from the search tool
 */
export interface SearchToolOutput {
  /** The original query */
  query: string
  /** Array of search results */
  results: SearchResult[]
}

// ============================================================================
// Fetch Tool Types
// ============================================================================

/**
 * Input for the fetch tool
 */
export interface FetchToolInput {
  /** The resource identifier to fetch */
  resource: string
}

/**
 * Output from the fetch tool
 */
export interface FetchToolOutput {
  /** The resource identifier that was fetched */
  resource: string
  /** The content of the resource */
  content: unknown
  /** Optional metadata about the resource */
  metadata?: Record<string, unknown>
}

// ============================================================================
// Do Tool Types
// ============================================================================

/**
 * Input for the do tool
 */
export interface DoToolInput {
  /** The code to execute */
  code: string
}

/**
 * Output from the do tool
 */
export interface DoToolOutput {
  /** The code that was executed */
  code: string
  /** The output from execution */
  output: unknown
  /** Exit code (0 for success) */
  exitCode: number
  /** Optional error message */
  error?: string
}

// ============================================================================
// Bash Binding Types
// ============================================================================

/**
 * Result from executing a bash command
 */
export interface ExecResult {
  /** Standard output */
  stdout: string
  /** Standard error */
  stderr: string
  /** Process exit code */
  exitCode: number
}

/**
 * Bash binding interface for executing shell commands
 *
 * Provides methods to:
 * - exec(): Execute shell commands
 * - history(): Retrieve command history
 * - env(): Access environment variables
 */
export interface BashBinding {
  /**
   * Execute a shell command
   *
   * @param command - The command to execute
   * @returns Promise resolving to execution result
   */
  exec(command: string): Promise<ExecResult>

  /**
   * Retrieve command history
   *
   * @param limit - Optional limit on number of entries to return
   * @returns Promise resolving to array of command strings
   */
  history(limit?: number): Promise<string[]>

  /**
   * Get environment variables
   *
   * @param name - Optional name to filter to a specific variable
   * @returns Promise resolving to key-value pairs of environment variables
   */
  env(name?: string): Promise<Record<string, string>>
}

// ============================================================================
// Tool Schema Types
// ============================================================================

/**
 * JSON Schema for tool input
 */
export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, {
    type: string
    description: string
  }>
  required: string[]
}

/**
 * MCP Tool definition
 */
export interface ToolDefinition {
  /** Tool name */
  name: string
  /** Tool description */
  description: string
  /** Input schema */
  inputSchema: ToolInputSchema
}

// ============================================================================
// Handler Types
// ============================================================================

/**
 * Options for creating the do handler
 */
export interface DoHandlerOptions {
  /** Bash binding for command execution */
  bash?: BashBinding
}

/**
 * Handler function type for search tool
 */
export type SearchHandler = (input: SearchToolInput) => Promise<SearchToolOutput>

/**
 * Handler function type for fetch tool
 */
export type FetchHandler = (input: FetchToolInput) => Promise<FetchToolOutput>

/**
 * Handler function type for do tool
 */
export type DoHandler = (input: DoToolInput) => Promise<DoToolOutput>
