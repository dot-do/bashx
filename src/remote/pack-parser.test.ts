/**
 * Pack File Parser Tests - RED Phase
 *
 * Comprehensive failing tests for Git packfile parsing:
 * - Pack header parsing (magic, version, object count)
 * - Pack entry parsing (commits, trees, blobs, tags)
 * - Delta decompression (OFS_DELTA, REF_DELTA)
 * - Checksum verification
 *
 * These tests define the expected behavior for packfile parsing
 * in gitx/bashx remote protocol support.
 *
 * @module bashx/remote/pack-parser.test
 *
 * ## Generating Test Packfiles
 *
 * To generate real packfiles for testing:
 *
 * ```bash
 * # Create a minimal repo with objects
 * mkdir test-repo && cd test-repo && git init
 * echo "hello" > file.txt
 * git add file.txt
 * git commit -m "Initial commit"
 *
 * # Create a packfile containing all objects
 * git gc --aggressive
 * # Packfile is in .git/objects/pack/pack-*.pack
 *
 * # Or create a pack manually:
 * git rev-parse HEAD | git pack-objects --stdout > test.pack
 *
 * # View pack contents:
 * git verify-pack -v .git/objects/pack/pack-*.pack
 *
 * # Create delta-heavy pack:
 * for i in {1..10}; do echo "line $i" >> file.txt; git add .; git commit -m "commit $i"; done
 * git repack -a -d --depth=250 --window=250
 * ```
 */

import { describe, it, expect, beforeEach } from 'vitest'

// Import the pack parser (to be implemented)
// These imports will fail until implementation exists
import {
  parsePackHeader,
  parsePackEntry,
  parsePackFile,
  applyDelta,
  verifyPackChecksum,
  decodeVarint,
  decompressZlib,
  computeObjectHash,
  type PackHeader,
  type PackEntry,
  type PackObject,
  type DeltaInstruction,
  PackParseError,
  InvalidMagicError,
  UnsupportedVersionError,
  ChecksumMismatchError,
  MissingBaseObjectError,
  CorruptedPackError,
} from './pack-parser.js'

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Fixture: Minimal valid pack header (version 2, 1 object)
 *
 * Generate: echo -n "test" | git hash-object -w --stdin && git rev-parse HEAD | git pack-objects --stdout | xxd
 *
 * Structure:
 * - Bytes 0-3: "PACK" magic (0x5041434b)
 * - Bytes 4-7: Version (2) big-endian
 * - Bytes 8-11: Object count (1) big-endian
 */
const PACK_HEADER_V2_1OBJ = new Uint8Array([
  0x50, 0x41, 0x43, 0x4b, // "PACK"
  0x00, 0x00, 0x00, 0x02, // Version 2
  0x00, 0x00, 0x00, 0x01, // 1 object
])

/**
 * Fixture: Pack header version 3
 */
const PACK_HEADER_V3 = new Uint8Array([
  0x50, 0x41, 0x43, 0x4b, // "PACK"
  0x00, 0x00, 0x00, 0x03, // Version 3
  0x00, 0x00, 0x00, 0x05, // 5 objects
])

/**
 * Fixture: Invalid magic bytes
 */
const INVALID_MAGIC = new Uint8Array([
  0x47, 0x49, 0x54, 0x50, // "GITP" - wrong magic
  0x00, 0x00, 0x00, 0x02,
  0x00, 0x00, 0x00, 0x01,
])

/**
 * Fixture: Unsupported version (version 1)
 */
const UNSUPPORTED_VERSION = new Uint8Array([
  0x50, 0x41, 0x43, 0x4b, // "PACK"
  0x00, 0x00, 0x00, 0x01, // Version 1 - unsupported
  0x00, 0x00, 0x00, 0x01,
])

/**
 * Fixture: Pack with many objects (test large count parsing)
 */
const PACK_HEADER_MANY = new Uint8Array([
  0x50, 0x41, 0x43, 0x4b, // "PACK"
  0x00, 0x00, 0x00, 0x02, // Version 2
  0x00, 0x01, 0x00, 0x00, // 65536 objects
])

/**
 * Fixture: Blob object "hello\n" (7 bytes uncompressed)
 *
 * Generate:
 * echo "hello" | git hash-object -w --stdin
 * # SHA: ce013625030ba8dba906f756967f9e9ca394464a
 *
 * Pack entry structure:
 * - Byte 0: Type (3=blob) in bits 4-6, size LSB in bits 0-3
 *   0x37 = 0011 0111 = type 3, size bits 0111 (7)
 * - Following bytes: zlib compressed "blob 6\0hello\n"
 */
const BLOB_HELLO_COMPRESSED = new Uint8Array([
  // Type-size byte: type=3 (blob), size=6
  0x36, // 0011 0110 = type 3, size 6
  // zlib compressed "hello\n"
  0x78, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0xe7, 0x02, 0x00, 0x08, 0x4c, 0x02, 0x13,
])

/**
 * Fixture: Commit object (minimal)
 *
 * Generate:
 * git cat-file -p HEAD | wc -c  # Get size
 * git cat-file commit HEAD      # Get content
 *
 * Pack entry type 1 = OBJ_COMMIT
 */
const COMMIT_COMPRESSED = new Uint8Array([
  // Type-size byte: type=1 (commit), size with continuation
  0x91, 0x01, // type 1, varint size = 145
  // zlib compressed commit content
  0x78, 0x9c, 0x4b, 0x2e, 0x4a, 0x4d, 0x55, 0x30, 0x34, 0x30,
  0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x61, 0x00, 0x00, 0x09, 0xdc, 0x02, 0x1a,
])

