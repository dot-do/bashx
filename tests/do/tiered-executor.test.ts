/**
 * Tests for TieredExecutor
 *
 * Verifies the 4-tier execution model:
 * - Tier 1: Native in-Worker via nodejs_compat_v2
 * - Tier 2: RPC bindings for jq.do/npm.do
 * - Tier 3: worker_loaders for dynamic npm
 * - Tier 4: Sandbox SDK for true Linux needs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  TieredExecutor,
  createTieredExecutor,
  type TieredExecutorConfig,
  type SandboxBinding,
  type RpcServiceBinding,
  type WorkerLoaderBinding,
} from '../../src/do/tiered-executor.js'
import type { FsCapability, FsEntry, FsStat, BashResult } from '../../src/types.js'

// ============================================================================
// MOCK HELPERS
// ============================================================================

/**
 * Create a mock FsCapability that matches fsx.do's interface.
 *
 * fsx.do's FsCapability has:
 * - read(path, options?) - returns string when encoding is 'utf-8', Uint8Array otherwise
 * - list(path, options?) - returns Dirent[] (with methods) when withFileTypes: true
 * - stat(path) - returns Stats with isFile()/isDirectory() as methods
 */
function createMockFsCapability(): FsCapability {
  const files: Record<string, string> = {
    '/test.txt': 'hello world\n',
    '/multi.txt': 'line1\nline2\nline3\nline4\nline5\n',
    '/data.json': '{"name": "test"}\n',
  }

  // fsx.do returns Dirent-like objects with isDirectory() as a method
  const directories: Record<string, Array<{ name: string; isDirectory(): boolean }>> = {
    '/': [
      { name: 'test.txt', isDirectory: () => false },
      { name: 'multi.txt', isDirectory: () => false },
      { name: 'data.json', isDirectory: () => false },
      { name: 'subdir', isDirectory: () => true },
    ],
    '/subdir': [{ name: 'nested.txt', isDirectory: () => false }],
  }

  return {
    // fsx.do read() accepts options parameter with encoding
    read: async (path: string, options?: { encoding?: string }) => {
      if (files[path]) return files[path]
      throw new Error(`ENOENT: no such file: ${path}`)
    },
    exists: async (path) => path in files || path in directories,
    // fsx.do list() accepts options and returns Dirent[] with methods when withFileTypes: true
    list: async (path: string, options?: { withFileTypes?: boolean }) => {
      return directories[path] || []
    },
    // fsx.do stat() returns Stats with isFile()/isDirectory() as methods
    stat: async (path: string) => {
      if (files[path]) {
        return {
          size: files[path].length,
          // fsx.do Stats class has isFile() and isDirectory() as methods
          isDirectory: () => false,
          isFile: () => true,
          // Additional Stats properties for compatibility
          mode: 0o644,
          uid: 0,
          gid: 0,
          nlink: 1,
          dev: 0,
          ino: 0,
          rdev: 0,
          blksize: 4096,
          blocks: 0,
          atimeMs: Date.now(),
          mtimeMs: Date.now(),
          ctimeMs: Date.now(),
          birthtimeMs: Date.now(),
        }
      }
      if (directories[path]) {
        return {
          size: 0,
          // fsx.do Stats class has isFile() and isDirectory() as methods
          isDirectory: () => true,
          isFile: () => false,
          mode: 0o755,
          uid: 0,
          gid: 0,
          nlink: 1,
          dev: 0,
          ino: 0,
          rdev: 0,
          blksize: 4096,
          blocks: 0,
          atimeMs: Date.now(),
          mtimeMs: Date.now(),
          ctimeMs: Date.now(),
          birthtimeMs: Date.now(),
        }
      }
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    },
  } as unknown as FsCapability
}

function createMockSandbox(): SandboxBinding {
  return {
    execute: vi.fn(async (command: string): Promise<BashResult> => ({
      input: command,
      command,
      valid: true,
      generated: false,
      stdout: `sandbox: ${command}\n`,
      stderr: '',
      exitCode: 0,
      intent: {
        commands: [command.split(' ')[0]],
        reads: [],
        writes: [],
        deletes: [],
        network: false,
        elevated: false,
      },
      classification: {
        type: 'execute',
        impact: 'medium',
        reversible: false,
        reason: 'Executed via sandbox',
      },
    })),
  }
}

function createMockRpcBinding(): RpcServiceBinding {
  return {
    name: 'jq',
    endpoint: 'https://jq.do',
    commands: ['jq'],
  }
}

// ============================================================================
// TIER CLASSIFICATION TESTS
// ============================================================================

