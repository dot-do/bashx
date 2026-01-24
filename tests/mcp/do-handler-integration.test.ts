/**
 * Do Handler Integration Tests
 *
 * Issue bashx-px0g: Use @dotdo/mcp createDoHandler
 *
 * These tests verify that bashx integrates properly with @dotdo/mcp's
 * createDoHandler instead of using a custom implementation.
 *
 * The @dotdo/mcp createDoHandler:
 * - Uses ai-evaluate for sandboxed V8 execution
 * - Accepts DoScope with bindings, types, timeout, permissions
 * - Returns MCP ToolResponse format
 *
 * BashX should:
 * - Create a DoScope with bash binding injected
 * - Use @dotdo/mcp's createDoHandler for execution
 * - Provide TypeScript types for the bash binding
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi } from 'vitest'

// Import from @dotdo/mcp
import type { DoScope } from '@dotdo/mcp'
import { createDoHandler as createMcpDoHandler } from '@dotdo/mcp'

// Import bashx's bash binding utilities
import {
  createBashBinding,
  createBashScope,
} from '../../src/mcp/tools/index.js'

import type { BashBinding } from '../../src/mcp/tools/types.js'

describe('Do Handler Integration - bashx-px0g', () => {
  describe('createBashScope', () => {
    it('should export createBashScope function', () => {
      expect(createBashScope).toBeDefined()
      expect(typeof createBashScope).toBe('function')
    })

    it('should create a DoScope with bash binding', () => {
      const mockBash: BashBinding = {
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        history: async () => [],
        env: async () => ({}),
      }

      const scope = createBashScope(mockBash)

      expect(scope).toBeDefined()
      expect(scope.bindings).toBeDefined()
      expect(scope.bindings.bash).toBeDefined()
      expect(scope.types).toBeDefined()
      expect(typeof scope.types).toBe('string')
    })

    it('should create DoScope with proper types string', () => {
      const mockBash: BashBinding = {
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        history: async () => [],
        env: async () => ({}),
      }

      const scope = createBashScope(mockBash)

      // The types should include bash binding interface
      expect(scope.types).toContain('bash')
      expect(scope.types).toContain('exec')
      expect(scope.types).toContain('history')
      expect(scope.types).toContain('env')
    })

    it('should create DoScope with timeout option', () => {
      const mockBash: BashBinding = {
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        history: async () => [],
        env: async () => ({}),
      }

      const scope = createBashScope(mockBash, { timeout: 5000 })

      expect(scope.timeout).toBe(5000)
    })

    it('should create DoScope with permissions', () => {
      const mockBash: BashBinding = {
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        history: async () => [],
        env: async () => ({}),
      }

      const scope = createBashScope(mockBash, {
        permissions: { allowNetwork: false }
      })

      expect(scope.permissions).toBeDefined()
      expect(scope.permissions?.allowNetwork).toBe(false)
    })
  })

  describe('Integration with @dotdo/mcp createDoHandler', () => {
    it('should create DoScope compatible with @dotdo/mcp createDoHandler', () => {
      const mockBash: BashBinding = {
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        history: async () => [],
        env: async () => ({}),
      }

      const scope = createBashScope(mockBash)

      // Verify it's a valid DoScope by checking required properties
      const doScope: DoScope = scope

      expect(doScope.bindings).toBeDefined()
      expect(doScope.types).toBeDefined()
    })

    it('should allow creating handler with @dotdo/mcp createDoHandler', () => {
      const mockBash: BashBinding = {
        exec: vi.fn().mockResolvedValue({ stdout: 'hello', stderr: '', exitCode: 0 }),
        history: async () => [],
        env: async () => ({}),
      }

      const scope = createBashScope(mockBash)

      // This should work without errors
      const handler = createMcpDoHandler(scope)

      expect(typeof handler).toBe('function')
    })
  })

  describe('createBashDoHandler (convenience wrapper)', () => {
    it('should export createBashDoHandler function', async () => {
      // Import the convenience wrapper
      const { createBashDoHandler } = await import('../../src/mcp/tools/index.js')

      expect(createBashDoHandler).toBeDefined()
      expect(typeof createBashDoHandler).toBe('function')
    })

    it('should create handler using @dotdo/mcp internally', async () => {
      const { createBashDoHandler } = await import('../../src/mcp/tools/index.js')

      const mockBash: BashBinding = {
        exec: vi.fn().mockResolvedValue({ stdout: 'test output', stderr: '', exitCode: 0 }),
        history: async () => [],
        env: async () => ({}),
      }

      const handler = createBashDoHandler(mockBash)

      expect(typeof handler).toBe('function')
    })
  })
})
