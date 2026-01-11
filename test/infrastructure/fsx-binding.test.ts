/**
 * FSX Service Binding Tests (RED)
 *
 * These tests verify that FSX service binding works correctly in the vitest
 * environment. The tests should FAIL initially because the FSX binding is
 * not available in the vitest-pool-workers environment.
 *
 * The FSX binding (env.FSX) provides filesystem operations via the fsx.do
 * service. In production, this is configured in wrangler.toml as:
 *
 *   [[services]]
 *   binding = "FSX"
 *   service = "fsx-do"
 *
 * For tests to work, we need:
 * 1. A mock FSX service or test fixture in vitest config
 * 2. The vitest-pool-workers to inject the FSX binding into env
 *
 * @see src/do/worker.ts - FsxServiceAdapter that uses the FSX binding
 * @see wrangler.toml - FSX service binding configuration
 */

import { describe, it, expect, beforeAll } from 'vitest'
import type { FsCapability, Stats, Dirent } from 'fsx.do'

// ============================================================================
// FSX Service Binding Tests
// ============================================================================

/**
 * Expected environment interface for bashx-do workers.
 * This matches the Env type defined in src/do/worker.ts
 */
interface TestEnv {
  /** Service binding to fsx-do for filesystem operations */
  FSX: Fetcher
}

/**
 * Get the test environment.
 * In vitest-pool-workers, env is available via import.meta.env or globalThis.env
 */
function getTestEnv(): TestEnv {
  // vitest-pool-workers should inject env into the global context
  // This will fail if FSX binding is not configured
  const env = (globalThis as unknown as { env?: TestEnv }).env
  if (!env) {
    throw new Error(
      'Test environment not available. ' +
      'FSX service binding requires vitest-pool-workers configuration. ' +
      'See wrangler.toml for service binding setup.'
    )
  }
  if (!env.FSX) {
    throw new Error(
      'FSX service binding not available in test environment. ' +
      'Configure FSX binding in vitest poolOptions.workers.wrangler. ' +
      'Expected env.FSX to be a Fetcher instance.'
    )
  }
  return env
}