describe('TieredExecutor - Command Classification', () => {
  let executor: TieredExecutor

  beforeEach(() => {
    executor = new TieredExecutor({
      fs: createMockFsCapability(),
      sandbox: createMockSandbox(),
    })
  })

  describe('Tier 1 Classification', () => {
    it('classifies pure compute commands as Tier 1', () => {
      const commands = ['echo hello', 'printf test', 'true', 'false', 'date']

      for (const cmd of commands) {
        const classification = executor.classifyCommand(cmd)
        expect(classification.tier).toBe(1)
        expect(classification.handler).toBe('native')
        expect(classification.capability).toBe('compute')
      }
    })

    it('classifies filesystem commands as Tier 1 when fs is available', () => {
      const commands = ['cat /test.txt', 'ls /', 'head -n 5 /file', 'tail /log']

      for (const cmd of commands) {
        const classification = executor.classifyCommand(cmd)
        expect(classification.tier).toBe(1)
        expect(classification.handler).toBe('native')
        expect(classification.capability).toBe('fs')
      }
    })

    it('classifies filesystem commands as Tier 4 when fs is NOT available', () => {
      const noFsExecutor = new TieredExecutor({
        sandbox: createMockSandbox(),
      })

      const classification = noFsExecutor.classifyCommand('cat /test.txt')
      expect(classification.tier).toBe(4)
      expect(classification.handler).toBe('sandbox')
    })
  })

  describe('Tier 2 Classification', () => {
    it('classifies jq commands as Tier 2', () => {
      const classification = executor.classifyCommand('jq .name package.json')
      expect(classification.tier).toBe(2)
      expect(classification.handler).toBe('rpc')
      expect(classification.capability).toBe('jq')
    })

    it('classifies npm commands as Tier 2', () => {
      const commands = ['npm install', 'npx vitest', 'pnpm add lodash', 'yarn add react']

      for (const cmd of commands) {
        const classification = executor.classifyCommand(cmd)
        expect(classification.tier).toBe(2)
        expect(classification.handler).toBe('rpc')
        expect(classification.capability).toBe('npm')
      }
    })

    it('classifies git commands as Tier 2', () => {
      const classification = executor.classifyCommand('git status')
      expect(classification.tier).toBe(2)
      expect(classification.handler).toBe('rpc')
      expect(classification.capability).toBe('git')
    })
  })

  describe('Tier 4 Classification', () => {
    it('classifies docker commands as Tier 4', () => {
      const commands = ['docker ps', 'docker run alpine', 'docker-compose up']

      for (const cmd of commands) {
        const classification = executor.classifyCommand(cmd)
        expect(classification.tier).toBe(4)
        expect(classification.handler).toBe('sandbox')
      }
    })

    it('classifies network commands as Tier 4', () => {
      const commands = ['curl https://example.com', 'wget file.txt', 'ssh server']

      for (const cmd of commands) {
        const classification = executor.classifyCommand(cmd)
        expect(classification.tier).toBe(4)
        expect(classification.handler).toBe('sandbox')
      }
    })

    it('classifies system commands as Tier 4', () => {
      const commands = ['sudo apt install vim', 'chmod +x script.sh', 'ps aux']

      for (const cmd of commands) {
        const classification = executor.classifyCommand(cmd)
        expect(classification.tier).toBe(4)
        expect(classification.handler).toBe('sandbox')
      }
    })
  })
})

// ============================================================================
// TIER 1 EXECUTION TESTS
// ============================================================================

