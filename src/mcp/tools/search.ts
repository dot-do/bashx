/**
 * Search Tool Implementation
 *
 * Provides query-based resource discovery for the MCP pattern.
 * Searches through command history and available resources.
 *
 * @packageDocumentation
 */

import type {
  ToolDefinition,
  SearchToolInput,
  SearchToolOutput,
  SearchResult,
  SearchHandler,
} from './types.js'

/**
 * Search tool schema definition
 */
export const searchTool: ToolDefinition = {
  name: 'search',
  description: 'Search for resources, commands, or history entries by query. Returns matching results that can be fetched or executed.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to find matching resources or command history entries',
      },
    },
    required: ['query'],
  },
}

/**
 * Internal search data store
 * Can be populated by other tools or external sources
 */
const searchIndex: Map<string, SearchResult> = new Map()

/**
 * Register an item in the search index
 */
export function registerSearchItem(item: SearchResult): void {
  searchIndex.set(item.id, item)
}

/**
 * Clear the search index (useful for testing)
 */
export function clearSearchIndex(): void {
  searchIndex.clear()
}

/**
 * Get current search index size
 */
export function getSearchIndexSize(): number {
  return searchIndex.size
}

/**
 * Search for items matching the query
 *
 * Performs case-insensitive matching on:
 * - id
 * - title
 * - description
 */
function searchItems(query: string): SearchResult[] {
  const lowerQuery = query.toLowerCase()
  const results: SearchResult[] = []

  for (const item of searchIndex.values()) {
    const idMatch = item.id.toLowerCase().includes(lowerQuery)
    const titleMatch = item.title.toLowerCase().includes(lowerQuery)
    const descMatch = item.description?.toLowerCase().includes(lowerQuery) ?? false

    if (idMatch || titleMatch || descMatch) {
      results.push(item)
    }
  }

  return results
}

/**
 * Create a search handler
 *
 * The handler searches through the internal index for matching results.
 * Results can be populated by registering items with registerSearchItem().
 *
 * @returns A search handler function
 */
export function createSearchHandler(): SearchHandler {
  return async (input: SearchToolInput): Promise<SearchToolOutput> => {
    const { query } = input

    // Search the index
    const results = searchItems(query)

    return {
      query,
      results,
    }
  }
}
