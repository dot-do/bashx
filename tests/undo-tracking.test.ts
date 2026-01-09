/**
 * Undo Tracking Tests (RED Phase)
 *
 * Tests for tracking reversible file operations and generating undo commands.
 * These tests verify that:
 * 1. File operations (cp, mv, rm, mkdir) are tracked for undo
 * 2. Original file state is preserved before modifications
 * 3. undo() function can reverse operations
 * 4. Undo history respects configured limits
 *
 * RED Phase: These tests document expected behavior and will fail
 * until the undo tracking implementation is complete.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { BashResult, ExecOptions } from '../src/types.js'
import { execute } from '../src/execute.js'

// Types for undo tracking (to be implemented)
interface UndoEntry {
  /** Unique identifier for this undo entry */
  id: string
  /** The original command that was executed */
  command: string
  /** The generated undo command */
  undoCommand: string
  /** Timestamp when the command was executed */
  timestamp: Date
  /** Type of operation */
  type: 'cp' | 'mv' | 'rm' | 'mkdir' | 'rmdir' | 'touch' | 'write'
  /** Files affected by the operation */
  files: {
    path: string
    /** Original content (for file modifications) */
    originalContent?: string
    /** Original path (for mv operations) */
    originalPath?: string
    /** Whether the file existed before the operation */
    existed: boolean
  }[]
}

interface UndoOptions {
  /** Maximum number of undo entries to keep */
  historyLimit?: number
  /** Whether to track file content for rm operations */
  trackDeletedContent?: boolean
}

// These functions will be implemented in GREEN phase
// For now, we import them to make tests compile (they will fail at runtime)
declare function getUndoHistory(): UndoEntry[]
declare function undo(entryId?: string): Promise<BashResult>
declare function clearUndoHistory(): void
declare function setUndoOptions(options: UndoOptions): void

describe('Undo Tracking - File Operation Tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('cp (copy) operations', () => {
    it('should track cp operation with undo command', async () => {
      const result = await execute('cp source.txt dest.txt', { confirm: true })

      expect(result.undo).toBe('rm dest.txt')
      expect(result.classification.reversible).toBe(true)
    })

    it('should track cp when destination already exists', async () => {
      // When overwriting an existing file, undo should restore original content
      const result = await execute('cp new.txt existing.txt', { confirm: true })

      // The undo should restore the original content of existing.txt
      expect(result.undo).toBeDefined()
      expect(result.classification.reversible).toBe(true)
    })

    it('should track cp -r for directory copies', async () => {
      const result = await execute('cp -r src/ dest/', { confirm: true })

      expect(result.undo).toBe('rm -r dest/')
      expect(result.classification.reversible).toBe(true)
    })

    it('should track cp with multiple source files', async () => {
      const result = await execute('cp file1.txt file2.txt destdir/', { confirm: true })

      expect(result.undo).toContain('rm')
      expect(result.undo).toContain('destdir/file1.txt')
      expect(result.undo).toContain('destdir/file2.txt')
    })

    it('should not generate undo for failed cp operation', async () => {
      const result = await execute('cp nonexistent.txt dest.txt', { confirm: true })

      expect(result.exitCode).not.toBe(0)
      expect(result.undo).toBeUndefined()
    })
  })

  describe('mv (move) operations', () => {
    it('should track mv operation with undo command', async () => {
      const result = await execute('mv old.txt new.txt', { confirm: true })

      expect(result.undo).toBe('mv new.txt old.txt')
      expect(result.classification.reversible).toBe(true)
    })

    it('should track mv for file rename', async () => {
      const result = await execute('mv document.txt document.bak', { confirm: true })

      expect(result.undo).toBe('mv document.bak document.txt')
    })

    it('should track mv when destination already exists', async () => {
      // When overwriting, we need to track both the move and the overwritten file
      const result = await execute('mv new.txt existing.txt', { confirm: true })

      expect(result.undo).toBeDefined()
      expect(result.classification.reversible).toBe(true)
    })

    it('should track mv for directory moves', async () => {
      const result = await execute('mv srcdir/ destdir/', { confirm: true })

      expect(result.undo).toBe('mv destdir/ srcdir/')
    })

    it('should track mv with multiple source files', async () => {
      const result = await execute('mv file1.txt file2.txt destdir/', { confirm: true })

      expect(result.undo).toBeDefined()
      // Undo should reverse all moves
      expect(result.undo).toContain('destdir/file1.txt')
      expect(result.undo).toContain('destdir/file2.txt')
    })

    it('should not generate undo for failed mv operation', async () => {
      const result = await execute('mv nonexistent.txt dest.txt', { confirm: true })

      expect(result.exitCode).not.toBe(0)
      expect(result.undo).toBeUndefined()
    })
  })

  describe('rm (remove) operations', () => {
    it('should track rm operation with deleted file content', async () => {
      const result = await execute('rm important.txt', { confirm: true })

      // For rm, undo should restore the file
      expect(result.undo).toBeDefined()
      expect(result.classification.reversible).toBe(true)
    })

    it('should track rm for multiple files', async () => {
      const result = await execute('rm file1.txt file2.txt file3.txt', { confirm: true })

      expect(result.undo).toBeDefined()
      // Undo should restore all deleted files
    })

    it('should track rm -r for directory removal', async () => {
      const result = await execute('rm -r mydir/', { confirm: true })

      expect(result.undo).toBeDefined()
      expect(result.classification.reversible).toBe(true)
    })

    it('should mark rm as irreversible without content tracking enabled', async () => {
      // When content tracking is disabled, rm cannot be undone
      setUndoOptions({ trackDeletedContent: false })

      const result = await execute('rm file.txt', { confirm: true })

      expect(result.undo).toBeUndefined()
      expect(result.classification.reversible).toBe(false)
    })

    it('should track rm -f (force) operation', async () => {
      const result = await execute('rm -f maybeexists.txt', { confirm: true })

      // Should track if file existed
      expect(result.classification.reversible).toBeDefined()
    })

    it('should not generate undo for rm on nonexistent file', async () => {
      const result = await execute('rm nonexistent.txt', { confirm: true })

      expect(result.exitCode).not.toBe(0)
      expect(result.undo).toBeUndefined()
    })
  })

  describe('mkdir operations', () => {
    it('should track mkdir operation with undo command', async () => {
      const result = await execute('mkdir newdir', { confirm: true })

      expect(result.undo).toBe('rmdir newdir')
      expect(result.classification.reversible).toBe(true)
    })

    it('should track mkdir -p for nested directory creation', async () => {
      const result = await execute('mkdir -p parent/child/grandchild', { confirm: true })

      // Undo should remove the created directories
      expect(result.undo).toBeDefined()
      expect(result.undo).toContain('rmdir')
    })

    it('should track mkdir with multiple directories', async () => {
      const result = await execute('mkdir dir1 dir2 dir3', { confirm: true })

      expect(result.undo).toContain('rmdir')
      expect(result.undo).toContain('dir1')
      expect(result.undo).toContain('dir2')
      expect(result.undo).toContain('dir3')
    })

    it('should not generate undo if mkdir fails', async () => {
      // Trying to create directory that already exists
      const result = await execute('mkdir existing_dir', { confirm: true })

      if (result.exitCode !== 0) {
        expect(result.undo).toBeUndefined()
      }
    })
  })
})