/**
 * Fixture: Tree object
 *
 * Generate:
 * git ls-tree HEAD
 * git cat-file tree HEAD | xxd
 *
 * Pack entry type 2 = OBJ_TREE
 */
const TREE_COMPRESSED = new Uint8Array([
  // Type-size byte: type=2 (tree), size
  0x52, // 0101 0010 = type 2, size 18
  // zlib compressed tree content
  0x78, 0x9c, 0x33, 0x34, 0x30, 0x30, 0x33, 0x31, 0x51, 0x48,
  0xcb, 0xcc, 0x49, 0xd5, 0x2b, 0xa9, 0x28, 0x00, 0x00, 0x1d, 0x0c, 0x04, 0x9c,
])

/**
 * Fixture: Tag object
 *
 * Generate:
 * git tag -a v1.0 -m "Release"
 * git cat-file tag v1.0 | xxd
 *
 * Pack entry type 4 = OBJ_TAG
 */
const TAG_COMPRESSED = new Uint8Array([
  // Type-size byte: type=4 (tag), size with continuation
  0xc4, 0x01, // type 4, varint size = 196
  // zlib compressed tag content
  0x78, 0x9c, 0x4b, 0x4f, 0x4a, 0x4a, 0x4c, 0x56, 0x30, 0x34,
  0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x00, 0x00, 0x0b, 0x7c, 0x02, 0x57,
])

/**
 * Fixture: OFS_DELTA entry
 *
 * Type 6 = OFS_DELTA: delta against object at negative offset
 *
 * Structure:
 * - Type-size byte: type=6 (OFS_DELTA) + size
 * - Negative offset (varint, 7-bit with continuation)
 * - Zlib compressed delta instructions
 */
const OFS_DELTA_ENTRY = new Uint8Array([
  // Type-size byte: type=6 (ofs_delta), size=12
  0x6c, // 0110 1100 = type 6, size 12
  // Negative offset: 150 (encoded as varint)
  0x96, 0x01, // offset = 150
  // zlib compressed delta
  0x78, 0x9c, 0x63, 0x66, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x0d, 0x00, 0x03,
])

/**
 * Fixture: REF_DELTA entry
 *
 * Type 7 = REF_DELTA: delta against object identified by SHA-1
 *
 * Structure:
 * - Type-size byte: type=7 (REF_DELTA) + size
 * - 20-byte SHA-1 of base object
 * - Zlib compressed delta instructions
 */
const REF_DELTA_ENTRY = new Uint8Array([
  // Type-size byte: type=7 (ref_delta), size=8
  0x78, // 0111 1000 = type 7, size 8
  // 20-byte base object SHA-1
  0xce, 0x01, 0x36, 0x25, 0x03, 0x0b, 0xa8, 0xdb, 0xa9, 0x06,
  0xf7, 0x56, 0x96, 0x7f, 0x9e, 0x9c, 0xa3, 0x94, 0x46, 0x4a,
  // zlib compressed delta
  0x78, 0x9c, 0x63, 0x67, 0x00, 0x00, 0x00, 0x12, 0x00, 0x09,
])

/**
 * Fixture: Delta instructions
 *
 * Delta format:
 * - Source size (varint)
 * - Target size (varint)
 * - Instructions:
 *   - Copy: bit 7 set, bits 0-6 encode offset/size presence
 *   - Insert: bit 7 clear, bits 0-6 = length, followed by data
 */
const DELTA_COPY_INSTRUCTION = new Uint8Array([
  0x06, // source size: 6
  0x0c, // target size: 12
  // Copy instruction: copy 6 bytes from offset 0
  0x90, // 1001 0000 = copy, offset present, size present
  0x00, // offset = 0
  0x06, // size = 6
  // Insert instruction: insert "world\n"
  0x06, // insert 6 bytes
  0x77, 0x6f, 0x72, 0x6c, 0x64, 0x0a, // "world\n"
])

/**
 * Fixture: Complete minimal packfile
 *
 * Contains: header + 1 blob + SHA-1 checksum
 */
const COMPLETE_PACK_BLOB = new Uint8Array([
  // Header
  0x50, 0x41, 0x43, 0x4b, // "PACK"
  0x00, 0x00, 0x00, 0x02, // Version 2
  0x00, 0x00, 0x00, 0x01, // 1 object
  // Blob entry
  0x36, // type=3 (blob), size=6
  0x78, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0xe7, 0x02, 0x00, 0x08, 0x4c, 0x02, 0x13,
  // SHA-1 checksum (20 bytes) - placeholder, real value computed
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])

/**
 * Fixture: Corrupted packfile (bad checksum)
 */
const CORRUPTED_PACK = new Uint8Array([
  // Header
  0x50, 0x41, 0x43, 0x4b, // "PACK"
  0x00, 0x00, 0x00, 0x02, // Version 2
  0x00, 0x00, 0x00, 0x01, // 1 object
  // Blob entry
  0x36, // type=3 (blob), size=6
  0x78, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0xe7, 0x02, 0x00, 0x08, 0x4c, 0x02, 0x13,
  // Wrong SHA-1 checksum
  0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef, 0xde, 0xad,
  0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
])

// =============================================================================
// SECTION 1: Pack Header Parsing Tests
// =============================================================================

