/**
 * Fetch Tool Implementation
 *
 * Provides resource retrieval by identifier for the MCP pattern.
 * Fetches history entries, environment variables, or registered resources.
 *
 * @packageDocumentation
 */

import type {
  ToolDefinition,
  FetchToolInput,
  FetchToolOutput,
  FetchHandler,
} from './types.js'

/**
 * Fetch tool schema definition
 */
export const fetchTool: ToolDefinition = {
  name: 'fetch',
  description: 'Fetch a resource by its identifier. Can retrieve history entries, environment variables, or other registered resources.',
  inputSchema: {
    type: 'object',
    properties: {
      resource: {
        type: 'string',
        description: 'The resource identifier to fetch (e.g., "history:0", "env:PATH", or a registered resource ID)',
      },
    },
    required: ['resource'],
  },
}

/**
 * Resource store for registered fetchable items
 */
const resourceStore: Map<string, { content: unknown; metadata?: Record<string, unknown> }> = new Map()

/**
 * Register a resource that can be fetched
 */
export function registerResource(
  id: string,
  content: unknown,
  metadata?: Record<string, unknown>
): void {
  resourceStore.set(id, { content, metadata })
}

/**
 * Unregister a resource
 */
export function unregisterResource(id: string): boolean {
  return resourceStore.delete(id)
}

/**
 * Clear all registered resources (useful for testing)
 */
export function clearResources(): void {
  resourceStore.clear()
}

/**
 * Get the count of registered resources
 */
export function getResourceCount(): number {
  return resourceStore.size
}

/**
 * Fetch a resource from the store
 */
function fetchFromStore(id: string): { content: unknown; metadata?: Record<string, unknown> } | null {
  return resourceStore.get(id) ?? null
}

/**
 * Create a fetch handler
 *
 * The handler retrieves resources by identifier:
 * - Registered resources are fetched from the store
 * - Future: Could support "history:N" for history entries
 * - Future: Could support "env:NAME" for environment variables
 *
 * @returns A fetch handler function
 */
export function createFetchHandler(): FetchHandler {
  return async (input: FetchToolInput): Promise<FetchToolOutput> => {
    const { resource } = input

    // Try to fetch from the store
    const stored = fetchFromStore(resource)

    if (stored) {
      return {
        resource,
        content: stored.content,
        metadata: stored.metadata,
      }
    }

    // Resource not found - return empty content
    return {
      resource,
      content: null,
      metadata: {
        found: false,
        error: `Resource '${resource}' not found`,
      },
    }
  }
}