describe('TieredExecutor - Tier 1 Execution', () => {
  let executor: TieredExecutor

  beforeEach(() => {
    executor = new TieredExecutor({
      fs: createMockFsCapability(),
      sandbox: createMockSandbox(),
    })
  })

  describe('Pure Compute Commands', () => {
    it('executes echo command natively', async () => {
      const result = await executor.execute('echo hello world')
      expect(result.stdout).toBe('hello world\n')
      expect(result.exitCode).toBe(0)
    })

    it('executes true command with exit code 0', async () => {
      const result = await executor.execute('true')
      expect(result.exitCode).toBe(0)
    })

    it('executes false command with exit code 1', async () => {
      const result = await executor.execute('false')
      expect(result.exitCode).toBe(1)
    })

    it('executes date command', async () => {
      const result = await executor.execute('date')
      expect(result.stdout).toBeTruthy()
      expect(result.exitCode).toBe(0)
    })

    it('executes pwd command', async () => {
      const result = await executor.execute('pwd', { cwd: '/home/user' })
      expect(result.stdout).toBe('/home/user\n')
      expect(result.exitCode).toBe(0)
    })

    it('executes basename command', async () => {
      const result = await executor.execute('basename /path/to/file.txt')
      expect(result.stdout).toBe('file.txt\n')
    })

    it('executes dirname command', async () => {
      const result = await executor.execute('dirname /path/to/file.txt')
      expect(result.stdout).toBe('/path/to\n')
    })

    it('executes wc -l with stdin', async () => {
      const result = await executor.execute('wc -l', { stdin: 'line1\nline2\nline3\n' })
      expect(result.stdout).toBe('3\n')
    })

    it('executes sort with stdin', async () => {
      const result = await executor.execute('sort', { stdin: 'c\na\nb\n' })
      expect(result.stdout).toBe('a\nb\nc\n')
    })

    it('executes sort -r with stdin', async () => {
      const result = await executor.execute('sort -r', { stdin: 'a\nb\nc\n' })
      expect(result.stdout).toBe('c\nb\na\n')
    })
  })

  describe('Filesystem Commands', () => {
    it('executes cat command via FsCapability', async () => {
      const result = await executor.execute('cat /test.txt')
      expect(result.stdout).toBe('hello world\n')
      expect(result.exitCode).toBe(0)
    })

    it('handles cat with missing file', async () => {
      const result = await executor.execute('cat /nonexistent.txt')
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('ENOENT')
    })

    it('executes ls command via FsCapability', async () => {
      const result = await executor.execute('ls /')
      expect(result.stdout).toContain('test.txt')
      expect(result.stdout).toContain('subdir/')
      expect(result.exitCode).toBe(0)
    })

    it('executes head command via FsCapability', async () => {
      const result = await executor.execute('head -n2 /multi.txt')
      expect(result.stdout).toBe('line1\nline2\n')
    })

    it('executes tail command via FsCapability', async () => {
      const result = await executor.execute('tail -n2 /multi.txt')
      expect(result.stdout).toBe('line4\nline5\n')
    })

    it('executes test -e for existing file', async () => {
      const result = await executor.execute('test -e /test.txt')
      expect(result.exitCode).toBe(0)
    })

    it('executes test -e for non-existing file', async () => {
      const result = await executor.execute('test -e /nonexistent.txt')
      expect(result.exitCode).toBe(1)
    })

    it('executes test -f for regular file', async () => {
      const result = await executor.execute('test -f /test.txt')
      expect(result.exitCode).toBe(0)
    })

    it('executes test -d for directory', async () => {
      const result = await executor.execute('test -d /')
      expect(result.exitCode).toBe(0)
    })
  })
})

// ============================================================================
// TIER 2 EXECUTION TESTS (RPC)
// ============================================================================

describe('TieredExecutor - Tier 2 Execution (RPC)', () => {
  it('calls RPC endpoint for jq command', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        stdout: '{"filtered": true}\n',
        stderr: '',
        exitCode: 0,
      }),
    })

    vi.stubGlobal('fetch', mockFetch)

    const executor = new TieredExecutor({
      rpcBindings: {
        jq: {
          name: 'jq',
          endpoint: 'https://jq.do',
          commands: ['jq'],
        },
      },
    })

    const result = await executor.execute('jq .name package.json')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://jq.do/execute',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    )

    expect(result.stdout).toBe('{"filtered": true}\n')
    expect(result.exitCode).toBe(0)

    vi.unstubAllGlobals()
  })

  it('handles RPC error gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      text: async () => 'Service unavailable',
    })

    vi.stubGlobal('fetch', mockFetch)

    const executor = new TieredExecutor({
      rpcBindings: {
        jq: {
          name: 'jq',
          endpoint: 'https://jq.do',
          commands: ['jq'],
        },
      },
    })

    const result = await executor.execute('jq .name package.json')

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('RPC error')

    vi.unstubAllGlobals()
  })
})

// ============================================================================
// TIER 4 EXECUTION TESTS (SANDBOX)
// ============================================================================

describe('TieredExecutor - Tier 4 Execution (Sandbox)', () => {
  it('executes docker command via sandbox', async () => {
    const mockSandbox = createMockSandbox()
    const executor = new TieredExecutor({
      sandbox: mockSandbox,
    })

    const result = await executor.execute('docker ps')

    expect(mockSandbox.execute).toHaveBeenCalledWith('docker ps', undefined)
    expect(result.stdout).toContain('sandbox: docker ps')
  })

  it('executes curl command via sandbox', async () => {
    const mockSandbox = createMockSandbox()
    const executor = new TieredExecutor({
      sandbox: mockSandbox,
    })

    const result = await executor.execute('curl https://example.com')

    expect(mockSandbox.execute).toHaveBeenCalled()
    expect(result.exitCode).toBe(0)
  })

  it('throws error when sandbox not available', async () => {
    const executor = new TieredExecutor({})

    await expect(executor.execute('docker ps')).rejects.toThrow(
      'Sandbox not configured'
    )
  })

  it('passes options to sandbox execute', async () => {
    const mockSandbox = createMockSandbox()
    const executor = new TieredExecutor({
      sandbox: mockSandbox,
    })

    const options = { cwd: '/app', timeout: 5000 }
    await executor.execute('bash script.sh', options)

    expect(mockSandbox.execute).toHaveBeenCalledWith('bash script.sh', options)
  })
})