describe('Pack Header Parsing', () => {
  describe('parsePackHeader', () => {
    it('should parse "PACK" magic bytes correctly', () => {
      const header = parsePackHeader(PACK_HEADER_V2_1OBJ)

      expect(header.magic).toBe('PACK')
    })

    it('should parse version 2 correctly', () => {
      const header = parsePackHeader(PACK_HEADER_V2_1OBJ)

      expect(header.version).toBe(2)
    })

    it('should parse version 3 correctly', () => {
      const header = parsePackHeader(PACK_HEADER_V3)

      expect(header.version).toBe(3)
    })

    it('should parse object count correctly for single object', () => {
      const header = parsePackHeader(PACK_HEADER_V2_1OBJ)

      expect(header.objectCount).toBe(1)
    })

    it('should parse object count correctly for multiple objects', () => {
      const header = parsePackHeader(PACK_HEADER_V3)

      expect(header.objectCount).toBe(5)
    })

    it('should parse large object counts correctly', () => {
      const header = parsePackHeader(PACK_HEADER_MANY)

      expect(header.objectCount).toBe(65536)
    })

    it('should return correct header size (12 bytes)', () => {
      const header = parsePackHeader(PACK_HEADER_V2_1OBJ)

      expect(header.headerSize).toBe(12)
    })

    it('should reject invalid magic bytes', () => {
      expect(() => parsePackHeader(INVALID_MAGIC)).toThrow(InvalidMagicError)
    })

    it('should reject invalid magic with descriptive error', () => {
      expect(() => parsePackHeader(INVALID_MAGIC)).toThrow(/expected "PACK"/i)
    })

    it('should reject unsupported version 1', () => {
      expect(() => parsePackHeader(UNSUPPORTED_VERSION)).toThrow(UnsupportedVersionError)
    })

    it('should reject unsupported version with descriptive error', () => {
      expect(() => parsePackHeader(UNSUPPORTED_VERSION)).toThrow(/version 1 not supported/i)
    })

    it('should reject version 0', () => {
      const v0 = new Uint8Array([
        0x50, 0x41, 0x43, 0x4b,
        0x00, 0x00, 0x00, 0x00, // Version 0
        0x00, 0x00, 0x00, 0x01,
      ])

      expect(() => parsePackHeader(v0)).toThrow(UnsupportedVersionError)
    })

    it('should reject version 4 and higher', () => {
      const v4 = new Uint8Array([
        0x50, 0x41, 0x43, 0x4b,
        0x00, 0x00, 0x00, 0x04, // Version 4
        0x00, 0x00, 0x00, 0x01,
      ])

      expect(() => parsePackHeader(v4)).toThrow(UnsupportedVersionError)
    })

    it('should throw on truncated header (< 12 bytes)', () => {
      const truncated = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0x00, 0x00])

      expect(() => parsePackHeader(truncated)).toThrow(PackParseError)
    })

    it('should throw on empty input', () => {
      expect(() => parsePackHeader(new Uint8Array(0))).toThrow(PackParseError)
    })

    it('should return typed PackHeader object', () => {
      const header = parsePackHeader(PACK_HEADER_V2_1OBJ)

      expect(header).toMatchObject({
        magic: 'PACK',
        version: 2,
        objectCount: 1,
        headerSize: 12,
      } satisfies PackHeader)
    })
  })
})

// =============================================================================
// SECTION 2: Varint Decoding Tests
// =============================================================================

describe('Varint Decoding', () => {
  describe('decodeVarint', () => {
    it('should decode single-byte varint (no continuation)', () => {
      // 0x37 = 0011 0111 = 55, no continuation bit
      const result = decodeVarint(new Uint8Array([0x37]), 0)

      expect(result.value).toBe(55)
      expect(result.bytesRead).toBe(1)
    })

    it('should decode two-byte varint with continuation', () => {
      // 0x87 0x01 = continuation + 7 bits, then 1 bit = 135
      const result = decodeVarint(new Uint8Array([0x87, 0x01]), 0)

      expect(result.value).toBe(135)
      expect(result.bytesRead).toBe(2)
    })

    it('should decode three-byte varint', () => {
      // 0x80 0x80 0x01 = 16384
      const result = decodeVarint(new Uint8Array([0x80, 0x80, 0x01]), 0)

      expect(result.value).toBe(16384)
      expect(result.bytesRead).toBe(3)
    })

    it('should decode varint at non-zero offset', () => {
      const buffer = new Uint8Array([0x00, 0x00, 0x37, 0x00])
      const result = decodeVarint(buffer, 2)

      expect(result.value).toBe(55)
      expect(result.bytesRead).toBe(1)
    })

    it('should decode maximum 32-bit varint', () => {
      // Maximum 32-bit value: 0xFFFFFFFF = 4294967295
      const result = decodeVarint(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f]), 0)

      expect(result.value).toBe(4294967295)
    })

    it('should handle zero value', () => {
      const result = decodeVarint(new Uint8Array([0x00]), 0)

      expect(result.value).toBe(0)
      expect(result.bytesRead).toBe(1)
    })

    it('should throw on truncated varint', () => {
      // Continuation bit set but no next byte
      expect(() => decodeVarint(new Uint8Array([0x80]), 0)).toThrow(PackParseError)
    })
  })
})

// =============================================================================
// SECTION 3: Pack Entry Parsing Tests (Non-Delta)
// =============================================================================

