/**
 * BashModule Tests
 *
 * Tests for the BashModule capability class.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BashModule, withBash, type BashExecutor, type WithBashCapability, type Constructor } from '../../src/do/index.js'
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

  it('should preserve constructor arguments', () => {
    class BaseClass {
      name: string
      constructor(name: string) {
        this.name = name
      }
    }

    const executor = createMockExecutor()
    const MixedClass = withBash(BaseClass, () => executor)

    const instance = new MixedClass('test-instance')

    expect(instance.name).toBe('test-instance')
    expect(instance.bash).toBeInstanceOf(BashModule)
  })

  it('should work with classes that have methods', () => {
    class BaseClass {
      getValue() {
        return 42
      }
    }

    const executor = createMockExecutor()
    const MixedClass = withBash(BaseClass, () => executor)

    const instance = new MixedClass()

    expect(instance.getValue()).toBe(42)
    expect(instance.bash).toBeInstanceOf(BashModule)
  })

  it('should allow extending mixed classes', () => {
    class BaseClass {
      base = 'base-value'
    }

    const executor = createMockExecutor()
    const MixedClass = withBash(BaseClass, () => executor)

    class ExtendedClass extends MixedClass {
      extended = 'extended-value'
    }

    const instance = new ExtendedClass()

    expect(instance.base).toBe('base-value')
    expect(instance.extended).toBe('extended-value')
    expect(instance.bash).toBeInstanceOf(BashModule)
  })

  it('should support async executor creation', async () => {
    class BaseClass {
      env = { containerEndpoint: 'https://container.example.com' }
    }

    const executor = createMockExecutor({
      'test-command': { stdout: 'async result', exitCode: 0 },
    })

    const MixedClass = withBash(BaseClass, (instance) => {
      // Can access instance properties when creating executor
      expect(instance.env.containerEndpoint).toBe('https://container.example.com')
      return executor
    })

    const instance = new MixedClass()
    const result = await instance.bash.exec('test-command')

    expect(result.stdout).toBe('async result')
  })

  it('should create separate BashModule instances for different class instances', () => {
    class BaseClass {}

    const executor1 = createMockExecutor()
    const executor2 = createMockExecutor()
    let callCount = 0

    const MixedClass = withBash(BaseClass, () => {
      callCount++
      return callCount === 1 ? executor1 : executor2
    })

    const instance1 = new MixedClass()
    const instance2 = new MixedClass()

    const bash1 = instance1.bash
    const bash2 = instance2.bash

    expect(bash1).not.toBe(bash2)
    expect(bash1).toBeInstanceOf(BashModule)
    expect(bash2).toBeInstanceOf(BashModule)
  })

  it('should work with inherited properties', () => {
    class ParentClass {
      parentProp = 'parent'
    }

    class ChildClass extends ParentClass {
      childProp = 'child'
    }

    const executor = createMockExecutor()
    const MixedClass = withBash(ChildClass, (instance) => {
      expect(instance.parentProp).toBe('parent')
      expect(instance.childProp).toBe('child')
      return executor
    })

    const instance = new MixedClass()

    expect(instance.parentProp).toBe('parent')
    expect(instance.childProp).toBe('child')
    expect(instance.bash).toBeInstanceOf(BashModule)
  })
})

describe('withBash type exports', () => {
  it('should export WithBashCapability interface', () => {
    // Type test - verify the interface can be used for type checking
    const checkCapability = (obj: WithBashCapability): BashModule => {
      return obj.bash
    }

    class BaseClass {}
    const executor = createMockExecutor()
    const MixedClass = withBash(BaseClass, () => executor)
    const instance = new MixedClass()

    const bash = checkCapability(instance)
    expect(bash).toBeInstanceOf(BashModule)
  })

  it('should export Constructor type', () => {
    // Type test - verify the Constructor type works
    const createInstance = <T extends Constructor>(ctor: T): InstanceType<T> => {
      return new ctor()
    }

    class TestClass {
      value = 'test'
    }

    const instance = createInstance(TestClass)
    expect(instance.value).toBe('test')
  })

  it('should correctly type the result of withBash', () => {
    class BaseClass {
      baseMethod() {
        return 'base'
      }
    }

    const executor = createMockExecutor()
    const MixedClass = withBash(BaseClass, () => executor)

    // The mixed class should have both base methods and bash property
    const instance = new MixedClass()

    // Type assertion tests (these compile if types are correct)
    const baseResult: string = instance.baseMethod()
    const bashModule: BashModule = instance.bash

    expect(baseResult).toBe('base')
    expect(bashModule).toBeInstanceOf(BashModule)
  })
})

// ============================================================================
// FsCapability Integration Tests
// ============================================================================

import type { FsCapability, FsEntry, FsStat } from '../../src/types.js'

// Helper to create a mock FsCapability
function createMockFsCapability(
  files: Record<string, string> = {},
  stats: Record<string, Partial<FsStat>> = {},
): FsCapability {
  return {
    read: vi.fn(async (path: string) => {
      if (path in files) {
        return files[path]
      }
      throw new Error(`File not found: ${path}`)
    }),
    exists: vi.fn(async (path: string) => path in files || path in stats),
    list: vi.fn(async (path: string) => {
      // Return entries based on what files start with the path
      const entries: FsEntry[] = []
      for (const filePath of Object.keys({ ...files, ...stats })) {
        if (filePath.startsWith(path === '.' ? '' : path)) {
          const name = filePath.replace(path === '.' ? '' : path + '/', '').split('/')[0]
          if (name && !entries.some((e) => e.name === name)) {
            entries.push({
              name,
              isDirectory: !filePath.includes('.') || filePath.endsWith('/'),
            })
          }
        }
      }
      return entries
    }),
    stat: vi.fn(async (path: string) => {
      const defaultStat: FsStat = {
        size: files[path]?.length || 0,
        isDirectory: path.endsWith('/') || !(path in files),
        isFile: path in files,
        createdAt: new Date('2025-01-01'),
        modifiedAt: new Date('2025-01-01'),
      }
      return { ...defaultStat, ...stats[path] }
    }),
  }
}

describe('BashModule with FsCapability', () => {
  describe('constructor with options', () => {
    it('should accept FsCapability in options', () => {
      const executor = createMockExecutor()
      const fs = createMockFsCapability()
      const bash = new BashModule(executor, { fs })

      expect(bash.hasFsCapability).toBe(true)
    })

    it('should report no FsCapability when not provided', () => {
      const executor = createMockExecutor()
      const bash = new BashModule(executor)

      expect(bash.hasFsCapability).toBe(false)
    })

    it('should respect useNativeOps option', () => {
      const executor = createMockExecutor()
      const fs = createMockFsCapability()
      const bash = new BashModule(executor, { fs, useNativeOps: false })

      expect(bash.hasFsCapability).toBe(false)
    })
  })

  describe('native cat command', () => {
    it('should use fs.read for cat command when FsCapability is available', async () => {
      const executor = createMockExecutor()
      const fs = createMockFsCapability({
        'file.txt': 'Hello, World!',
      })
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('cat', ['file.txt'])

      expect(result.stdout).toBe('Hello, World!')
      expect(result.exitCode).toBe(0)
      expect(fs.read).toHaveBeenCalledWith('file.txt')
      expect(executor.execute).not.toHaveBeenCalled()
    })

    it('should concatenate multiple files', async () => {
      const executor = createMockExecutor()
      const fs = createMockFsCapability({
        'file1.txt': 'First\n',
        'file2.txt': 'Second\n',
      })
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('cat', ['file1.txt', 'file2.txt'])

      expect(result.stdout).toBe('First\nSecond\n')
      expect(fs.read).toHaveBeenCalledTimes(2)
    })

    it('should return error for non-existent file', async () => {
      const executor = createMockExecutor()
      const fs = createMockFsCapability({})
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('cat', ['missing.txt'])

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('not found')
    })

    it('should fall back to executor when cat has no args', async () => {
      const executor = createMockExecutor({
        cat: { stdout: 'stdin content', exitCode: 0 },
      })
      const fs = createMockFsCapability()
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('cat')

      expect(executor.execute).toHaveBeenCalled()
    })
  })

  describe('native ls command', () => {
    it('should use fs.list for ls command', async () => {
      const executor = createMockExecutor()
      const fs = createMockFsCapability({
        'file1.txt': 'content',
        'file2.txt': 'content',
      })
      // Override list to return specific entries
      ;(fs.list as any).mockResolvedValue([
        { name: 'file1.txt', isDirectory: false },
        { name: 'file2.txt', isDirectory: false },
        { name: 'subdir', isDirectory: true },
      ])
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('ls')

      expect(result.stdout).toContain('file1.txt')
      expect(result.stdout).toContain('file2.txt')
      expect(result.stdout).toContain('subdir/')
      expect(result.exitCode).toBe(0)
      expect(fs.list).toHaveBeenCalledWith('.')
    })

    it('should list specific directory', async () => {
      const executor = createMockExecutor()
      const fs = createMockFsCapability()
      ;(fs.list as any).mockResolvedValue([{ name: 'nested.txt', isDirectory: false }])
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('ls', ['/app'])

      expect(fs.list).toHaveBeenCalledWith('/app')
    })
  })

  describe('native test command', () => {
    it('should check file existence with test -e', async () => {
      const executor = createMockExecutor()
      const fs = createMockFsCapability({ 'exists.txt': 'content' })
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('test', ['-e', 'exists.txt'])

      expect(result.exitCode).toBe(0)
      expect(fs.exists).toHaveBeenCalledWith('exists.txt')
    })

    it('should return exit code 1 for non-existent file', async () => {
      const executor = createMockExecutor()
      const fs = createMockFsCapability({})
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('test', ['-e', 'missing.txt'])

      expect(result.exitCode).toBe(1)
    })

    it('should check if path is file with test -f', async () => {
      const executor = createMockExecutor()
      const fs = createMockFsCapability(
        { 'file.txt': 'content' },
        { 'file.txt': { isFile: true, isDirectory: false } },
      )
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('test', ['-f', 'file.txt'])

      expect(result.exitCode).toBe(0)
    })

    it('should check if path is directory with test -d', async () => {
      const executor = createMockExecutor()
      const fs = createMockFsCapability({}, { 'dir': { isFile: false, isDirectory: true } })
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('test', ['-d', 'dir'])

      expect(result.exitCode).toBe(0)
    })

    it('should fall back for unknown test flags', async () => {
      const executor = createMockExecutor({
        'test -x script.sh': { stdout: '', exitCode: 0 },
      })
      const fs = createMockFsCapability()
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('test', ['-x', 'script.sh'])

      expect(executor.execute).toHaveBeenCalled()
    })
  })

  describe('native head command', () => {
    it('should read first 10 lines by default', async () => {
      const executor = createMockExecutor()
      const content = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n')
      const fs = createMockFsCapability({ 'file.txt': content })
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('head', ['file.txt'])

      const lines = result.stdout.split('\n').filter((l) => l)
      expect(lines.length).toBe(10)
      expect(lines[0]).toBe('Line 1')
      expect(lines[9]).toBe('Line 10')
    })

    it('should respect -n flag', async () => {
      const executor = createMockExecutor()
      const content = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n')
      const fs = createMockFsCapability({ 'file.txt': content })
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('head', ['-n', '5', 'file.txt'])

      const lines = result.stdout.split('\n').filter((l) => l)
      expect(lines.length).toBe(5)
      expect(lines[4]).toBe('Line 5')
    })
  })

  describe('native tail command', () => {
    it('should read last 10 lines by default', async () => {
      const executor = createMockExecutor()
      const content = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n') + '\n'
      const fs = createMockFsCapability({ 'file.txt': content })
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('tail', ['file.txt'])

      const lines = result.stdout.split('\n').filter((l) => l)
      expect(lines.length).toBe(10)
      expect(lines[0]).toBe('Line 11')
      expect(lines[9]).toBe('Line 20')
    })

    it('should respect -n flag', async () => {
      const executor = createMockExecutor()
      const content = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n') + '\n'
      const fs = createMockFsCapability({ 'file.txt': content })
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('tail', ['-n', '3', 'file.txt'])

      const lines = result.stdout.split('\n').filter((l) => l)
      expect(lines.length).toBe(3)
      expect(lines[0]).toBe('Line 18')
      expect(lines[2]).toBe('Line 20')
    })
  })

  describe('fallback to executor', () => {
    it('should use executor for non-native commands', async () => {
      const executor = createMockExecutor({
        'git status': { stdout: 'On branch main', exitCode: 0 },
      })
      const fs = createMockFsCapability()
      const bash = new BashModule(executor, { fs })

      const result = await bash.exec('git', ['status'])

      expect(result.stdout).toBe('On branch main')
      expect(executor.execute).toHaveBeenCalled()
    })

    it('should use executor when useNativeOps is false', async () => {
      const executor = createMockExecutor({
        'cat file.txt': { stdout: 'from executor', exitCode: 0 },
      })
      const fs = createMockFsCapability({ 'file.txt': 'from fs' })
      const bash = new BashModule(executor, { fs, useNativeOps: false })

      const result = await bash.exec('cat', ['file.txt'])

      expect(result.stdout).toBe('from executor')
      expect(executor.execute).toHaveBeenCalled()
      expect(fs.read).not.toHaveBeenCalled()
    })
  })
})

describe('withBash with FsCapability integration', () => {
  it('should accept config object with fs factory', () => {
    class BaseClass {
      fsCapability = createMockFsCapability({ 'test.txt': 'content' })
    }

    const executor = createMockExecutor()
    const MixedClass = withBash(BaseClass, {
      executor: () => executor,
      fs: (instance) => instance.fsCapability,
    })

    const instance = new MixedClass()

    expect(instance.bash).toBeInstanceOf(BashModule)
    expect(instance.bash.hasFsCapability).toBe(true)
  })

  it('should use native ops when fs is provided via config', async () => {
    const fsCapability = createMockFsCapability({ 'config.json': '{"key": "value"}' })

    class BaseClass {
      fs = fsCapability
    }

    const executor = createMockExecutor()
    const MixedClass = withBash(BaseClass, {
      executor: () => executor,
      fs: (instance) => instance.fs,
    })

    const instance = new MixedClass()
    const result = await instance.bash.exec('cat', ['config.json'])

    expect(result.stdout).toBe('{"key": "value"}')
    expect(fsCapability.read).toHaveBeenCalledWith('config.json')
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('should work with function shorthand (no fs)', () => {
    class BaseClass {}

    const executor = createMockExecutor()
    const MixedClass = withBash(BaseClass, () => executor)

    const instance = new MixedClass()

    expect(instance.bash.hasFsCapability).toBe(false)
  })

  it('should allow disabling native ops in config', async () => {
    const fsCapability = createMockFsCapability({ 'file.txt': 'fs content' })

    class BaseClass {
      fs = fsCapability
    }

    const executor = createMockExecutor({
      'cat file.txt': { stdout: 'executor content', exitCode: 0 },
    })

    const MixedClass = withBash(BaseClass, {
      executor: () => executor,
      fs: (instance) => instance.fs,
      useNativeOps: false,
    })

    const instance = new MixedClass()
    const result = await instance.bash.exec('cat', ['file.txt'])

    expect(result.stdout).toBe('executor content')
    expect(executor.execute).toHaveBeenCalled()
  })
})
