/**
 * Compression Commands Implementation
 *
 * Implements gzip, gunzip, zcat, tar, zip, unzip commands for bashx.do.
 * Uses pako for gzip/deflate and fflate for zip support.
 *
 * @module bashx/do/commands/compression
 */

import pako from 'pako'
import * as fflate from 'fflate'
import type { BashResult } from '../../types.js'

// ============================================================================
// TYPES
// ============================================================================

/**
 * Mock filesystem interface for compression operations
 */
interface MockFs {
  files: Map<string, { content: Uint8Array | string; mode?: number; mtime?: Date }>
  directories: Set<string>
  symlinks: Map<string, string>
  read(path: string): Promise<Uint8Array | string>
  write(path: string, content: Uint8Array | string): Promise<void>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<{
    size: number
    mode: number
    mtime: Date
    isFile(): boolean
    isDirectory(): boolean
    isSymbolicLink(): boolean
  }>
  readdir(path: string): Promise<string[]>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  rm(path: string): Promise<void>
  readlink(path: string): Promise<string>
  symlink(target: string, path: string): Promise<void>
}

interface CommandContext {
  args: string[]
  cwd: string
  fs: MockFs
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Resolve a path relative to cwd
 */
function resolvePath(path: string, cwd: string): string {
  if (path.startsWith('/')) return path
  return cwd.endsWith('/') ? cwd + path : cwd + '/' + path
}

/**
 * Convert string to Uint8Array
 */
function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

/**
 * Convert Uint8Array to string
 */
function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/**
 * Ensure content is Uint8Array
 */
function toBytes(content: Uint8Array | string): Uint8Array {
  if (typeof content === 'string') {
    return stringToBytes(content)
  }
  return content
}

/**
 * Check if bytes represent valid UTF-8 text without data loss
 */
function isValidUtf8(bytes: Uint8Array): boolean {
  // Check for null bytes in the middle (common in binary)
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0) return false
  }

  // Try decode and re-encode, compare lengths
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const reencoded = new TextEncoder().encode(decoded)
    return bytes.length === reencoded.length
  } catch {
    return false
  }
}

/**
 * Convert bytes to string or return bytes if binary
 * Returns string for text, Uint8Array for binary
 */
function bytesToStringOrBinary(bytes: Uint8Array): string | Uint8Array {
  if (isValidUtf8(bytes)) {
    return bytesToString(bytes)
  }
  return bytes
}

/**
 * Parse command line arguments extracting flags and positional args
 */
function parseArgs(args: string[]): { flags: Set<string>; options: Map<string, string>; positional: string[] } {
  const flags = new Set<string>()
  const options = new Map<string, string>()
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg.startsWith('--')) {
      // Long option
      if (arg.includes('=')) {
        const [key, value] = arg.split('=', 2)
        options.set(key, value)
      } else {
        flags.add(arg)
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      // Short option or combined flags
      // Check for compression level flags
      if (/^-[0-9]$/.test(arg)) {
        options.set('-level', arg.slice(1))
      } else {
        // Split combined flags like -czvf into -c, -z, -v, -f
        for (let j = 1; j < arg.length; j++) {
          flags.add('-' + arg[j])
        }
      }
    } else {
      positional.push(arg)
    }
  }

  return { flags, options, positional }
}

/**
 * Match a filename against a glob pattern
 */