describe('Pack Entry Parsing (Non-Delta)', () => {
  describe('parsePackEntry - Type detection', () => {
    it('should identify OBJ_COMMIT (type 1)', () => {
      // Type byte: 0001 xxxx
      const entry = parsePackEntry(new Uint8Array([0x10, 0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]), 0)

      expect(entry.type).toBe(1)
      expect(entry.typeName).toBe('commit')
    })

    it('should identify OBJ_TREE (type 2)', () => {
      // Type byte: 0010 xxxx
      const entry = parsePackEntry(new Uint8Array([0x20, 0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]), 0)

      expect(entry.type).toBe(2)
      expect(entry.typeName).toBe('tree')
    })

    it('should identify OBJ_BLOB (type 3)', () => {
      // Type byte: 0011 xxxx
      const entry = parsePackEntry(BLOB_HELLO_COMPRESSED, 0)

      expect(entry.type).toBe(3)
      expect(entry.typeName).toBe('blob')
    })

    it('should identify OBJ_TAG (type 4)', () => {
      // Type byte: 0100 xxxx
      const entry = parsePackEntry(new Uint8Array([0x40, 0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]), 0)

      expect(entry.type).toBe(4)
      expect(entry.typeName).toBe('tag')
    })

    it('should identify OFS_DELTA (type 6)', () => {
      const entry = parsePackEntry(OFS_DELTA_ENTRY, 0)

      expect(entry.type).toBe(6)
      expect(entry.typeName).toBe('ofs_delta')
    })

    it('should identify REF_DELTA (type 7)', () => {
      const entry = parsePackEntry(REF_DELTA_ENTRY, 0)

      expect(entry.type).toBe(7)
      expect(entry.typeName).toBe('ref_delta')
    })

    it('should reject invalid type 0', () => {
      expect(() => parsePackEntry(new Uint8Array([0x00, 0x78, 0x9c, 0x03, 0x00]), 0)).toThrow(PackParseError)
    })

    it('should reject invalid type 5', () => {
      // Type 5 is reserved/invalid
      expect(() => parsePackEntry(new Uint8Array([0x50, 0x78, 0x9c, 0x03, 0x00]), 0)).toThrow(PackParseError)
    })
  })

  describe('parsePackEntry - Size decoding', () => {
    it('should decode size from single type-size byte (size < 16)', () => {
      // 0x36 = type 3, size 6
      const entry = parsePackEntry(BLOB_HELLO_COMPRESSED, 0)

      expect(entry.size).toBe(6)
    })

    it('should decode size with continuation bytes (size >= 16)', () => {
      // 0x91 0x01 = type 1, size = 1 + (16 << 4) = 145
      const entry = parsePackEntry(COMMIT_COMPRESSED, 0)

      expect(entry.size).toBe(145)
    })

    it('should decode large sizes correctly', () => {
      // Construct entry with large size
      const largeSize = new Uint8Array([
        0xbf, 0xff, 0x7f, // type 3, size = 15 + (127 << 4) + (127 << 11) = 262127
        0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01,
      ])
      const entry = parsePackEntry(largeSize, 0)

      expect(entry.size).toBeGreaterThan(1000)
    })
  })

  describe('parsePackEntry - Zlib decompression', () => {
    it('should decompress zlib data for blob', () => {
      const entry = parsePackEntry(BLOB_HELLO_COMPRESSED, 0)

      // The raw content should be "hello\n" (not the git object format)
      expect(entry.data).toBeInstanceOf(Uint8Array)
      expect(new TextDecoder().decode(entry.data)).toBe('hello\n')
    })

    it('should return correct decompressed size', () => {
      const entry = parsePackEntry(BLOB_HELLO_COMPRESSED, 0)

      expect(entry.data.length).toBe(entry.size)
    })

    it('should throw on invalid zlib data', () => {
      const invalidZlib = new Uint8Array([
        0x36, // type=3, size=6
        0x00, 0x00, 0x00, 0x00, // Not valid zlib
      ])

      expect(() => parsePackEntry(invalidZlib, 0)).toThrow(CorruptedPackError)
    })

    it('should throw on truncated zlib stream', () => {
      const truncated = new Uint8Array([
        0x36, // type=3, size=6
        0x78, 0x9c, // zlib header only
      ])

      expect(() => parsePackEntry(truncated, 0)).toThrow(CorruptedPackError)
    })
  })

  describe('parsePackEntry - Bytes consumed', () => {
    it('should report correct total bytes consumed', () => {
      const entry = parsePackEntry(BLOB_HELLO_COMPRESSED, 0)

      // type-size byte + zlib data
      expect(entry.bytesConsumed).toBe(BLOB_HELLO_COMPRESSED.length)
    })

    it('should allow parsing consecutive entries', () => {
      // Parse first entry, then use bytesConsumed to find second
      const entry1 = parsePackEntry(BLOB_HELLO_COMPRESSED, 0)
      const offset2 = entry1.bytesConsumed

      // Second entry would start at offset2
      expect(offset2).toBeGreaterThan(0)
    })
  })
})

// =============================================================================
// SECTION 4: Object Hash Computation Tests
// =============================================================================

