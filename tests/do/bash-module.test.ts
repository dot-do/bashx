/**
 * BashModule Tests
 *
 * Tests for the BashModule capability class.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BashModule, withBash, type BashExecutor } from '../../src/do/index.js'
import type { BashResult } from '../../src/types.js'

// Mock the parse and analyze imports since they throw NotImplemented
vi.mock('../../src/ast/parser.js', () => ({
  parse: vi.fn().mockReturnValue({
    type: 'Program',
    body: [],
    errors: [],
  }),
}))

vi.mock('../../src/ast/analyze.js', () => ({
  analyze: vi.fn().mockReturnValue({
    classification: { type: 'read', impact: 'none', reversible: true, reason: 'Safe command' },
    intent: { commands: ['ls'], reads: [], writes: [], deletes: [], network: false, elevated: false },
  }),
  isDangerous: vi.fn().mockReturnValue({ dangerous: false }),
}))

// Helper to create a mock executor
function createMockExecutor(results: Record<string, Partial<BashResult>> = {}): BashExecutor {
  return {
    execute: vi.fn(async (command: string): Promise<BashResult> => {
      const baseResult: BashResult = {
        input: command,
        command,
        valid: true,
        generated: false,
        stdout: '',
        stderr: '',
        exitCode: 0,
        intent: { commands: [], reads: [], writes: [], deletes: [], network: false, elevated: false },
        classification: { type: 'read', impact: 'none', reversible: true, reason: 'Mock' },
      }

      if (results[command]) {
        return { ...baseResult, ...results[command] }
      }

      return { ...baseResult, stdout: `executed: ${command}` }
    }),
  }
}

describe('BashModule', () => {
  describe('constructor', () => {
    it('should create a BashModule with an executor', () => {
      const executor = createMockExecutor()
      const bash = new BashModule(executor)

      expect(bash).toBeInstanceOf(BashModule)
      expect(bash.name).toBe('bash')
    })
  })

  describe('initialize / dispose', () => {
    it('should initialize without error', async () => {
      const executor = createMockExecutor()
      const bash = new BashModule(executor)

      await expect(bash.initialize()).resolves.toBeUndefined()
    })

    it('should be idempotent on multiple initializations', async () => {
      const executor = createMockExecutor()
      const bash = new BashModule(executor)

      await bash.initialize()
      await bash.initialize()

      // No error means success
    })

    it('should dispose without error', async () => {
      const executor = createMockExecutor()
      const bash = new BashModule(executor)

      await bash.initialize()
      await expect(bash.dispose()).resolves.toBeUndefined()
    })
  })

  describe('exec', () => {
    it('should execute a simple command', async () => {
      const executor = createMockExecutor({
        'ls': { stdout: 'file1.txt\nfile2.txt', exitCode: 0 },
      })
      const bash = new BashModule(executor)

      const result = await bash.exec('ls')

      expect(result.stdout).toBe('file1.txt\nfile2.txt')
      expect(result.exitCode).toBe(0)
      expect(executor.execute).toHaveBeenCalledWith('ls', undefined)
    })

    it('should execute a command with arguments', async () => {
      const executor = createMockExecutor({
        'git status --short': { stdout: 'M file.ts', exitCode: 0 },
      })
      const bash = new BashModule(executor)

      const result = await bash.exec('git', ['status', '--short'])

      expect(result.stdout).toBe('M file.ts')
      expect(executor.execute).toHaveBeenCalledWith('git status --short', undefined)
    })

    it('should execute a command with options', async () => {
      const executor = createMockExecutor({
        'npm install': { stdout: 'added 100 packages', exitCode: 0 },
      })
      const bash = new BashModule(executor)

      const options = { cwd: '/app', timeout: 60000 }
      await bash.exec('npm', ['install'], options)

      expect(executor.execute).toHaveBeenCalledWith('npm install', options)
    })

    it('should return error result for failed commands', async () => {
      const executor = createMockExecutor({
        'nonexistent-command': { stderr: 'command not found', exitCode: 127 },
      })
      const bash = new BashModule(executor)

      const result = await bash.exec('nonexistent-command')

      expect(result.exitCode).toBe(127)
      expect(result.stderr).toBe('command not found')
    })
  })

  describe('run', () => {
    it('should run a script', async () => {
      const script = 'echo "hello"\necho "world"'
      const executor = createMockExecutor({
        [script]: { stdout: 'hello\nworld', exitCode: 0 },
      })
      const bash = new BashModule(executor)

      const result = await bash.run(script)

      expect(result.stdout).toBe('hello\nworld')
      expect(executor.execute).toHaveBeenCalledWith(script, undefined)
    })

    it('should run a script with options', async () => {
      const script = 'npm run build'
      const executor = createMockExecutor({
        [script]: { stdout: 'Build complete', exitCode: 0 },
      })
      const bash = new BashModule(executor)

      const options = { cwd: '/app' }
      await bash.run(script, options)

      expect(executor.execute).toHaveBeenCalledWith(script, options)
    })
  })

  describe('spawn', () => {
    it('should throw if executor does not support spawn', async () => {
      const executor = createMockExecutor()
      const bash = new BashModule(executor)

      await expect(bash.spawn('tail', ['-f', '/var/log/app.log'])).rejects.toThrow(
        'Spawn not supported by this executor',
      )
    })

    it('should call executor spawn if available', async () => {
      const mockHandle = {
        pid: 1234,
        done: Promise.resolve({} as BashResult),
        kill: vi.fn(),
        write: vi.fn(),
        closeStdin: vi.fn(),
      }

      const executor: BashExecutor = {
        execute: vi.fn(),
        spawn: vi.fn().mockResolvedValue(mockHandle),
      }

      const bash = new BashModule(executor)
      const handle = await bash.spawn('tail', ['-f', 'log.txt'], { timeout: 5000 })

      expect(handle).toBe(mockHandle)
      expect(executor.spawn).toHaveBeenCalledWith('tail', ['-f', 'log.txt'], { timeout: 5000 })
    })
  })

  describe('parse', () => {
    it('should parse a command into AST', () => {
      const executor = createMockExecutor()
      const bash = new BashModule(executor)

      const ast = bash.parse('ls -la')

      expect(ast.type).toBe('Program')
    })
  })

  describe('analyze', () => {
    it('should analyze a command for safety', () => {
      const executor = createMockExecutor()
      const bash = new BashModule(executor)

      const analysis = bash.analyze('ls -la')

      expect(analysis.classification.type).toBe('read')
      expect(analysis.classification.impact).toBe('none')
    })
  })

  describe('isDangerous', () => {
    it('should check if a command is dangerous', () => {
      const executor = createMockExecutor()
      const bash = new BashModule(executor)

      const check = bash.isDangerous('ls')

      expect(check.dangerous).toBe(false)
    })
  })
})

describe('withBash mixin', () => {
  it('should add bash property to a class', () => {
    class BaseClass {
      value = 'base'
    }

    const executor = createMockExecutor()
    const MixedClass = withBash(BaseClass, () => executor)

    const instance = new MixedClass()

    expect(instance.value).toBe('base')
    expect(instance.bash).toBeInstanceOf(BashModule)
    expect(instance.bash.name).toBe('bash')
  })

  it('should lazily create BashModule', () => {
    const factoryFn = vi.fn().mockReturnValue(createMockExecutor())

    class BaseClass {}

    const MixedClass = withBash(BaseClass, factoryFn)
    const instance = new MixedClass()

    // Factory not called yet
    expect(factoryFn).not.toHaveBeenCalled()

    // Access bash property
    const _ = instance.bash

    // Now factory should be called
    expect(factoryFn).toHaveBeenCalledTimes(1)
  })

  it('should cache BashModule instance', () => {
    const factoryFn = vi.fn().mockReturnValue(createMockExecutor())

    class BaseClass {}

    const MixedClass = withBash(BaseClass, factoryFn)
    const instance = new MixedClass()

    const bash1 = instance.bash
    const bash2 = instance.bash

    expect(bash1).toBe(bash2)
    expect(factoryFn).toHaveBeenCalledTimes(1)
  })

  it('should pass instance to factory function', () => {
    const factoryFn = vi.fn().mockReturnValue(createMockExecutor())

    class BaseClass {
      config = { endpoint: 'http://example.com' }
    }

    const MixedClass = withBash(BaseClass, factoryFn)
    const instance = new MixedClass()

    const _ = instance.bash

    expect(factoryFn).toHaveBeenCalledWith(instance)
    expect(factoryFn.mock.calls[0][0].config.endpoint).toBe('http://example.com')
  })
})