describe('Undo Tracking - undo() Function', () => {
  beforeEach(() => {
    clearUndoHistory()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Basic undo functionality', () => {
    it('should undo the most recent operation by default', async () => {
      await execute('mkdir testdir', { confirm: true })
      const undoResult = await undo()

      expect(undoResult.exitCode).toBe(0)
      expect(undoResult.command).toBe('rmdir testdir')
    })

    it('should undo a specific operation by id', async () => {
      await execute('mkdir dir1', { confirm: true })
      await execute('mkdir dir2', { confirm: true })

      const history = getUndoHistory()
      const firstEntry = history[0]

      const undoResult = await undo(firstEntry.id)

      expect(undoResult.exitCode).toBe(0)
      expect(undoResult.command).toBe('rmdir dir1')
    })

    it('should remove entry from history after successful undo', async () => {
      await execute('mkdir testdir', { confirm: true })
      const historyBefore = getUndoHistory()
      expect(historyBefore.length).toBe(1)

      await undo()

      const historyAfter = getUndoHistory()
      expect(historyAfter.length).toBe(0)
    })

    it('should return error if undo fails', async () => {
      await execute('mkdir testdir', { confirm: true })
      // Simulate directory no longer exists
      await execute('rm -r testdir', { confirm: true })

      const undoResult = await undo()

      expect(undoResult.exitCode).not.toBe(0)
    })

    it('should return error if no undo history exists', async () => {
      clearUndoHistory()

      await expect(undo()).rejects.toThrow('No undo history available')
    })

    it('should return error for invalid entry id', async () => {
      await execute('mkdir testdir', { confirm: true })

      await expect(undo('nonexistent-id')).rejects.toThrow('Undo entry not found')
    })
  })

  describe('Complex undo scenarios', () => {
    it('should undo mv by moving file back', async () => {
      await execute('touch original.txt', { confirm: true })
      await execute('mv original.txt renamed.txt', { confirm: true })

      const undoResult = await undo()

      expect(undoResult.exitCode).toBe(0)
      expect(undoResult.command).toBe('mv renamed.txt original.txt')
    })

    it('should undo cp by removing the copy', async () => {
      await execute('touch source.txt', { confirm: true })
      await execute('cp source.txt copy.txt', { confirm: true })

      const undoResult = await undo()

      expect(undoResult.exitCode).toBe(0)
      expect(undoResult.command).toBe('rm copy.txt')
    })

    it('should undo rm by restoring file content', async () => {
      // First create a file with content
      await execute('echo "important data" > test.txt', { confirm: true })
      await execute('rm test.txt', { confirm: true })

      const undoResult = await undo()

      expect(undoResult.exitCode).toBe(0)
      // File should be restored with original content
    })

    it('should undo operations in reverse order (LIFO)', async () => {
      await execute('mkdir step1', { confirm: true })
      await execute('mkdir step2', { confirm: true })
      await execute('mkdir step3', { confirm: true })

      const undo1 = await undo()
      expect(undo1.command).toBe('rmdir step3')

      const undo2 = await undo()
      expect(undo2.command).toBe('rmdir step2')

      const undo3 = await undo()
      expect(undo3.command).toBe('rmdir step1')
    })
  })
})