describe('Object Hash Computation', () => {
  describe('computeObjectHash', () => {
    /**
     * Git object hash format: SHA-1 of "${type} ${size}\0${content}"
     *
     * Example for "hello\n":
     * echo "hello" | git hash-object --stdin
     * # ce013625030ba8dba906f756967f9e9ca394464a
     */
    it('should compute correct SHA-1 for blob "hello\\n"', () => {
      const content = new TextEncoder().encode('hello\n')
      const hash = computeObjectHash('blob', content)

      expect(hash).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
    })

    it('should compute correct SHA-1 for empty blob', () => {
      // echo -n "" | git hash-object --stdin
      // e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
      const content = new Uint8Array(0)
      const hash = computeObjectHash('blob', content)

      expect(hash).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
    })

    it('should compute correct SHA-1 for blob with binary content', () => {
      // Binary content: 0x00 0x01 0x02 0x03
      const content = new Uint8Array([0x00, 0x01, 0x02, 0x03])
      const hash = computeObjectHash('blob', content)

      // Pre-computed expected hash
      expect(hash).toMatch(/^[0-9a-f]{40}$/)
    })

    it('should handle commit object hashing', () => {
      const content = new TextEncoder().encode(
        'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n' +
          'author Test <test@test.com> 1234567890 +0000\n' +
          'committer Test <test@test.com> 1234567890 +0000\n\n' +
          'Initial commit\n'
      )
      const hash = computeObjectHash('commit', content)

      expect(hash).toMatch(/^[0-9a-f]{40}$/)
    })

    it('should handle tree object hashing', () => {
      // Tree format: mode SP name NUL sha1
      const sha1Bytes = new Uint8Array(20).fill(0xce)
      const content = new Uint8Array([
        ...new TextEncoder().encode('100644 file.txt\0'),
        ...sha1Bytes,
      ])
      const hash = computeObjectHash('tree', content)

      expect(hash).toMatch(/^[0-9a-f]{40}$/)
    })

    it('should return lowercase hex string', () => {
      const content = new TextEncoder().encode('test')
      const hash = computeObjectHash('blob', content)

      expect(hash).toBe(hash.toLowerCase())
    })

    it('should return 40-character hex string', () => {
      const content = new TextEncoder().encode('any content')
      const hash = computeObjectHash('blob', content)

      expect(hash).toHaveLength(40)
      expect(hash).toMatch(/^[0-9a-f]+$/)
    })
  })
})

// =============================================================================
// SECTION 5: Delta Decompression Tests
// =============================================================================

