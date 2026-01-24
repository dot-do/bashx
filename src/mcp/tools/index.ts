/**
 * MCP Search/Fetch/Do Tools
 *
 * Core tools for the MCP pattern:
 * - search: Query-based resource discovery
 * - fetch: Resource retrieval by identifier
 * - do: Code execution with bash binding
 *
 * Shared tool infrastructure types (Tool, ToolHandler, ToolRegistry)
 * are re-exported from @dotdo/mcp.
 *
 * @packageDocumentation
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
  // Shared types from @dotdo/mcp (re-exported via ./types.js)
  Tool,
  ToolHandler,
  ToolRegistry,
  // Search types
  SearchToolInput,
  SearchToolOutput,
  SearchResult,
  SearchHandler,
  // Fetch types
  FetchToolInput,
  FetchToolOutput,
  FetchHandler,
  // Do types
  DoToolInput,
  DoToolOutput,
  DoHandler,
  DoHandlerOptions,
  // Bash binding types (BashX-specific)
  BashBinding,
  ExecResult,
  // Tool schema types
  ToolDefinition,
  ToolInputSchema,
} from './types.js'

// ============================================================================
// Search Tool Exports
// ============================================================================

export {
  searchTool,
  createSearchHandler,
  registerSearchItem,
  clearSearchIndex,
  getSearchIndexSize,
} from './search.js'

// ============================================================================
// Fetch Tool Exports
// ============================================================================

export {
  fetchTool,
  createFetchHandler,
  registerResource,
  unregisterResource,
  clearResources,
  getResourceCount,
} from './fetch.js'

// ============================================================================
// Do Tool Exports
// ============================================================================

export {
  doTool,
  createDoHandler,
} from './do.js'

// ============================================================================
// Bash Binding Exports
// ============================================================================

export {
  createBashBinding,
  clearHistory,
  getHistoryCount,
  defaultBashBinding,
} from './bash-binding.js'