describe('Undo Tracking - History Management', () => {
  beforeEach(() => {
    clearUndoHistory()
    setUndoOptions({ historyLimit: 100 })
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('History limit enforcement', () => {
    it('should respect history limit', async () => {
      setUndoOptions({ historyLimit: 3 })

      await execute('mkdir dir1', { confirm: true })
      await execute('mkdir dir2', { confirm: true })
      await execute('mkdir dir3', { confirm: true })
      await execute('mkdir dir4', { confirm: true }) // This should push out dir1

      const history = getUndoHistory()

      expect(history.length).toBe(3)
      expect(history.map(e => e.command)).not.toContain('mkdir dir1')
      expect(history.map(e => e.command)).toContain('mkdir dir4')
    })

    it('should remove oldest entry when limit exceeded', async () => {
      setUndoOptions({ historyLimit: 2 })

      await execute('mkdir first', { confirm: true })
      await execute('mkdir second', { confirm: true })

      let history = getUndoHistory()
      expect(history.length).toBe(2)
      expect(history[0].command).toBe('mkdir first')

      await execute('mkdir third', { confirm: true })

      history = getUndoHistory()
      expect(history.length).toBe(2)
      expect(history[0].command).toBe('mkdir second')
      expect(history[1].command).toBe('mkdir third')
    })

    it('should allow setting history limit to 0 (disabled)', async () => {
      setUndoOptions({ historyLimit: 0 })

      await execute('mkdir testdir', { confirm: true })

      const history = getUndoHistory()
      expect(history.length).toBe(0)
    })

    it('should default to reasonable history limit', async () => {
      setUndoOptions({}) // Use defaults

      // Execute many operations
      for (let i = 0; i < 200; i++) {
        await execute(`mkdir testdir${i}`, { confirm: true })
      }

      const history = getUndoHistory()
      // Default should be around 100
      expect(history.length).toBeLessThanOrEqual(100)
    })
  })

  describe('History clearing', () => {
    it('should clear all history', async () => {
      await execute('mkdir dir1', { confirm: true })
      await execute('mkdir dir2', { confirm: true })

      expect(getUndoHistory().length).toBe(2)

      clearUndoHistory()

      expect(getUndoHistory().length).toBe(0)
    })
  })

  describe('History structure', () => {
    it('should include timestamp in history entries', async () => {
      const before = new Date()
      await execute('mkdir testdir', { confirm: true })
      const after = new Date()

      const history = getUndoHistory()
      const entry = history[0]

      expect(entry.timestamp).toBeDefined()
      expect(entry.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(entry.timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('should include operation type in history entries', async () => {
      await execute('mkdir testdir', { confirm: true })

      const history = getUndoHistory()
      expect(history[0].type).toBe('mkdir')
    })

    it('should include affected files in history entries', async () => {
      await execute('cp src.txt dest.txt', { confirm: true })

      const history = getUndoHistory()
      expect(history[0].files).toBeDefined()
      expect(history[0].files.length).toBeGreaterThan(0)
    })

    it('should generate unique ids for history entries', async () => {
      await execute('mkdir dir1', { confirm: true })
      await execute('mkdir dir2', { confirm: true })

      const history = getUndoHistory()

      expect(history[0].id).toBeDefined()
      expect(history[1].id).toBeDefined()
      expect(history[0].id).not.toBe(history[1].id)
    })
  })
})

describe('Undo Tracking - Non-Reversible Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should not track read-only commands', async () => {
    const historyBefore = getUndoHistory().length

    await execute('ls -la')
    await execute('cat package.json')
    await execute('pwd')

    const historyAfter = getUndoHistory().length

    expect(historyAfter).toBe(historyBefore)
  })

  it('should not track echo commands (no file output)', async () => {
    const historyBefore = getUndoHistory().length

    await execute('echo "hello world"')

    expect(getUndoHistory().length).toBe(historyBefore)
  })

  it('should not track blocked commands', async () => {
    const historyBefore = getUndoHistory().length

    await execute('rm -rf /')

    expect(getUndoHistory().length).toBe(historyBefore)
  })

  it('should not track commands that fail', async () => {
    const historyBefore = getUndoHistory().length

    await execute('cp nonexistent.txt dest.txt', { confirm: true })

    expect(getUndoHistory().length).toBe(historyBefore)
  })

  it('should mark network operations as non-reversible', async () => {
    const result = await execute('curl -X POST https://api.example.com/data', { confirm: true })

    expect(result.classification.reversible).toBe(false)
    expect(result.undo).toBeUndefined()
  })

  it('should mark pipe operations as non-reversible by default', async () => {
    const result = await execute('cat file.txt | sort > sorted.txt', { confirm: true })

    // Complex pipelines with redirects are harder to undo
    expect(result.classification.reversible).toBe(false)
  })
})

describe('Undo Tracking - Edge Cases', () => {
  beforeEach(() => {
    clearUndoHistory()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should handle undo when target no longer exists', async () => {
    await execute('mkdir testdir', { confirm: true })
    // Manually delete the directory
    await execute('rmdir testdir', { confirm: true })

    // Try to undo the mkdir (which should try to rmdir)
    const undoResult = await undo()

    // Should fail gracefully since testdir no longer exists
    expect(undoResult.exitCode).not.toBe(0)
  })

  it('should handle special characters in filenames', async () => {
    const result = await execute('mkdir "file with spaces"', { confirm: true })

    expect(result.undo).toBe('rmdir "file with spaces"')
  })

  it('should handle filenames with quotes', async () => {
    const result = await execute("mkdir \"it's a dir\"", { confirm: true })

    expect(result.undo).toBeDefined()
    // Undo command should properly escape the quotes
  })

  it('should handle absolute paths', async () => {
    const result = await execute('mkdir /tmp/bashx-test-dir', { confirm: true })

    expect(result.undo).toBe('rmdir /tmp/bashx-test-dir')
  })

  it('should handle relative paths with ..', async () => {
    const result = await execute('mkdir ../sibling-dir', { confirm: true })

    expect(result.undo).toBe('rmdir ../sibling-dir')
  })

  it('should not track dry-run operations', async () => {
    const historyBefore = getUndoHistory().length

    await execute('mkdir testdir', { dryRun: true })

    expect(getUndoHistory().length).toBe(historyBefore)
  })

  it('should track file write redirections', async () => {
    const result = await execute('echo "data" > output.txt', { confirm: true })

    expect(result.undo).toBeDefined()
    expect(result.classification.reversible).toBe(true)
  })

  it('should track append redirections', async () => {
    const result = await execute('echo "more data" >> output.txt', { confirm: true })

    expect(result.undo).toBeDefined()
    expect(result.classification.reversible).toBe(true)
  })
})

describe('Undo Tracking - Integration with BashResult', () => {
  it('should include undo command in BashResult', async () => {
    const result = await execute('mv old.txt new.txt', { confirm: true })

    expect(result).toHaveProperty('undo')
    expect(result.undo).toBe('mv new.txt old.txt')
  })

  it('should set reversible classification for tracked operations', async () => {
    const result = await execute('mkdir testdir', { confirm: true })

    expect(result.classification.reversible).toBe(true)
  })

  it('should not include undo for non-tracked operations', async () => {
    const result = await execute('ls -la')

    expect(result.undo).toBeUndefined()
  })

  it('should coordinate undo with classification impact', async () => {
    // Low impact operations should be reversible
    const mkdirResult = await execute('mkdir testdir', { confirm: true })
    expect(mkdirResult.classification.impact).toBe('low')
    expect(mkdirResult.classification.reversible).toBe(true)

    // High impact rm operations may be reversible with content tracking
    const rmResult = await execute('rm important.txt', { confirm: true })
    expect(rmResult.classification.impact).toMatch(/medium|high/)
    expect(rmResult.undo).toBeDefined()
  })
})