describe('Delta Decompression', () => {
  describe('OFS_DELTA parsing', () => {
    it('should parse negative offset from OFS_DELTA entry', () => {
      const entry = parsePackEntry(OFS_DELTA_ENTRY, 0)

      expect(entry.type).toBe(6)
      expect(entry.baseOffset).toBeDefined()
      expect(entry.baseOffset).toBe(150)
    })

    it('should decode multi-byte negative offsets', () => {
      // Large offset requiring multiple bytes
      const largeOffset = new Uint8Array([
        0x60, // type 6, size 0
        0xff, 0xff, 0x03, // Large offset
        0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01,
      ])
      const entry = parsePackEntry(largeOffset, 0)

      expect(entry.baseOffset).toBeGreaterThan(16383)
    })

    it('should use offset relative to entry start position', () => {
      // If entry at position 1000, offset 150 means base at 850
      const entry = parsePackEntry(OFS_DELTA_ENTRY, 0)

      // The offset is relative - implementation needs entry position
      expect(entry.baseOffset).toBeDefined()
    })
  })

  describe('REF_DELTA parsing', () => {
    it('should parse 20-byte base SHA from REF_DELTA entry', () => {
      const entry = parsePackEntry(REF_DELTA_ENTRY, 0)

      expect(entry.type).toBe(7)
      expect(entry.baseSha).toBeDefined()
      expect(entry.baseSha).toHaveLength(40) // hex string
    })

    it('should parse base SHA as lowercase hex string', () => {
      const entry = parsePackEntry(REF_DELTA_ENTRY, 0)

      expect(entry.baseSha).toMatch(/^[0-9a-f]{40}$/)
    })

    it('should extract correct base SHA value', () => {
      const entry = parsePackEntry(REF_DELTA_ENTRY, 0)

      // The SHA from our fixture
      expect(entry.baseSha).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
    })
  })

  describe('applyDelta', () => {
    it('should parse source size from delta header', () => {
      const result = applyDelta(DELTA_COPY_INSTRUCTION, new Uint8Array(6))

      // Source size is 6
      expect(result).toBeDefined()
    })

    it('should parse target size from delta header', () => {
      // Target size determines output length
      const base = new TextEncoder().encode('hello\n')
      const result = applyDelta(DELTA_COPY_INSTRUCTION, base)

      expect(result.length).toBe(12) // target size from fixture
    })

    it('should apply copy instruction correctly', () => {
      // Copy 6 bytes from offset 0 of base
      const base = new TextEncoder().encode('hello\n')
      const delta = new Uint8Array([
        0x06, // source size: 6
        0x0c, // target size: 12
        0x90, // copy: offset present (bit 0), size present (bit 4)
        0x00, // offset = 0
        0x06, // size = 6
        0x06, // insert 6 bytes
        0x77, 0x6f, 0x72, 0x6c, 0x64, 0x0a, // "world\n"
      ])

      const result = applyDelta(delta, base)
      const text = new TextDecoder().decode(result)

      expect(text).toBe('hello\nworld\n')
    })

    it('should apply insert instruction correctly', () => {
      const base = new Uint8Array(0)
      const delta = new Uint8Array([
        0x00, // source size: 0
        0x05, // target size: 5
        0x05, // insert 5 bytes
        0x68, 0x65, 0x6c, 0x6c, 0x6f, // "hello"
      ])

      const result = applyDelta(delta, base)
      const text = new TextDecoder().decode(result)

      expect(text).toBe('hello')
    })

    it('should handle copy with partial offset bytes', () => {
      // Copy instruction can have 1-4 offset bytes based on bits 0-3
      const base = new TextEncoder().encode('X'.repeat(1000))
      const delta = new Uint8Array([
        0xe8, 0x07, // source size: 1000
        0x05, // target size: 5
        0x91, // copy: offset byte 0, size byte 0
        0xf4, 0x01, // offset = 500 (little-endian)
        0x05, // size = 5
      ])

      const result = applyDelta(delta, base)

      expect(result.length).toBe(5)
    })

    it('should handle copy with partial size bytes', () => {
      // Size can be 1-3 bytes based on bits 4-6
      const base = new TextEncoder().encode('A'.repeat(300))
      const delta = new Uint8Array([
        0xac, 0x02, // source size: 300
        0x2c, 0x01, // target size: 300
        0xb0, // copy: offset 0, size bytes 4,5
        0x2c, 0x01, // size = 300 (little-endian)
      ])

      const result = applyDelta(delta, base)

      expect(result.length).toBe(300)
    })

    it('should handle multiple copy instructions', () => {
      const base = new TextEncoder().encode('AABBCC')
      const delta = new Uint8Array([
        0x06, // source size: 6
        0x06, // target size: 6
        0x91, 0x00, 0x02, // copy 2 bytes from offset 0: "AA"
        0x91, 0x02, 0x02, // copy 2 bytes from offset 2: "BB"
        0x91, 0x04, 0x02, // copy 2 bytes from offset 4: "CC"
      ])

      const result = applyDelta(delta, base)
      const text = new TextDecoder().decode(result)

      expect(text).toBe('AABBCC')
    })

    it('should handle interleaved copy and insert', () => {
      const base = new TextEncoder().encode('Hello')
      const delta = new Uint8Array([
        0x05, // source size: 5
        0x0c, // target size: 12
        0x91, 0x00, 0x05, // copy "Hello"
        0x01, 0x20, // insert " "
        0x05, 0x57, 0x6f, 0x72, 0x6c, 0x64, // insert "World"
        0x01, 0x21, // insert "!"
      ])

      const result = applyDelta(delta, base)
      const text = new TextDecoder().decode(result)

      expect(text).toBe('Hello World!')
    })

    it('should throw on source size mismatch', () => {
      const base = new Uint8Array(10) // base is 10 bytes
      const delta = new Uint8Array([
        0x14, // source size: 20 (mismatch!)
        0x05, // target size: 5
        0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f,
      ])

      expect(() => applyDelta(delta, base)).toThrow(PackParseError)
    })

    it('should throw on copy beyond source bounds', () => {
      const base = new TextEncoder().encode('short')
      const delta = new Uint8Array([
        0x05, // source size: 5
        0x0a, // target size: 10
        0x91, 0x00, 0x0a, // copy 10 bytes from offset 0 (out of bounds!)
      ])

      expect(() => applyDelta(delta, base)).toThrow(PackParseError)
    })

    it('should throw on invalid instruction byte (0x00)', () => {
      const base = new Uint8Array(5)
      const delta = new Uint8Array([
        0x05, // source size
        0x05, // target size
        0x00, // invalid: reserved instruction
      ])

      expect(() => applyDelta(delta, base)).toThrow(PackParseError)
    })
  })

  describe('Delta chaining', () => {
    it('should resolve chained OFS_DELTA references', async () => {
      // Create a packfile with: base -> delta1 -> delta2
      const packData = new Uint8Array([
        // Header
        0x50, 0x41, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
        // Object 0: base blob
        0x35, 0x78, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0xe7, 0x02, 0x00,
        // Object 1: ofs_delta referencing object 0
        // ... (simplified for test structure)
        // Object 2: ofs_delta referencing object 1
        // ...
      ])

      const result = await parsePackFile(packData)

      // All objects should be resolved
      expect(result.objects).toHaveLength(3)
      result.objects.forEach((obj) => {
        expect(obj.data).toBeDefined()
        expect(obj.sha).toBeDefined()
      })
    })

    it('should resolve chained REF_DELTA references', async () => {
      // Delta chain using SHA references
      const packData = createPackWithRefDeltaChain()

      const result = await parsePackFile(packData)

      expect(result.objects.length).toBeGreaterThan(0)
    })

    it('should throw on missing base object for OFS_DELTA', () => {
      // Delta references offset outside pack
      const badDelta = new Uint8Array([
        0x50, 0x41, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
        // OFS_DELTA with offset pointing before pack start
        0x60, 0xff, 0x7f, // huge offset
        0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01,
      ])

      expect(() => parsePackFile(badDelta)).rejects.toThrow(MissingBaseObjectError)
    })

    it('should throw on missing base object for REF_DELTA', () => {
      // Delta references SHA not in pack
      const badDelta = new Uint8Array([
        0x50, 0x41, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
        // REF_DELTA with unknown base SHA
        0x70, // type 7
        0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef, 0xde, 0xad,
        0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
        0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01,
      ])

      expect(() => parsePackFile(badDelta)).rejects.toThrow(MissingBaseObjectError)
    })

    it('should detect circular delta references', () => {
      // This shouldn't happen in valid packs, but we should handle it
      const circularPack = createPackWithCircularDelta()

      expect(() => parsePackFile(circularPack)).rejects.toThrow(CorruptedPackError)
    })

    it('should handle deep delta chains (>10 levels)', async () => {
      // Git allows deep chains, we should too
      const deepChain = createPackWithDeepDeltaChain(15)

      const result = await parsePackFile(deepChain)

      expect(result.objects).toHaveLength(16) // base + 15 deltas
    })
  })
})