// ============================================================================
// FALLBACK TESTS
// ============================================================================

describe('TieredExecutor - Tier Fallback', () => {
  it('falls back to sandbox when Tier 2 RPC fails', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))
    vi.stubGlobal('fetch', mockFetch)

    const mockSandbox = createMockSandbox()
    const executor = new TieredExecutor({
      rpcBindings: {
        jq: {
          name: 'jq',
          endpoint: 'https://jq.do',
          commands: ['jq'],
        },
      },
      sandbox: mockSandbox,
    })

    const result = await executor.execute('jq .name package.json')

    // Should have tried RPC first, then fallen back to sandbox
    expect(mockFetch).toHaveBeenCalled()
    expect(mockSandbox.execute).toHaveBeenCalled()
    expect(result.stdout).toContain('sandbox:')

    vi.unstubAllGlobals()
  })
})

// ============================================================================
// CAPABILITIES TESTS
// ============================================================================

describe('TieredExecutor - Capabilities', () => {
  it('reports available capabilities', () => {
    const executor = new TieredExecutor({
      fs: createMockFsCapability(),
      rpcBindings: {
        jq: createMockRpcBinding(),
      },
      sandbox: createMockSandbox(),
    })

    const caps = executor.getCapabilities()

    expect(caps.tier1.available).toBe(true)
    expect(caps.tier1.commands).toContain('echo')
    expect(caps.tier1.commands).toContain('cat')

    expect(caps.tier2.available).toBe(true)
    expect(caps.tier2.services).toContain('jq')

    expect(caps.tier4.available).toBe(true)
  })

  it('checks tier availability for specific commands', () => {
    const executor = new TieredExecutor({
      fs: createMockFsCapability(),
      sandbox: createMockSandbox(),
    })

    expect(executor.isTierAvailable(1, 'echo hello')).toBe(true)
    expect(executor.isTierAvailable(1, 'cat file.txt')).toBe(true)
    expect(executor.isTierAvailable(1, 'docker ps')).toBe(false)

    expect(executor.isTierAvailable(4, 'docker ps')).toBe(true)
  })
})

// ============================================================================
// FACTORY FUNCTION TESTS
// ============================================================================

describe('createTieredExecutor', () => {
  it('creates executor from environment', () => {
    const env = {}
    const executor = createTieredExecutor(env, {
      fs: createMockFsCapability(),
      sandbox: createMockSandbox(),
    })

    expect(executor).toBeInstanceOf(TieredExecutor)
    expect(executor.isTierAvailable(1)).toBe(true)
    expect(executor.isTierAvailable(4)).toBe(true)
  })

  it('creates executor without options', () => {
    const executor = createTieredExecutor({})

    expect(executor).toBeInstanceOf(TieredExecutor)
    // Pure compute is always available
    expect(executor.isTierAvailable(1, 'echo test')).toBe(true)
    // Sandbox not available
    expect(executor.isTierAvailable(4)).toBe(false)
  })
})

// ============================================================================
// EDGE CASES
// ============================================================================

describe('TieredExecutor - Edge Cases', () => {
  let executor: TieredExecutor

  beforeEach(() => {
    executor = new TieredExecutor({
      fs: createMockFsCapability(),
      sandbox: createMockSandbox(),
    })
  })

  it('handles empty command', async () => {
    const classification = executor.classifyCommand('')
    expect(classification.tier).toBe(4)
  })

  it('handles command with env vars prefix', async () => {
    const classification = executor.classifyCommand('VAR=value echo hello')
    expect(classification.tier).toBe(1)
    expect(classification.capability).toBe('compute')
  })

  it('handles absolute path commands', async () => {
    const classification = executor.classifyCommand('/usr/bin/ls')
    expect(classification.tier).toBe(1)
    expect(classification.capability).toBe('fs')
  })

  it('handles quoted arguments correctly', async () => {
    const result = await executor.execute("echo 'hello world'")
    expect(result.stdout).toBe('hello world\n')
  })

  it('handles double-quoted arguments', async () => {
    const result = await executor.execute('echo "hello world"')
    expect(result.stdout).toBe('hello world\n')
  })

  it('preserves command result structure', async () => {
    const result = await executor.execute('echo test')

    expect(result).toHaveProperty('input')
    expect(result).toHaveProperty('command')
    expect(result).toHaveProperty('stdout')
    expect(result).toHaveProperty('stderr')
    expect(result).toHaveProperty('exitCode')
    expect(result).toHaveProperty('valid')
    expect(result).toHaveProperty('generated')
    expect(result).toHaveProperty('intent')
    expect(result).toHaveProperty('classification')
  })
})