describe('FSX Service Binding', () => {
  describe('Binding Availability', () => {
    it('should have FSX binding available in test environment', () => {
      // This test verifies the FSX binding exists in the test environment
      // It should fail with: "FSX service binding not available in test environment"
      const env = getTestEnv()

      expect(env.FSX).toBeDefined()
      expect(typeof env.FSX.fetch).toBe('function')
    })

    it('should be able to make RPC calls to FSX service', async () => {
      // This test verifies basic RPC communication with FSX
      // It should fail because FSX service is not bound in tests
      const env = getTestEnv()

      const response = await env.FSX.fetch('https://fsx.do/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'stat',
          params: { path: '/' },
        }),
      })

      expect(response.ok).toBe(true)
      const result = await response.json()
      expect(result).toBeDefined()
    })
  })

  describe('FsxServiceAdapter Integration', () => {
    /**
     * FsxServiceAdapter - Adapts the FSX Fetcher binding to FsCapability interface.
     * This is a simplified version of the adapter in src/do/worker.ts for testing.
     */
    class FsxServiceAdapter {
      constructor(private readonly fsx: Fetcher) {}

      async read(
        path: string,
        options?: { encoding?: string; start?: number; end?: number }
      ): Promise<string | Uint8Array> {
        const response = await this.fsx.fetch('https://fsx.do/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'readFile',
            params: { path, encoding: options?.encoding },
          }),
        })

        if (!response.ok) {
          const error = await response.json() as { code?: string; message?: string }
          throw Object.assign(new Error(error.message || 'Read failed'), { code: error.code })
        }

        const result = await response.json() as { data: string | number[] }

        if (options?.encoding === 'utf-8' || options?.encoding === 'utf8') {
          return result.data as string
        }

        if (Array.isArray(result.data)) {
          return new Uint8Array(result.data)
        }

        return result.data as string
      }

      async write(
        path: string,
        data: string | Uint8Array,
        options?: { mode?: number; flag?: string }
      ): Promise<void> {
        const response = await this.fsx.fetch('https://fsx.do/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'writeFile',
            params: { path, data, ...options },
          }),
        })

        if (!response.ok) {
          const error = await response.json() as { code?: string; message?: string }
          throw Object.assign(new Error(error.message || 'Write failed'), { code: error.code })
        }
      }

      async exists(path: string): Promise<boolean> {
        try {
          await this.stat(path)
          return true
        } catch {
          return false
        }
      }

      async stat(path: string): Promise<{
        size: number
        mtime: Date
        isFile(): boolean
        isDirectory(): boolean
      }> {
        const response = await this.fsx.fetch('https://fsx.do/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'stat',
            params: { path },
          }),
        })

        if (!response.ok) {
          const error = await response.json() as { code?: string; message?: string }
          throw Object.assign(new Error(error.message || 'Stat failed'), { code: error.code })
        }

        const result = await response.json() as {
          size: number
          mtime: number
          mode: number
        }

        const isDir = (result.mode & 0o40000) === 0o40000

        return {
          size: result.size,
          mtime: new Date(result.mtime),
          isFile: () => !isDir,
          isDirectory: () => isDir,
        }
      }

      async list(
        path: string,
        options?: { withFileTypes?: boolean }
      ): Promise<Array<string | { name: string; isDirectory(): boolean }>> {
        const response = await this.fsx.fetch('https://fsx.do/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'readdir',
            params: { path, withFileTypes: options?.withFileTypes },
          }),
        })

        if (!response.ok) {
          const error = await response.json() as { code?: string; message?: string }
          throw Object.assign(new Error(error.message || 'List failed'), { code: error.code })
        }

        const result = await response.json() as {
          entries: Array<string | { name: string; type: string }>
        }

        if (options?.withFileTypes) {
          return (result.entries as Array<{ name: string; type: string }>).map((e) => ({
            name: e.name,
            isDirectory: () => e.type === 'directory',
          }))
        }

        return result.entries as string[]
      }

      async unlink(path: string): Promise<void> {
        const response = await this.fsx.fetch('https://fsx.do/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'unlink',
            params: { path },
          }),
        })

        if (!response.ok) {
          const error = await response.json() as { code?: string; message?: string }
          throw Object.assign(new Error(error.message || 'Unlink failed'), { code: error.code })
        }
      }

      async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
        const response = await this.fsx.fetch('https://fsx.do/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'mkdir',
            params: { path, ...options },
          }),
        })

        if (!response.ok) {
          const error = await response.json() as { code?: string; message?: string }
          throw Object.assign(new Error(error.message || 'Mkdir failed'), { code: error.code })
        }
      }

      async rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
        const response = await this.fsx.fetch('https://fsx.do/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'rmdir',
            params: { path, ...options },
          }),
        })

        if (!response.ok) {
          const error = await response.json() as { code?: string; message?: string }
          throw Object.assign(new Error(error.message || 'Rmdir failed'), { code: error.code })
        }
      }
    }

    let fs: FsxServiceAdapter

    beforeAll(() => {
      // This will fail because FSX binding is not available
      const env = getTestEnv()
      fs = new FsxServiceAdapter(env.FSX)
    })

    describe('File Operations', () => {
      it('should read a file via FSX binding', async () => {
        // Should fail: FSX binding not configured in vitest
        const content = await fs.read('/test.txt', { encoding: 'utf-8' })
        expect(content).toBe('test content')
      })

      it('should write a file via FSX binding', async () => {
        // Should fail: FSX binding not configured in vitest
        await fs.write('/new-file.txt', 'hello world')
        const content = await fs.read('/new-file.txt', { encoding: 'utf-8' })
        expect(content).toBe('hello world')
      })

      it('should check if file exists via FSX binding', async () => {
        // Should fail: FSX binding not configured in vitest
        const exists = await fs.exists('/test.txt')
        expect(typeof exists).toBe('boolean')
      })

      it('should get file stats via FSX binding', async () => {
        // Should fail: FSX binding not configured in vitest
        const stats = await fs.stat('/test.txt')
        expect(stats.size).toBeGreaterThanOrEqual(0)
        expect(stats.mtime).toBeInstanceOf(Date)
        expect(typeof stats.isFile).toBe('function')
        expect(typeof stats.isDirectory).toBe('function')
      })

      it('should delete a file via FSX binding', async () => {
        // Should fail: FSX binding not configured in vitest
        await fs.write('/to-delete.txt', 'temp')
        await fs.unlink('/to-delete.txt')
        const exists = await fs.exists('/to-delete.txt')
        expect(exists).toBe(false)
      })
    })

    describe('Directory Operations', () => {
      it('should list directory contents via FSX binding', async () => {
        // Should fail: FSX binding not configured in vitest
        const entries = await fs.list('/')
        expect(Array.isArray(entries)).toBe(true)
      })

      it('should list directory with file types via FSX binding', async () => {
        // Should fail: FSX binding not configured in vitest
        const entries = await fs.list('/', { withFileTypes: true })
        expect(Array.isArray(entries)).toBe(true)
        if (entries.length > 0) {
          const entry = entries[0] as { name: string; isDirectory(): boolean }
          expect(typeof entry.name).toBe('string')
          expect(typeof entry.isDirectory).toBe('function')
        }
      })

      it('should create a directory via FSX binding', async () => {
        // Should fail: FSX binding not configured in vitest
        await fs.mkdir('/test-dir')
        const stats = await fs.stat('/test-dir')
        expect(stats.isDirectory()).toBe(true)
      })

      it('should create nested directories recursively via FSX binding', async () => {
        // Should fail: FSX binding not configured in vitest
        await fs.mkdir('/nested/deep/path', { recursive: true })
        const stats = await fs.stat('/nested/deep/path')
        expect(stats.isDirectory()).toBe(true)
      })

      it('should remove a directory via FSX binding', async () => {
        // Should fail: FSX binding not configured in vitest
        await fs.mkdir('/to-remove')
        await fs.rmdir('/to-remove')
        const exists = await fs.exists('/to-remove')
        expect(exists).toBe(false)
      })

      it('should remove directory recursively via FSX binding', async () => {
        // Should fail: FSX binding not configured in vitest
        await fs.mkdir('/parent/child', { recursive: true })
        await fs.write('/parent/child/file.txt', 'content')
        await fs.rmdir('/parent', { recursive: true })
        const exists = await fs.exists('/parent')
        expect(exists).toBe(false)
      })
    })
  })

  describe('Error Handling', () => {
    it('should throw ENOENT for non-existent file read', async () => {
      // Should fail: FSX binding not configured in vitest
      const env = getTestEnv()
      const fs = new FsxServiceAdapterForErrors(env.FSX)

      await expect(fs.read('/does-not-exist.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })

    it('should throw ENOENT for non-existent file stat', async () => {
      // Should fail: FSX binding not configured in vitest
      const env = getTestEnv()
      const fs = new FsxServiceAdapterForErrors(env.FSX)

      await expect(fs.stat('/does-not-exist.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })

    it('should throw EEXIST when creating existing directory without recursive', async () => {
      // Should fail: FSX binding not configured in vitest
      const env = getTestEnv()
      const fs = new FsxServiceAdapterForErrors(env.FSX)

      // First create
      await fs.mkdir('/exists-dir')
      // Second create should fail
      await expect(fs.mkdir('/exists-dir')).rejects.toMatchObject({
        code: 'EEXIST',
      })
    })

    it('should throw ENOTDIR when listing a file', async () => {
      // Should fail: FSX binding not configured in vitest
      const env = getTestEnv()
      const fs = new FsxServiceAdapterForErrors(env.FSX)

      await fs.write('/file.txt', 'content')
      await expect(fs.list('/file.txt')).rejects.toMatchObject({
        code: 'ENOTDIR',
      })
    })

    it('should throw EISDIR when reading a directory', async () => {
      // Should fail: FSX binding not configured in vitest
      const env = getTestEnv()
      const fs = new FsxServiceAdapterForErrors(env.FSX)

      await fs.mkdir('/a-dir')
      await expect(fs.read('/a-dir')).rejects.toMatchObject({
        code: 'EISDIR',
      })
    })
  })
})

/**
 * Simplified adapter for error handling tests.
 * Uses the same RPC pattern as FsxServiceAdapter.
 */
class FsxServiceAdapterForErrors {
  constructor(private readonly fsx: Fetcher) {}

  async read(path: string): Promise<string | Uint8Array> {
    const response = await this.fsx.fetch('https://fsx.do/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'readFile', params: { path } }),
    })
    if (!response.ok) {
      const error = await response.json() as { code?: string; message?: string }
      throw Object.assign(new Error(error.message || 'Read failed'), { code: error.code })
    }
    const result = await response.json() as { data: string }
    return result.data
  }

  async write(path: string, data: string): Promise<void> {
    const response = await this.fsx.fetch('https://fsx.do/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'writeFile', params: { path, data } }),
    })
    if (!response.ok) {
      const error = await response.json() as { code?: string; message?: string }
      throw Object.assign(new Error(error.message || 'Write failed'), { code: error.code })
    }
  }

  async stat(path: string): Promise<{ size: number; mtime: Date; isFile(): boolean; isDirectory(): boolean }> {
    const response = await this.fsx.fetch('https://fsx.do/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'stat', params: { path } }),
    })
    if (!response.ok) {
      const error = await response.json() as { code?: string; message?: string }
      throw Object.assign(new Error(error.message || 'Stat failed'), { code: error.code })
    }
    const result = await response.json() as { size: number; mtime: number; mode: number }
    const isDir = (result.mode & 0o40000) === 0o40000
    return {
      size: result.size,
      mtime: new Date(result.mtime),
      isFile: () => !isDir,
      isDirectory: () => isDir,
    }
  }

  async mkdir(path: string): Promise<void> {
    const response = await this.fsx.fetch('https://fsx.do/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'mkdir', params: { path } }),
    })
    if (!response.ok) {
      const error = await response.json() as { code?: string; message?: string }
      throw Object.assign(new Error(error.message || 'Mkdir failed'), { code: error.code })
    }
  }

  async list(path: string): Promise<string[]> {
    const response = await this.fsx.fetch('https://fsx.do/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'readdir', params: { path } }),
    })
    if (!response.ok) {
      const error = await response.json() as { code?: string; message?: string }
      throw Object.assign(new Error(error.message || 'List failed'), { code: error.code })
    }
    const result = await response.json() as { entries: string[] }
    return result.entries
  }
}

// ============================================================================
// Type Tests (compile-time verification)
// ============================================================================

describe('Type Definitions', () => {
  it('should have correct FsCapability interface shape', () => {
    // Compile-time verification that FsCapability has expected methods
    type RequiredMethods = keyof FsCapability

    // These are core methods that must exist
    const expectedMethods: RequiredMethods[] = [
      'read',
      'write',
      'exists',
      'stat',
      'list',
      'mkdir',
      'rmdir',
      'unlink',
    ]

    expect(expectedMethods.length).toBeGreaterThan(0)
  })

  it('should have Stats class with POSIX-like methods', () => {
    // Verify Stats has the expected method signatures
    type StatsMethods = keyof Stats

    const expectedMethods: StatsMethods[] = [
      'isFile',
      'isDirectory',
      'isSymbolicLink',
    ]

    expect(expectedMethods.length).toBeGreaterThan(0)
  })

  it('should have Dirent class with type-checking methods', () => {
    // Verify Dirent has the expected method signatures
    type DirentMethods = keyof Dirent

    const expectedMethods: DirentMethods[] = [
      'name',
      'isFile',
      'isDirectory',
    ]

    expect(expectedMethods.length).toBeGreaterThan(0)
  })
})