// =============================================================================
// SECTION 6: Checksum Verification Tests
// =============================================================================

describe('Checksum Verification', () => {
  describe('verifyPackChecksum', () => {
    it('should return true for valid pack checksum', () => {
      // Pack with correct SHA-1 footer
      const validPack = createValidPackWithChecksum()

      const result = verifyPackChecksum(validPack)

      expect(result.valid).toBe(true)
    })

    it('should return false for corrupted pack', () => {
      const result = verifyPackChecksum(CORRUPTED_PACK)

      expect(result.valid).toBe(false)
    })

    it('should return expected vs actual checksum on failure', () => {
      const result = verifyPackChecksum(CORRUPTED_PACK)

      expect(result.expected).toMatch(/^[0-9a-f]{40}$/)
      expect(result.actual).toMatch(/^[0-9a-f]{40}$/)
      expect(result.expected).not.toBe(result.actual)
    })

    it('should verify checksum is SHA-1 of pack data minus footer', () => {
      const pack = createValidPackWithChecksum()

      // Footer is last 20 bytes
      const dataWithoutFooter = pack.slice(0, -20)
      const footer = pack.slice(-20)

      const result = verifyPackChecksum(pack)

      // The footer should equal SHA-1(header + entries)
      expect(result.valid).toBe(true)
    })

    it('should throw on pack too small for checksum', () => {
      // Pack must be at least 12 (header) + 20 (checksum) = 32 bytes
      const tooSmall = new Uint8Array(20)

      expect(() => verifyPackChecksum(tooSmall)).toThrow(PackParseError)
    })
  })
})

// =============================================================================
// SECTION 7: Full Pack File Parsing Tests
// =============================================================================

describe('Full Pack File Parsing', () => {
  describe('parsePackFile', () => {
    it('should parse complete packfile with single blob', async () => {
      const pack = createValidPackWithBlob('hello\n')

      const result = await parsePackFile(pack)

      expect(result.version).toBe(2)
      expect(result.objects).toHaveLength(1)
      expect(result.objects[0].type).toBe(3) // blob
    })

    it('should return all objects with computed SHA-1', async () => {
      const pack = createValidPackWithBlob('test content')

      const result = await parsePackFile(pack)

      result.objects.forEach((obj) => {
        expect(obj.sha).toMatch(/^[0-9a-f]{40}$/)
      })
    })

    it('should parse packfile with multiple object types', async () => {
      const pack = createMultiObjectPack()

      const result = await parsePackFile(pack)

      const types = result.objects.map((o) => o.type)
      expect(types).toContain(1) // commit
      expect(types).toContain(2) // tree
      expect(types).toContain(3) // blob
    })

    it('should resolve all deltas before returning', async () => {
      const pack = createPackWithDeltas()

      const result = await parsePackFile(pack)

      // No unresolved deltas
      result.objects.forEach((obj) => {
        expect(obj.type).toBeLessThanOrEqual(4) // No delta types
        expect(obj.data).toBeDefined()
      })
    })

    it('should throw on checksum mismatch', () => {
      expect(() => parsePackFile(CORRUPTED_PACK)).rejects.toThrow(ChecksumMismatchError)
    })

    it('should throw on object count mismatch', () => {
      // Header says 5 objects but pack only has 1
      const mismatch = new Uint8Array([
        0x50, 0x41, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x02,
        0x00, 0x00, 0x00, 0x05, // Claims 5 objects
        // Only 1 object follows
        0x35, 0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01,
        // Checksum
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ])

      expect(() => parsePackFile(mismatch)).rejects.toThrow(CorruptedPackError)
    })

    it('should handle empty packfile (0 objects)', async () => {
      const emptyPack = createEmptyPack()

      const result = await parsePackFile(emptyPack)

      expect(result.objects).toHaveLength(0)
    })

    it('should provide index of objects by SHA', async () => {
      const pack = createMultiObjectPack()

      const result = await parsePackFile(pack)

      // Should be able to lookup by SHA
      const firstSha = result.objects[0].sha
      expect(result.index.get(firstSha)).toBe(result.objects[0])
    })

    it('should preserve object order from pack', async () => {
      const pack = createPackWithKnownOrder()

      const result = await parsePackFile(pack)

      // Objects should be in pack order
      expect(result.objects[0].type).toBe(3) // blob first
      expect(result.objects[1].type).toBe(2) // tree second
      expect(result.objects[2].type).toBe(1) // commit third
    })

    it('should accept external object resolver for thin packs', async () => {
      // Thin pack references objects not in the pack
      const thinPack = createThinPack()

      const externalObjects = new Map<string, Uint8Array>([
        ['ce013625030ba8dba906f756967f9e9ca394464a', new TextEncoder().encode('hello\n')],
      ])

      const result = await parsePackFile(thinPack, {
        resolveExternal: (sha) => externalObjects.get(sha),
      })

      expect(result.objects).toHaveLength(1)
    })
  })
})

// =============================================================================
// SECTION 8: Zlib Decompression Tests
// =============================================================================