function matchGlob(filename: string, pattern: string): boolean {
  // Convert glob to regex
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${regex}$`).test(filename)
}

// ============================================================================
// GZIP IMPLEMENTATION
// ============================================================================

/**
 * Execute gzip command
 */
export async function gzip(ctx: CommandContext): Promise<BashResult> {
  const { args, cwd, fs } = ctx
  const { flags, options, positional } = parseArgs(args)

  const decompress = flags.has('-d') || flags.has('--decompress')
  const keep = flags.has('-k') || flags.has('--keep')
  const toStdout = flags.has('-c') || flags.has('--stdout')
  const force = flags.has('-f') || flags.has('--force')
  const list = flags.has('-l') || flags.has('--list')

  // Get compression level
  let level = 6
  if (options.has('-level')) {
    level = parseInt(options.get('-level')!, 10)
  }
  if (flags.has('--best')) level = 9
  if (flags.has('--fast')) level = 1

  if (positional.length === 0) {
    return createResult('gzip', '', 'gzip: missing operand', 1)
  }

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  for (const file of positional) {
    const fullPath = resolvePath(file, cwd)

    try {
      const exists = await fs.exists(fullPath)
      if (!exists) {
        stderr += `gzip: ${file}: No such file or directory\n`
        exitCode = 1
        continue
      }

      const stat = await fs.stat(fullPath)
      if (stat.isDirectory()) {
        stderr += `gzip: ${file}: is a directory -- ignored\n`
        exitCode = 1
        continue
      }

      const content = await fs.read(fullPath)
      const bytes = toBytes(content)

      if (list) {
        // List mode - show compression info
        // For a gzip file, we need to decompress to get original size
        if (fullPath.endsWith('.gz')) {
          try {
            const decompressed = pako.ungzip(bytes)
            const ratio = ((1 - bytes.length / decompressed.length) * 100).toFixed(1)
            stdout += `compressed: ${bytes.length}, uncompressed: ${decompressed.length}, ratio: ${ratio}%\n`
          } catch {
            stderr += `gzip: ${file}: not in gzip format\n`
            exitCode = 1
          }
        } else {
          stderr += `gzip: ${file}: not in gzip format\n`
          exitCode = 1
        }
        continue
      }

      if (decompress) {
        // Decompress mode
        try {
          const decompressed = pako.ungzip(bytes)

          if (toStdout) {
            stdout += bytesToString(decompressed)
          } else {
            // Write to file without .gz extension
            const outPath = fullPath.replace(/\.gz$/, '')
            // Write as string for text, Uint8Array for binary
            await fs.write(outPath, bytesToStringOrBinary(decompressed))
            if (!keep) {
              await fs.rm(fullPath)
            }
          }
        } catch {
          stderr += `gzip: ${file}: invalid compressed data--format violated\n`
          exitCode = 1
        }
      } else {
        // Compress mode
        const compressed = pako.gzip(bytes, { level })
        const outPath = fullPath + '.gz'

        if (toStdout) {
          stdout = compressed as unknown as string // Will be binary
          return {
            input: `gzip ${args.join(' ')}`,
            command: 'gzip',
            valid: true,
            generated: false,
            stdout: compressed,
            stderr: '',
            exitCode: 0,
            intent: { commands: ['gzip'], reads: [fullPath], writes: [], deletes: [], network: false, elevated: false },
            classification: { type: 'execute', impact: 'none', reversible: true, reason: 'Compression' },
          } as unknown as BashResult
        }

        // Check if output exists and we're not forcing
        if (!force && await fs.exists(outPath)) {
          stderr += `gzip: ${file}.gz already exists; not overwritten\n`
          exitCode = 1
          continue
        }

        await fs.write(outPath, compressed)
        if (!keep) {
          await fs.rm(fullPath)
        }
      }
    } catch (error) {
      stderr += `gzip: ${file}: ${error instanceof Error ? error.message : String(error)}\n`
      exitCode = 1
    }
  }

  return createResult('gzip', stdout, stderr, exitCode)
}

// ============================================================================
// GUNZIP IMPLEMENTATION
// ============================================================================

/**
 * Execute gunzip command
 */
export async function gunzip(ctx: CommandContext): Promise<BashResult> {
  const { args, cwd, fs } = ctx
  const { flags, positional } = parseArgs(args)

  const keep = flags.has('-k') || flags.has('--keep')
  const toStdout = flags.has('-c') || flags.has('--stdout')

  if (positional.length === 0) {
    return createResult('gunzip', '', 'gunzip: missing operand', 1)
  }

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  for (const file of positional) {
    const fullPath = resolvePath(file, cwd)

    try {
      const exists = await fs.exists(fullPath)
      if (!exists) {
        stderr += `gunzip: ${file}: No such file or directory\n`
        exitCode = 1
        continue
      }

      const content = await fs.read(fullPath)
      const bytes = toBytes(content)

      try {
        const decompressed = pako.ungzip(bytes)

        if (toStdout) {
          stdout += bytesToString(decompressed)
        } else {
          const outPath = fullPath.replace(/\.gz$/, '')
          // Write as string for text, Uint8Array for binary
          await fs.write(outPath, bytesToStringOrBinary(decompressed))
          if (!keep) {
            await fs.rm(fullPath)
          }
        }
      } catch {
        stderr += `gunzip: ${file}: invalid compressed data--format violated\n`
        exitCode = 1
      }
    } catch (error) {
      stderr += `gunzip: ${file}: ${error instanceof Error ? error.message : String(error)}\n`
      exitCode = 1
    }
  }

  return createResult('gunzip', stdout, stderr, exitCode)
}

// ============================================================================
// ZCAT IMPLEMENTATION
// ============================================================================

/**
 * Execute zcat command (decompress to stdout)
 */
export async function zcat(ctx: CommandContext): Promise<BashResult> {
  const { args, cwd, fs } = ctx
  const { positional } = parseArgs(args)

  if (positional.length === 0) {
    return createResult('zcat', '', 'zcat: missing operand', 1)
  }

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  for (const file of positional) {
    const fullPath = resolvePath(file, cwd)

    try {
      const exists = await fs.exists(fullPath)
      if (!exists) {
        stderr += `zcat: ${file}: No such file or directory\n`
        exitCode = 1
        continue
      }

      const content = await fs.read(fullPath)
      const bytes = toBytes(content)

      try {
        const decompressed = pako.ungzip(bytes)
        stdout += bytesToString(decompressed)
      } catch {
        stderr += `zcat: ${file}: invalid compressed data--format violated\n`
        exitCode = 1
      }
    } catch (error) {
      stderr += `zcat: ${file}: ${error instanceof Error ? error.message : String(error)}\n`
      exitCode = 1
    }
  }

  return createResult('zcat', stdout, stderr, exitCode)
}

// ============================================================================
// TAR IMPLEMENTATION
// ============================================================================

/**
 * TAR header structure (USTAR format)
 * 512-byte blocks
 */
const TAR_BLOCK_SIZE = 512
const TAR_HEADER_SIZE = 512

interface TarEntry {
  name: string
  content: Uint8Array
  mode: number
  mtime: Date
  type: 'file' | 'directory' | 'symlink'
  linkname?: string
}

/**
 * Create a tar header for a file
 */
function createTarHeader(entry: TarEntry): Uint8Array {
  const header = new Uint8Array(TAR_HEADER_SIZE)
  const encoder = new TextEncoder()

  // Name (100 bytes)
  const nameBytes = encoder.encode(entry.name)
  header.set(nameBytes.slice(0, 100), 0)

  // Mode (8 bytes) - octal
  const modeStr = entry.mode.toString(8).padStart(7, '0')
  header.set(encoder.encode(modeStr), 100)

  // UID (8 bytes)
  header.set(encoder.encode('0000000'), 108)

  // GID (8 bytes)
  header.set(encoder.encode('0000000'), 116)

  // Size (12 bytes) - octal
  const sizeStr = entry.type === 'file' ? entry.content.length.toString(8).padStart(11, '0') : '00000000000'
  header.set(encoder.encode(sizeStr), 124)

  // Mtime (12 bytes) - octal seconds since epoch
  const mtimeSeconds = Math.floor(entry.mtime.getTime() / 1000)
  const mtimeStr = mtimeSeconds.toString(8).padStart(11, '0')
  header.set(encoder.encode(mtimeStr), 136)

  // Checksum (8 bytes) - filled with spaces initially
  for (let i = 148; i < 156; i++) header[i] = 0x20

  // Type flag (1 byte)
  if (entry.type === 'file') {
    header[156] = 0x30 // '0'
  } else if (entry.type === 'directory') {
    header[156] = 0x35 // '5'
  } else if (entry.type === 'symlink') {
    header[156] = 0x32 // '2'
  }

  // Linkname (100 bytes)
  if (entry.linkname) {
    header.set(encoder.encode(entry.linkname).slice(0, 100), 157)
  }

  // USTAR magic (6 bytes)
  header.set(encoder.encode('ustar'), 257)
  header[262] = 0x00

  // Version (2 bytes)
  header.set(encoder.encode('00'), 263)

  // Calculate checksum
  let checksum = 0
  for (let i = 0; i < TAR_HEADER_SIZE; i++) {
    checksum += header[i]
  }
  const checksumStr = checksum.toString(8).padStart(6, '0')
  header.set(encoder.encode(checksumStr), 148)
  header[154] = 0x00
  header[155] = 0x20

  return header
}

/**
 * Parse a tar header
 */
function parseTarHeader(header: Uint8Array): TarEntry | null {
  // Check if this is an empty block (end of archive)
  let isEmpty = true
  for (let i = 0; i < TAR_HEADER_SIZE; i++) {
    if (header[i] !== 0) {
      isEmpty = false
      break
    }
  }
  if (isEmpty) return null

  const decoder = new TextDecoder()

  // Name (100 bytes)
  const nameBytes = header.slice(0, 100)
  const nullIndex = nameBytes.indexOf(0)
  const name = decoder.decode(nullIndex >= 0 ? nameBytes.slice(0, nullIndex) : nameBytes)

  // Mode (8 bytes)
  const modeStr = decoder.decode(header.slice(100, 107)).trim()
  const mode = parseInt(modeStr, 8) || 0o644

  // Size (12 bytes)
  const sizeStr = decoder.decode(header.slice(124, 135)).trim()
  const size = parseInt(sizeStr, 8) || 0

  // Mtime (12 bytes)
  const mtimeStr = decoder.decode(header.slice(136, 147)).trim()
  const mtimeSeconds = parseInt(mtimeStr, 8) || 0
  const mtime = new Date(mtimeSeconds * 1000)

  // Type flag (1 byte)
  const typeFlag = header[156]
  let type: 'file' | 'directory' | 'symlink' = 'file'
  if (typeFlag === 0x35 || typeFlag === 53) type = 'directory'
  if (typeFlag === 0x32 || typeFlag === 50) type = 'symlink'

  // Linkname (100 bytes)
  const linknameBytes = header.slice(157, 257)
  const linknameNull = linknameBytes.indexOf(0)
  const linkname = decoder.decode(linknameNull >= 0 ? linknameBytes.slice(0, linknameNull) : linknameBytes)

  return {
    name,
    content: new Uint8Array(size),
    mode,
    mtime,
    type,
    linkname: linkname || undefined,
  }
}

/**
 * Execute tar command
 */
export async function tar(ctx: CommandContext): Promise<BashResult> {
  const { args, cwd, fs } = ctx

  // Manually parse tar args since they have special syntax
  let create = false
  let extract = false
  let list = false
  let verbose = false
  let useGzip = false
  let archiveFile: string | null = null
  let files: string[] = []
  let extractDir = cwd
  const excludePatterns: string[] = []

  // Track when we expect a value for the next arg
  let expectArchive = false
  let expectDir = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (expectArchive) {
      archiveFile = arg
      expectArchive = false
      continue
    }
    if (expectDir) {
      extractDir = arg.startsWith('/') ? arg : resolvePath(arg, cwd)
      expectDir = false
      continue
    }

    if (arg === '-C' || arg === '--directory') {
      expectDir = true
      continue
    }
    if (arg === '-f' || arg === '--file') {
      expectArchive = true
      continue
    }
    if (arg.startsWith('--exclude=')) {
      excludePatterns.push(arg.slice('--exclude='.length))
      continue
    }
    if (arg.startsWith('--')) {
      // Long options we don't handle specifically
      continue
    }

    if (arg.startsWith('-') && arg.length > 1 && !/^-[0-9]/.test(arg)) {
      // Parse combined flags like -cvf, -xvf, -czvf
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j]
        switch (flag) {
          case 'c': create = true; break
          case 'x': extract = true; break
          case 't': list = true; break
          case 'v': verbose = true; break
          case 'z': useGzip = true; break
          case 'f':
            // -f followed by file in next position or remaining in this arg
            if (j < arg.length - 1) {
              // File name embedded in arg (unlikely but possible)
              archiveFile = arg.slice(j + 1)
              j = arg.length // Exit loop
            } else {
              expectArchive = true
            }
            break
        }
      }
    } else {
      // Positional argument (file to archive or archive name)
      files.push(arg)
    }
  }

  // If archiveFile wasn't set via -f but we have positional args after flags
  if (!archiveFile && files.length > 0) {
    archiveFile = files[0]
    files = files.slice(1)
  }

  if (!archiveFile) {
    return createResult('tar', '', 'tar: You must specify one of the options', 1)
  }

  const archivePath = resolvePath(archiveFile, cwd)
  const isGzipped = useGzip || archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  try {
    if (create) {
      // Create archive
      const entries: TarEntry[] = []

      for (const file of files) {
        const fullPath = resolvePath(file, cwd)
        await collectEntries(fs, fullPath, file, entries, excludePatterns)
      }

      if (entries.length === 0 && files.length > 0) {
        // Check if files don't exist
        for (const file of files) {
          const fullPath = resolvePath(file, cwd)
          if (!(await fs.exists(fullPath))) {
            stderr += `tar: ${file}: Cannot stat: No such file or directory\n`
            exitCode = 1
          }
        }
        if (exitCode !== 0) {
          return createResult('tar', stdout, stderr, exitCode)
        }
      }

      // Build tar archive
      const tarData = buildTarArchive(entries)

      // Optionally compress with gzip
      const outputData = isGzipped ? pako.gzip(tarData) : tarData

      await fs.write(archivePath, outputData)

      if (verbose) {
        for (const entry of entries) {
          stdout += entry.name + '\n'
        }
      }
    } else if (extract) {
      // Extract archive
      if (!(await fs.exists(archivePath))) {
        stderr += `tar: ${archiveFile}: Cannot open: No such file or directory\n`
        return createResult('tar', stdout, stderr, 1)
      }

      const archiveContent = await fs.read(archivePath)
      let tarData = toBytes(archiveContent)

      // Check if it's gzipped
      if (isGzipped || (tarData[0] === 0x1f && tarData[1] === 0x8b)) {
        try {
          tarData = pako.ungzip(tarData)
        } catch {
          stderr += `tar: ${archiveFile}: invalid compressed data\n`
          return createResult('tar', stdout, stderr, 1)
        }
      }

      // Parse tar
      const entries = parseTarArchive(tarData)

      if (entries.length === 0 && tarData.length > 0) {
        stderr += `tar: ${archiveFile}: invalid tar format\n`
        return createResult('tar', stdout, stderr, 1)
      }

      for (const entry of entries) {
        const outPath = resolvePath(entry.name, extractDir)

        if (entry.type === 'directory') {
          await fs.mkdir(outPath, { recursive: true })
        } else if (entry.type === 'symlink') {
          await fs.symlink(entry.linkname!, outPath)
        } else {
          // Ensure parent directory exists
          const parentDir = outPath.split('/').slice(0, -1).join('/')
          if (parentDir && !(await fs.exists(parentDir))) {
            await fs.mkdir(parentDir, { recursive: true })
          }

          // Write file with preserved mode/mtime
          // Write as string for text, Uint8Array for binary
          await fs.write(outPath, bytesToStringOrBinary(entry.content))
          const fileData = fs.files.get(outPath)
          if (fileData) {
            fileData.mode = entry.mode
            fileData.mtime = entry.mtime
          }
        }

        if (verbose) {
          stdout += entry.name + '\n'
        }
      }
    } else if (list) {
      // List archive contents
      if (!(await fs.exists(archivePath))) {
        stderr += `tar: ${archiveFile}: Cannot open: No such file or directory\n`
        return createResult('tar', stdout, stderr, 1)
      }

      const archiveContent = await fs.read(archivePath)
      let tarData = toBytes(archiveContent)

      if (isGzipped || (tarData[0] === 0x1f && tarData[1] === 0x8b)) {
        try {
          tarData = pako.ungzip(tarData)
        } catch {
          stderr += `tar: ${archiveFile}: invalid compressed data\n`
          return createResult('tar', stdout, stderr, 1)
        }
      }

      const entries = parseTarArchive(tarData)

      for (const entry of entries) {
        if (verbose) {
          const modeStr = entry.mode.toString(8).padStart(4, '0')
          const sizeStr = entry.content.length.toString().padStart(8, ' ')
          stdout += `${modeStr} ${sizeStr} ${entry.name}\n`
        } else {
          stdout += entry.name + '\n'
        }
      }
    }
  } catch (error) {
    stderr += `tar: ${error instanceof Error ? error.message : String(error)}\n`
    exitCode = 1
  }

  return createResult('tar', stdout, stderr, exitCode)
}

/**
 * Collect files recursively for tar
 */
async function collectEntries(
  fs: MockFs,
  fullPath: string,
  relativePath: string,
  entries: TarEntry[],
  excludePatterns: string[]
): Promise<void> {
  // Check exclusions
  const filename = relativePath.split('/').pop() || relativePath
  for (const pattern of excludePatterns) {
    if (matchGlob(filename, pattern)) {
      return
    }
  }

  if (!(await fs.exists(fullPath))) {
    return
  }

  const stat = await fs.stat(fullPath)

  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(fullPath)
    entries.push({
      name: relativePath,
      content: new Uint8Array(0),
      mode: 0o777,
      mtime: stat.mtime,
      type: 'symlink',
      linkname: target,
    })
  } else if (stat.isDirectory()) {
    entries.push({
      name: relativePath + '/',
      content: new Uint8Array(0),
      mode: stat.mode,
      mtime: stat.mtime,
      type: 'directory',
    })

    // Recurse into directory
    const children = await fs.readdir(fullPath)
    for (const child of children) {
      const childFull = fullPath.endsWith('/') ? fullPath + child : fullPath + '/' + child
      const childRel = relativePath + '/' + child
      await collectEntries(fs, childFull, childRel, entries, excludePatterns)
    }
  } else {
    const content = await fs.read(fullPath)
    entries.push({
      name: relativePath,
      content: toBytes(content),
      mode: stat.mode,
      mtime: stat.mtime,
      type: 'file',
    })
  }
}

/**
 * Build a tar archive from entries
 */
function buildTarArchive(entries: TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = []

  for (const entry of entries) {
    // Add header
    const header = createTarHeader(entry)
    blocks.push(header)

    // Add content (padded to block size)
    if (entry.type === 'file' && entry.content.length > 0) {
      const contentBlocks = Math.ceil(entry.content.length / TAR_BLOCK_SIZE)
      const paddedContent = new Uint8Array(contentBlocks * TAR_BLOCK_SIZE)
      paddedContent.set(entry.content)
      blocks.push(paddedContent)
    }
  }

  // Add two empty blocks at end
  blocks.push(new Uint8Array(TAR_BLOCK_SIZE))
  blocks.push(new Uint8Array(TAR_BLOCK_SIZE))

  // Concatenate all blocks
  const totalSize = blocks.reduce((sum, b) => sum + b.length, 0)
  const result = new Uint8Array(totalSize)
  let offset = 0
  for (const block of blocks) {
    result.set(block, offset)
    offset += block.length
  }

  return result
}

/**
 * Parse a tar archive
 */
function parseTarArchive(data: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0

  while (offset + TAR_HEADER_SIZE <= data.length) {
    const header = data.slice(offset, offset + TAR_HEADER_SIZE)
    const entry = parseTarHeader(header)

    if (!entry) break // End of archive

    offset += TAR_HEADER_SIZE

    // Read content
    if (entry.type === 'file' && entry.content.length > 0) {
      const contentBlocks = Math.ceil(entry.content.length / TAR_BLOCK_SIZE)
      const paddedSize = contentBlocks * TAR_BLOCK_SIZE

      entry.content = data.slice(offset, offset + entry.content.length)
      offset += paddedSize
    }

    entries.push(entry)
  }

  return entries
}

// ============================================================================
// ZIP IMPLEMENTATION
// ============================================================================

/**
 * Execute zip command
 */
export async function zip(ctx: CommandContext): Promise<BashResult> {
  const { args, cwd, fs } = ctx
  const { flags, options, positional } = parseArgs(args)

  const recursive = flags.has('-r') || flags.has('--recurse-paths')

  // Get compression level
  let level = 6
  if (options.has('-level')) {
    level = parseInt(options.get('-level')!, 10)
  }

  if (positional.length < 2) {
    return createResult('zip', '', 'zip: missing archive name and/or files', 1)
  }

  const archiveFile = positional[0]
  const files = positional.slice(1)

  const archivePath = resolvePath(archiveFile, cwd)

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  try {
    // Collect all files
    const zipData: Record<string, Uint8Array> = {}

    // If archive exists, read existing entries
    if (await fs.exists(archivePath)) {
      const existingContent = await fs.read(archivePath)
      const existingBytes = toBytes(existingContent)
      try {
        const existingFiles = fflate.unzipSync(existingBytes)
        for (const [name, content] of Object.entries(existingFiles)) {
          zipData[name] = content
        }
      } catch {
        // Ignore - start fresh
      }
    }

    for (const file of files) {
      const fullPath = resolvePath(file, cwd)

      if (!(await fs.exists(fullPath))) {
        stderr += `zip: ${file}: No such file or directory\n`
        exitCode = 1
        continue
      }

      const stat = await fs.stat(fullPath)

      if (stat.isDirectory()) {
        if (recursive) {
          await collectZipEntries(fs, fullPath, file, zipData)
        } else {
          stderr += `zip: ${file}: is a directory (use -r to include)\n`
        }
      } else {
        const content = await fs.read(fullPath)
        zipData[file] = toBytes(content)
        stdout += `  adding: ${file}\n`
      }
    }

    // Create zip
    const zipOptions: Record<string, fflate.ZipInputFile> = {}
    for (const [name, content] of Object.entries(zipData)) {
      zipOptions[name] = [content, { level }]
    }

    const zipResult = fflate.zipSync(zipOptions)
    await fs.write(archivePath, zipResult)
  } catch (error) {
    stderr += `zip: ${error instanceof Error ? error.message : String(error)}\n`
    exitCode = 1
  }

  return createResult('zip', stdout, stderr, exitCode)
}

/**
 * Collect files for zip archive
 */
async function collectZipEntries(
  fs: MockFs,
  fullPath: string,
  relativePath: string,
  zipData: Record<string, Uint8Array>
): Promise<void> {
  const stat = await fs.stat(fullPath)

  if (stat.isDirectory()) {
    const children = await fs.readdir(fullPath)
    for (const child of children) {
      const childFull = fullPath.endsWith('/') ? fullPath + child : fullPath + '/' + child
      const childRel = relativePath + '/' + child
      await collectZipEntries(fs, childFull, childRel, zipData)
    }
  } else {
    const content = await fs.read(fullPath)
    zipData[relativePath] = toBytes(content)
  }
}

/**
 * Execute unzip command
 */
export async function unzip(ctx: CommandContext): Promise<BashResult> {
  const { args, cwd, fs } = ctx

  // Parse unzip args manually since -d takes a value
  let listOnly = false
  let toStdout = false
  let overwrite = false
  let destDir = cwd
  let archiveFile: string | null = null
  const selectFiles: string[] = []

  let expectDest = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (expectDest) {
      destDir = arg.startsWith('/') ? arg : resolvePath(arg, cwd)
      expectDest = false
      continue
    }

    if (arg === '-d') {
      expectDest = true
      continue
    }
    if (arg === '-l' || arg === '--list') {
      listOnly = true
      continue
    }
    if (arg === '-p' || arg === '--pipe') {
      toStdout = true
      continue
    }
    if (arg === '-o' || arg === '--overwrite') {
      overwrite = true
      continue
    }
    if (arg.startsWith('-')) {
      // Other flags we don't handle
      continue
    }

    // Positional arguments
    if (!archiveFile) {
      archiveFile = arg
    } else {
      selectFiles.push(arg)
    }
  }

  if (!archiveFile) {
    return createResult('unzip', '', 'unzip: missing archive name', 1)
  }

  const archivePath = resolvePath(archiveFile, cwd)

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  try {
    if (!(await fs.exists(archivePath))) {
      stderr += `unzip: cannot find or open ${archiveFile}\n`
      return createResult('unzip', stdout, stderr, 1)
    }

    const archiveContent = await fs.read(archivePath)
    const bytes = toBytes(archiveContent)

    let files: Record<string, Uint8Array>
    try {
      files = fflate.unzipSync(bytes)
    } catch {
      stderr += `unzip: ${archiveFile}: invalid zip file\n`
      return createResult('unzip', stdout, stderr, 1)
    }

    // Filter files if specific ones requested
    const fileNames = Object.keys(files)
    const filesToProcess = selectFiles.length > 0
      ? fileNames.filter(name => selectFiles.includes(name))
      : fileNames

    // Check if requested files exist
    if (selectFiles.length > 0) {
      for (const name of selectFiles) {
        if (!fileNames.includes(name)) {
          stderr += `unzip: ${name}: file not found in archive\n`
          exitCode = 1
        }
      }
      if (exitCode !== 0 && filesToProcess.length === 0) {
        return createResult('unzip', stdout, stderr, exitCode)
      }
    }

    if (listOnly) {
      // List contents
      stdout += '  Length      Name\n'
      stdout += '---------  --------------------\n'
      for (const name of filesToProcess) {
        const content = files[name]
        stdout += `${content.length.toString().padStart(9)}  ${name}\n`
      }
    } else if (toStdout) {
      // Extract to stdout
      for (const name of filesToProcess) {
        const content = files[name]
        stdout += bytesToString(content)
      }
    } else {
      // Create destination directory if needed
      if (!(await fs.exists(destDir))) {
        await fs.mkdir(destDir, { recursive: true })
      }

      // Extract files
      for (const name of filesToProcess) {
        const content = files[name]
        const outPath = resolvePath(name, destDir)

        // Create parent directories
        const parentDir = outPath.split('/').slice(0, -1).join('/')
        if (parentDir && !(await fs.exists(parentDir))) {
          await fs.mkdir(parentDir, { recursive: true })
        }

        // Check for overwrite
        if (!overwrite && await fs.exists(outPath)) {
          // In non-interactive mode, skip
          continue
        }

        // Write as string for text, Uint8Array for binary
        await fs.write(outPath, bytesToStringOrBinary(content))
      }
    }
  } catch (error) {
    stderr += `unzip: ${error instanceof Error ? error.message : String(error)}\n`
    exitCode = 1
  }

  return createResult('unzip', stdout, stderr, exitCode)
}

// ============================================================================
// RESULT HELPER
// ============================================================================

/**
 * Create a standardized BashResult
 */
function createResult(command: string, stdout: string, stderr: string, exitCode: number): BashResult {
  return {
    input: command,
    command,
    valid: true,
    generated: false,
    stdout,
    stderr,
    exitCode,
    intent: {
      commands: [command],
      reads: [],
      writes: [],
      deletes: [],
      network: false,
      elevated: false,
    },
    classification: {
      type: 'execute',
      impact: 'none',
      reversible: true,
      reason: 'Compression operation',
    },
  }
}
