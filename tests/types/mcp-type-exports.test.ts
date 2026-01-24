/**
 * MCP Type Exports - TDD Tests for Direct Re-exports
 *
 * Issue bashx-4pa8: Types module re-wraps instead of directly re-exporting
 *
 * These tests verify that types from @dotdo/mcp are directly re-exported
 * (not re-wrapped) from bashx's src/mcp/tools/types.ts.
 *
 * A direct re-export means:
 * - Using `export type { Tool } from '@dotdo/mcp'`
 * - NOT copying the interface definition locally
 *
 * Benefits:
 * - Single source of truth for types
 * - Type compatibility between packages
 * - Reduced maintenance burden
 *
 * Types that should be re-exported from @dotdo/mcp:
 * - Tool, ToolHandler, ToolRegistry (infrastructure)
 * - SearchInput, FetchInput, DoInput (input types)
 * - DoResult, DoOptions, etc. (do-related types)
 *
 * Types that are bashx-specific (not in @dotdo/mcp):
 * - SearchToolOutput, FetchToolOutput, DoToolOutput (bashx output format)
 * - BashBinding, ExecResult (bash execution binding)
 * - SearchResult (bashx version with optional description)
 *
 * @packageDocumentation
 */

import { describe, it, expect } from 'vitest'

// Import types from @dotdo/mcp directly
// The main entry point re-exports all types from tools/index.js
import type {
  Tool as McpTool,
  ToolHandler as McpToolHandler,
  ToolRegistry as McpToolRegistry,
  SearchInput as McpSearchInput,
  FetchInput as McpFetchInput,
  DoInput as McpDoInput,
  DoResult as McpDoResult,
} from '@dotdo/mcp'

// Import types from bashx's re-exports
import type {
  Tool as BashxTool,
  ToolHandler as BashxToolHandler,
  ToolRegistry as BashxToolRegistry,
  // Input types that should be re-exported from @dotdo/mcp
  SearchInput as BashxSearchInput,
  FetchInput as BashxFetchInput,
  DoInput as BashxDoInput,
  DoResult as BashxDoResult,
} from '../../src/mcp/tools/types.js'

describe('MCP Type Re-exports - bashx-4pa8', () => {
  describe('Tool type re-export', () => {
    it('should allow using @dotdo/mcp Tool where bashx Tool is expected', () => {
      // Create a tool using the @dotdo/mcp type
      const mcpTool: McpTool = {
        name: 'test-tool',
        description: 'A test tool for type checking',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Input parameter' },
          },
          required: ['input'],
        },
      }

      // It should be assignable to bashx's Tool type if properly re-exported
      const bashxTool: BashxTool = mcpTool

      expect(bashxTool.name).toBe('test-tool')
      expect(bashxTool.description).toBe('A test tool for type checking')
    })

    it('should allow using bashx Tool where @dotdo/mcp Tool is expected', () => {
      // Create a tool using the bashx type
      const bashxTool: BashxTool = {
        name: 'bashx-tool',
        description: 'A bashx test tool',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Code to execute' },
          },
          required: ['code'],
        },
      }

      // It should be assignable to @dotdo/mcp's Tool type if properly re-exported
      const mcpTool: McpTool = bashxTool

      expect(mcpTool.name).toBe('bashx-tool')
    })
  })

  describe('ToolHandler type re-export', () => {
    it('should allow using @dotdo/mcp ToolHandler where bashx ToolHandler is expected', () => {
      // Create a handler using the @dotdo/mcp type
      const mcpHandler: McpToolHandler = async (input: unknown) => ({
        content: [{ type: 'text', text: JSON.stringify(input) }],
      })

      // It should be assignable to bashx's ToolHandler type if properly re-exported
      const bashxHandler: BashxToolHandler = mcpHandler

      expect(typeof bashxHandler).toBe('function')
    })

    it('should allow using bashx ToolHandler where @dotdo/mcp ToolHandler is expected', () => {
      // Create a handler using the bashx type
      const bashxHandler: BashxToolHandler = async (input: unknown) => ({
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      })

      // It should be assignable to @dotdo/mcp's ToolHandler type if properly re-exported
      const mcpHandler: McpToolHandler = bashxHandler

      expect(typeof mcpHandler).toBe('function')
    })
  })

  describe('ToolRegistry type re-export', () => {
    it('should allow using @dotdo/mcp ToolRegistry where bashx ToolRegistry is expected', () => {
      // Create a registry using the @dotdo/mcp type
      const mcpRegistry: McpToolRegistry = {
        tools: {},
        handlers: {},
        register: (tool, handler) => {
          mcpRegistry.tools[tool.name] = tool
          mcpRegistry.handlers[tool.name] = handler
        },
        getHandler: (name) => mcpRegistry.handlers[name],
        list: () => Object.values(mcpRegistry.tools),
      }

      // It should be assignable to bashx's ToolRegistry type if properly re-exported
      const bashxRegistry: BashxToolRegistry = mcpRegistry

      expect(bashxRegistry.tools).toEqual({})
      expect(typeof bashxRegistry.register).toBe('function')
    })
  })

  describe('Type identity verification', () => {
    it('Tool types should be structurally identical', () => {
      // This test verifies that the types have the same structure
      const tool: BashxTool & McpTool = {
        name: 'identity-test',
        description: 'Tests type identity',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      }

      // If the types are truly re-exported (not re-wrapped), this should work
      expect(tool.name).toBe('identity-test')
    })

    it('ToolHandler types should be structurally identical', () => {
      // Create a handler that satisfies both types
      const handler: BashxToolHandler & McpToolHandler = async () => ({
        content: [{ type: 'text', text: 'ok' }],
      })

      expect(typeof handler).toBe('function')
    })
  })

  // ==========================================================================
  // Input Type Re-exports from @dotdo/mcp
  // ==========================================================================
  describe('Input type re-exports from @dotdo/mcp', () => {
    it('SearchInput should be re-exported from @dotdo/mcp', () => {
      // Create input using @dotdo/mcp type
      const mcpInput: McpSearchInput = { query: 'test query', limit: 10 }

      // Should be assignable to bashx's SearchInput if properly re-exported
      const bashxInput: BashxSearchInput = mcpInput

      expect(bashxInput.query).toBe('test query')
      expect(bashxInput.limit).toBe(10)
    })

    it('FetchInput should be re-exported from @dotdo/mcp', () => {
      // Create input using @dotdo/mcp type
      const mcpInput: McpFetchInput = { resource: 'test-resource' }

      // Should be assignable to bashx's FetchInput if properly re-exported
      const bashxInput: BashxFetchInput = mcpInput

      expect(bashxInput.resource).toBe('test-resource')
    })

    it('DoInput should be re-exported from @dotdo/mcp', () => {
      // Create input using @dotdo/mcp type
      const mcpInput: McpDoInput = { code: 'return 42' }

      // Should be assignable to bashx's DoInput if properly re-exported
      const bashxInput: BashxDoInput = mcpInput

      expect(bashxInput.code).toBe('return 42')
    })

    it('DoResult should be re-exported from @dotdo/mcp', () => {
      // Create result using @dotdo/mcp type
      const mcpResult: McpDoResult = {
        success: true,
        value: 42,
        logs: [{ level: 'info', message: 'test', timestamp: Date.now() }],
        duration: 100,
      }

      // Should be assignable to bashx's DoResult if properly re-exported
      const bashxResult: BashxDoResult = mcpResult

      expect(bashxResult.success).toBe(true)
      expect(bashxResult.value).toBe(42)
    })
  })
})