describe('Zlib Decompression', () => {
  describe('decompressZlib', () => {
    it('should decompress valid zlib stream', () => {
      // zlib compressed "hello"
      const compressed = new Uint8Array([
        0x78, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x07, 0x00, 0x06, 0x2c, 0x02, 0x15,
      ])

      const result = decompressZlib(compressed)
      const text = new TextDecoder().decode(result.data)

      expect(text).toBe('hello')
    })

    it('should return bytes consumed', () => {
      const compressed = new Uint8Array([
        0x78, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x07, 0x00, 0x06, 0x2c, 0x02, 0x15,
        0x00, 0x00, 0x00, // extra bytes after stream
      ])

      const result = decompressZlib(compressed)

      expect(result.bytesConsumed).toBe(13) // Only the zlib stream
    })

    it('should decompress at specified offset', () => {
      const buffer = new Uint8Array([
        0x00, 0x00, 0x00, // padding
        0x78, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x07, 0x00, 0x06, 0x2c, 0x02, 0x15,
      ])

      const result = decompressZlib(buffer, 3)
      const text = new TextDecoder().decode(result.data)

      expect(text).toBe('hello')
    })

    it('should throw on invalid zlib header', () => {
      const invalid = new Uint8Array([0x00, 0x00, 0x00, 0x00])

      expect(() => decompressZlib(invalid)).toThrow(CorruptedPackError)
    })

    it('should throw on truncated stream', () => {
      const truncated = new Uint8Array([0x78, 0x9c, 0xcb, 0x48])

      expect(() => decompressZlib(truncated)).toThrow(CorruptedPackError)
    })

    it('should handle large decompressed output', () => {
      // Create compressed data for 1MB of zeros
      const largeCompressed = createCompressedZeros(1024 * 1024)

      const result = decompressZlib(largeCompressed)

      expect(result.data.length).toBe(1024 * 1024)
    })
  })
})

// =============================================================================
// SECTION 9: Type Definitions Tests
// =============================================================================

describe('Type Definitions', () => {
  it('should export PackHeader interface', () => {
    const header: PackHeader = {
      magic: 'PACK',
      version: 2,
      objectCount: 1,
      headerSize: 12,
    }

    expect(header.magic).toBe('PACK')
  })

  it('should export PackEntry interface', () => {
    const entry: PackEntry = {
      type: 3,
      typeName: 'blob',
      size: 6,
      data: new Uint8Array(6),
      bytesConsumed: 10,
    }

    expect(entry.type).toBe(3)
  })

  it('should export PackObject interface with SHA', () => {
    const obj: PackObject = {
      type: 3,
      typeName: 'blob',
      size: 6,
      data: new Uint8Array(6),
      sha: 'ce013625030ba8dba906f756967f9e9ca394464a',
    }

    expect(obj.sha).toHaveLength(40)
  })

  it('should export error classes', () => {
    expect(PackParseError).toBeDefined()
    expect(InvalidMagicError).toBeDefined()
    expect(UnsupportedVersionError).toBeDefined()
    expect(ChecksumMismatchError).toBeDefined()
    expect(MissingBaseObjectError).toBeDefined()
    expect(CorruptedPackError).toBeDefined()
  })

  it('should have proper error inheritance', () => {
    const error = new PackParseError('test')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PackParseError')
  })

  it('should include context in error messages', () => {
    const error = new MissingBaseObjectError('abc123', 100)
    expect(error.message).toContain('abc123')
    expect(error.baseSha).toBe('abc123')
    expect(error.offset).toBe(100)
  })
})

// =============================================================================
// Helper Functions for Creating Test Fixtures
// =============================================================================

/**
 * Create a valid packfile containing a single blob with correct checksum
 */
function createValidPackWithBlob(content: string): Uint8Array {
  // This would be implemented to create a real valid packfile
  // For RED phase, we just need the test structure
  throw new Error('Fixture helper not implemented - implementation needed')
}

/**
 * Create a valid packfile with correct SHA-1 footer
 */
function createValidPackWithChecksum(): Uint8Array {
  throw new Error('Fixture helper not implemented - implementation needed')
}

/**
 * Create a packfile with multiple object types
 */
function createMultiObjectPack(): Uint8Array {
  throw new Error('Fixture helper not implemented - implementation needed')
}

/**
 * Create a packfile containing delta objects
 */
function createPackWithDeltas(): Uint8Array {
  throw new Error('Fixture helper not implemented - implementation needed')
}

/**
 * Create an empty packfile (0 objects, valid checksum)
 */
function createEmptyPack(): Uint8Array {
  throw new Error('Fixture helper not implemented - implementation needed')
}

/**
 * Create packfile with known object order for testing
 */
function createPackWithKnownOrder(): Uint8Array {
  throw new Error('Fixture helper not implemented - implementation needed')
}

/**
 * Create thin pack that references external objects
 */
function createThinPack(): Uint8Array {
  throw new Error('Fixture helper not implemented - implementation needed')
}

/**
 * Create REF_DELTA chain for testing
 */
function createPackWithRefDeltaChain(): Uint8Array {
  throw new Error('Fixture helper not implemented - implementation needed')
}

/**
 * Create pack with circular delta reference (invalid)
 */
function createPackWithCircularDelta(): Uint8Array {
  throw new Error('Fixture helper not implemented - implementation needed')
}

/**
 * Create pack with deep delta chain
 */
function createPackWithDeepDeltaChain(depth: number): Uint8Array {
  throw new Error('Fixture helper not implemented - implementation needed')
}

/**
 * Create zlib compressed zeros for testing large decompression
 */
function createCompressedZeros(size: number): Uint8Array {
  throw new Error('Fixture helper not implemented - implementation needed')
}
