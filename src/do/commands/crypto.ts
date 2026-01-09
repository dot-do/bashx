/**
 * Crypto/Hashing Commands Implementation
 *
 * Native implementations of crypto and hashing commands using Web Crypto API:
 * - sha256sum, sha1sum, sha512sum, md5sum
 * - uuidgen / uuid
 * - cksum / sum
 * - openssl (subset)
 *
 * All implementations are designed for Cloudflare Workers environment
 * using Web Crypto API and native crypto primitives.
 *
 * @module bashx/do/commands/crypto
 */

import type { BashResult, FsCapability, ExecOptions } from '../../types.js'

// ============================================================================
// TYPES
// ============================================================================

/**
 * Hash algorithm types supported by Web Crypto API
 */
export type WebCryptoHashAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'

/**
 * Hash algorithm types including MD5 (requires custom implementation)
 */
export type HashAlgorithm = 'md5' | 'sha1' | 'sha256' | 'sha384' | 'sha512'

/**
 * Checksum output format
 */
export type ChecksumFormat = 'default' | 'bsd' | 'binary' | 'text'

/**
 * UUID version
 */
export type UuidVersion = 1 | 3 | 4 | 5

/**
 * Well-known UUID namespaces
 */
export const UUID_NAMESPACES = {
  DNS: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  URL: '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
  OID: '6ba7b812-9dad-11d1-80b4-00c04fd430c8',
  X500: '6ba7b814-9dad-11d1-80b4-00c04fd430c8',
} as const

// ============================================================================
// CORE HASH FUNCTIONS
// ============================================================================

/**
 * Convert Uint8Array to hex string
 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Convert hex string to Uint8Array
 */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

/**
 * Convert string to Uint8Array using UTF-8 encoding
 */
export function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

/**
 * Compute SHA-256 hash
 */
export async function sha256sum(input: Uint8Array | string): Promise<string> {
  const data = typeof input === 'string' ? stringToBytes(input) : input
  const hash = await crypto.subtle.digest('SHA-256', data)
  return toHex(new Uint8Array(hash))
}

/**
 * Compute SHA-1 hash
 */
export async function sha1sum(input: Uint8Array | string): Promise<string> {
  const data = typeof input === 'string' ? stringToBytes(input) : input
  const hash = await crypto.subtle.digest('SHA-1', data)
  return toHex(new Uint8Array(hash))
}

/**
 * Compute SHA-512 hash
 */
export async function sha512sum(input: Uint8Array | string): Promise<string> {
  const data = typeof input === 'string' ? stringToBytes(input) : input
  const hash = await crypto.subtle.digest('SHA-512', data)
  return toHex(new Uint8Array(hash))
}

/**
 * Compute SHA-384 hash
 */
export async function sha384sum(input: Uint8Array | string): Promise<string> {
  const data = typeof input === 'string' ? stringToBytes(input) : input
  const hash = await crypto.subtle.digest('SHA-384', data)
  return toHex(new Uint8Array(hash))
}

/**
 * MD5 implementation (Web Crypto doesn't support MD5)
 * Using a pure JavaScript implementation
 */
export async function md5sum(input: Uint8Array | string): Promise<string> {
  const data = typeof input === 'string' ? stringToBytes(input) : input
  return md5(data)
}

/**
 * Pure JavaScript MD5 implementation
 * Based on RFC 1321
 */
function md5(data: Uint8Array): string {
  // Helper functions
  function F(x: number, y: number, z: number): number {
    return (x & y) | (~x & z)
  }
  function G(x: number, y: number, z: number): number {
    return (x & z) | (y & ~z)
  }
  function H(x: number, y: number, z: number): number {
    return x ^ y ^ z
  }
  function I(x: number, y: number, z: number): number {
    return y ^ (x | ~z)
  }

  function rotateLeft(x: number, n: number): number {
    return (x << n) | (x >>> (32 - n))
  }

  function addUnsigned(x: number, y: number): number {
    return (x + y) >>> 0
  }

  // Per-round shift amounts
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]

  // Pre-computed sine table
  const K = new Uint32Array(64)
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000)
  }

  // Pad message
  const bitLen = data.length * 8
  const padLen = ((data.length + 8) % 64 === 0) ? 64 : 64 - ((data.length + 8) % 64)
  const totalLen = data.length + padLen + 8

  const padded = new Uint8Array(totalLen)
  padded.set(data)
  padded[data.length] = 0x80

  // Append original length in bits as 64-bit little-endian
  const lenView = new DataView(padded.buffer, totalLen - 8)
  lenView.setUint32(0, bitLen >>> 0, true)
  lenView.setUint32(4, Math.floor(bitLen / 0x100000000), true)

  // Initialize hash values
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  // Process each 64-byte chunk
  const view = new DataView(padded.buffer)
  for (let offset = 0; offset < totalLen; offset += 64) {
    // Break chunk into sixteen 32-bit little-endian words
    const M = new Uint32Array(16)
    for (let j = 0; j < 16; j++) {
      M[j] = view.getUint32(offset + j * 4, true)
    }

    let A = a0
    let B = b0
    let C = c0
    let D = d0

    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number

      if (i < 16) {
        f = F(B, C, D)
        g = i
      } else if (i < 32) {
        f = G(B, C, D)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = H(B, C, D)
        g = (3 * i + 5) % 16
      } else {
        f = I(B, C, D)
        g = (7 * i) % 16
      }

      const temp = D
      D = C
      C = B
      B = addUnsigned(B, rotateLeft(addUnsigned(addUnsigned(A, f), addUnsigned(K[i], M[g])), S[i]))
      A = temp
    }

    a0 = addUnsigned(a0, A)
    b0 = addUnsigned(b0, B)
    c0 = addUnsigned(c0, C)
    d0 = addUnsigned(d0, D)
  }

  // Convert to hex string (little-endian)
  const result = new Uint8Array(16)
  const resultView = new DataView(result.buffer)
  resultView.setUint32(0, a0, true)
  resultView.setUint32(4, b0, true)
  resultView.setUint32(8, c0, true)
  resultView.setUint32(12, d0, true)

  return toHex(result)
}

// ============================================================================
// UUID FUNCTIONS
// ============================================================================

/**
 * Generate UUID v4 (random)
 */
export function uuidv4(): string {
  return crypto.randomUUID()
}

/**
 * Generate UUID v1 (time-based)
 * Uses timestamp and random node ID (no MAC address available in Workers)
 */
export function uuidv1(): string {
  // Get current timestamp in 100-nanosecond intervals since UUID epoch (Oct 15, 1582)
  const UUID_EPOCH_MS = Date.UTC(1582, 9, 15)
  const now = Date.now()
  const timestamp = BigInt((now - UUID_EPOCH_MS) * 10000)

  // Extract time components (60 bits total)
  const timeLow = Number(timestamp & 0xffffffffn)
  const timeMid = Number((timestamp >> 32n) & 0xffffn)
  const timeHiAndVersion = Number((timestamp >> 48n) & 0x0fffn) | 0x1000 // Version 1

  // Clock sequence (14 bits random)
  const clockSeqBytes = new Uint8Array(2)
  crypto.getRandomValues(clockSeqBytes)
  const clockSeq = ((clockSeqBytes[0] & 0x3f) << 8) | clockSeqBytes[1]
  const clockSeqHiAndReserved = ((clockSeq >> 8) & 0x3f) | 0x80 // Variant 10xx
  const clockSeqLow = clockSeq & 0xff

  // Node (48 bits random since we don't have MAC address)
  const nodeBytes = new Uint8Array(6)
  crypto.getRandomValues(nodeBytes)
  // Set multicast bit to indicate random node
  nodeBytes[0] |= 0x01

  // Format UUID
  const hex = (n: number, len: number) => n.toString(16).padStart(len, '0')
  const nodeHex = Array.from(nodeBytes).map(b => hex(b, 2)).join('')

  return `${hex(timeLow, 8)}-${hex(timeMid, 4)}-${hex(timeHiAndVersion, 4)}-${hex(clockSeqHiAndReserved, 2)}${hex(clockSeqLow, 2)}-${nodeHex}`
}

/**
 * Generate UUID v3 (MD5 namespace-based)
 */
export async function uuidv3(namespace: string, name: string): Promise<string> {
  const namespaceBytes = parseUuid(namespace)
  const nameBytes = stringToBytes(name)

  const data = new Uint8Array(namespaceBytes.length + nameBytes.length)
  data.set(namespaceBytes)
  data.set(nameBytes, namespaceBytes.length)

  const hash = await md5sum(data)
  return formatUuidFromHash(hash, 3)
}

/**
 * Generate UUID v5 (SHA-1 namespace-based)
 */
export async function uuidv5(namespace: string, name: string): Promise<string> {
  const namespaceBytes = parseUuid(namespace)
  const nameBytes = stringToBytes(name)

  const data = new Uint8Array(namespaceBytes.length + nameBytes.length)
  data.set(namespaceBytes)
  data.set(nameBytes, namespaceBytes.length)

  const hash = await sha1sum(data)
  return formatUuidFromHash(hash, 5)
}

/**
 * Parse UUID string to bytes
 */
function parseUuid(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32) {
    throw new Error(`Invalid UUID: ${uuid}`)
  }
  return fromHex(hex)
}

/**
 * Format hash bytes as UUID with version
 */
function formatUuidFromHash(hash: string, version: 3 | 5): string {
  // Take first 16 bytes (32 hex chars)
  const bytes = fromHex(hash.slice(0, 32))

  // Set version (4 bits at position 12-15)
  bytes[6] = (bytes[6] & 0x0f) | (version << 4)

  // Set variant (2 bits at position 64-65)
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = toHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * Get nil UUID
 */
export function uuidNil(): string {
  return '00000000-0000-0000-0000-000000000000'
}

/**
 * Generate random bytes
 */
export function randomBytes(length: number, format: 'hex' | 'base64' | 'raw' = 'hex'): string | Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)

  if (format === 'hex') {
    return toHex(bytes)
  } else if (format === 'base64') {
    return btoa(String.fromCharCode(...bytes))
  }
  return bytes
}

// ============================================================================
// CRC / CHECKSUM FUNCTIONS
// ============================================================================

/**
 * CRC-32 lookup table (IEEE 802.3 polynomial)
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1)
    }
    table[i] = crc >>> 0
  }
  return table
})()

/**
 * Compute CRC-32 checksum (POSIX cksum compatible)
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff

  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }

  // Include length in CRC (POSIX cksum does this)
  let len = data.length
  while (len > 0) {
    crc = CRC32_TABLE[(crc ^ (len & 0xff)) & 0xff] ^ (crc >>> 8)
    len >>>= 8
  }

  return (crc ^ 0xffffffff) >>> 0
}

/**
 * BSD sum algorithm
 */
export function bsdSum(data: Uint8Array): { checksum: number; blocks: number } {
  let checksum = 0

  for (let i = 0; i < data.length; i++) {
    // Rotate right by 1
    checksum = ((checksum >> 1) | ((checksum & 1) << 15)) & 0xffff
    // Add byte
    checksum = (checksum + data[i]) & 0xffff
  }

  // Calculate blocks (1024 byte blocks, rounded up)
  const blocks = Math.ceil(data.length / 1024)

  return { checksum, blocks }
}

/**
 * System V sum algorithm
 */
export function sysvSum(data: Uint8Array): { checksum: number; blocks: number } {
  let sum = 0

  for (let i = 0; i < data.length; i++) {
    sum += data[i]
  }

  // Fold to 16 bits
  let checksum = (sum & 0xffff) + ((sum >> 16) & 0xffff)
  checksum = (checksum & 0xffff) + ((checksum >> 16) & 0xffff)

  // Calculate blocks (512 byte blocks, rounded up)
  const blocks = Math.ceil(data.length / 512)

  return { checksum, blocks }
}

// ============================================================================
// PASSWORD HASHING (SHA-CRYPT)
// ============================================================================

/**
 * Base64 alphabet for SHA-crypt
 */
const SHA_CRYPT_ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * Encode bytes to SHA-crypt base64
 */
function shaCryptBase64(bytes: Uint8Array, order: number[]): string {
  let result = ''
  for (let i = 0; i < order.length; i += 3) {
    const b0 = bytes[order[i]] ?? 0
    const b1 = bytes[order[i + 1]] ?? 0
    const b2 = bytes[order[i + 2]] ?? 0

    let value = (b0 << 16) | (b1 << 8) | b2
    const chars = i + 3 > order.length ? (order.length - i) + 1 : 4

    for (let j = 0; j < chars; j++) {
      result += SHA_CRYPT_ALPHABET[value & 0x3f]
      value >>>= 6
    }
  }
  return result
}

/**
 * Generate random salt for SHA-crypt
 */
function generateSalt(length: number = 16): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map(b => SHA_CRYPT_ALPHABET[b % 64])
    .join('')
}

/**
 * SHA-512 crypt ($6$) password hashing
 * Simplified implementation following crypt(3) specification
 */
export async function sha512Crypt(password: string, salt?: string): Promise<string> {
  salt = salt || generateSalt(16)
  // Limit salt to 16 characters
  salt = salt.slice(0, 16)

  const passwordBytes = stringToBytes(password)
  const saltBytes = stringToBytes(salt)

  // Initial digest: password + salt + password
  const digestB = await crypto.subtle.digest('SHA-512',
    new Uint8Array([...passwordBytes, ...saltBytes, ...passwordBytes])
  )
  const B = new Uint8Array(digestB)

  // Digest A: password + salt + B (repeated)
  const aInput: number[] = [...passwordBytes, ...saltBytes]
  let len = passwordBytes.length
  while (len > 0) {
    const take = Math.min(len, 64)
    aInput.push(...B.slice(0, take))
    len -= take
  }

  // Add bits based on password length
  len = passwordBytes.length
  while (len > 0) {
    if (len & 1) {
      aInput.push(...B)
    } else {
      aInput.push(...passwordBytes)
    }
    len >>>= 1
  }

  let A = new Uint8Array(await crypto.subtle.digest('SHA-512', new Uint8Array(aInput)))

  // Digest DP (password repeated)
  const dpInput: number[] = []
  for (let i = 0; i < passwordBytes.length; i++) {
    dpInput.push(...passwordBytes)
  }
  const DP = new Uint8Array(await crypto.subtle.digest('SHA-512', new Uint8Array(dpInput)))

  // Create P sequence
  const P = new Uint8Array(passwordBytes.length)
  for (let i = 0; i < passwordBytes.length; i++) {
    P[i] = DP[i % 64]
  }

  // Digest DS (salt repeated)
  const dsInput: number[] = []
  for (let i = 0; i < 16 + A[0]; i++) {
    dsInput.push(...saltBytes)
  }
  const DS = new Uint8Array(await crypto.subtle.digest('SHA-512', new Uint8Array(dsInput)))

  // Create S sequence
  const S = new Uint8Array(saltBytes.length)
  for (let i = 0; i < saltBytes.length; i++) {
    S[i] = DS[i % 64]
  }

  // 5000 rounds
  for (let round = 0; round < 5000; round++) {
    const cInput: number[] = []

    if (round & 1) {
      cInput.push(...P)
    } else {
      cInput.push(...A)
    }

    if (round % 3 !== 0) {
      cInput.push(...S)
    }

    if (round % 7 !== 0) {
      cInput.push(...P)
    }

    if (round & 1) {
      cInput.push(...A)
    } else {
      cInput.push(...P)
    }

    A = new Uint8Array(await crypto.subtle.digest('SHA-512', new Uint8Array(cInput)))
  }

  // Encode result using SHA-512 specific byte order
  const order = [
    0, 21, 42, 22, 43, 1, 44, 2, 23, 3, 24, 45,
    25, 46, 4, 47, 5, 26, 6, 27, 48, 28, 49, 7,
    50, 8, 29, 9, 30, 51, 31, 52, 10, 53, 11, 32,
    12, 33, 54, 34, 55, 13, 56, 14, 35, 15, 36, 57,
    37, 58, 16, 59, 17, 38, 18, 39, 60, 40, 61, 19,
    62, 20, 41, 63
  ]

  const encoded = shaCryptBase64(A, order)
  return `$6$${salt}$${encoded}`
}

/**
 * SHA-256 crypt ($5$) password hashing
 */
export async function sha256Crypt(password: string, salt?: string): Promise<string> {
  salt = salt || generateSalt(16)
  salt = salt.slice(0, 16)

  const passwordBytes = stringToBytes(password)
  const saltBytes = stringToBytes(salt)

  // Initial digest: password + salt + password
  const digestB = await crypto.subtle.digest('SHA-256',
    new Uint8Array([...passwordBytes, ...saltBytes, ...passwordBytes])
  )
  const B = new Uint8Array(digestB)

  // Digest A
  const aInput: number[] = [...passwordBytes, ...saltBytes]
  let len = passwordBytes.length
  while (len > 0) {
    const take = Math.min(len, 32)
    aInput.push(...B.slice(0, take))
    len -= take
  }

  len = passwordBytes.length
  while (len > 0) {
    if (len & 1) {
      aInput.push(...B)
    } else {
      aInput.push(...passwordBytes)
    }
    len >>>= 1
  }

  let A = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(aInput)))

  // Digest DP
  const dpInput: number[] = []
  for (let i = 0; i < passwordBytes.length; i++) {
    dpInput.push(...passwordBytes)
  }
  const DP = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(dpInput)))

  const P = new Uint8Array(passwordBytes.length)
  for (let i = 0; i < passwordBytes.length; i++) {
    P[i] = DP[i % 32]
  }

  // Digest DS
  const dsInput: number[] = []
  for (let i = 0; i < 16 + A[0]; i++) {
    dsInput.push(...saltBytes)
  }
  const DS = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(dsInput)))

  const S = new Uint8Array(saltBytes.length)
  for (let i = 0; i < saltBytes.length; i++) {
    S[i] = DS[i % 32]
  }

  // 5000 rounds
  for (let round = 0; round < 5000; round++) {
    const cInput: number[] = []

    if (round & 1) {
      cInput.push(...P)
    } else {
      cInput.push(...A)
    }

    if (round % 3 !== 0) {
      cInput.push(...S)
    }

    if (round % 7 !== 0) {
      cInput.push(...P)
    }

    if (round & 1) {
      cInput.push(...A)
    } else {
      cInput.push(...P)
    }

    A = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(cInput)))
  }

  // SHA-256 specific byte order
  const order = [
    0, 10, 20, 21, 1, 11, 12, 22, 2, 3, 13, 23,
    24, 4, 14, 15, 25, 5, 6, 16, 26, 27, 7, 17,
    18, 28, 8, 9, 19, 29, 31, 30
  ]

  const encoded = shaCryptBase64(A, order)
  return `$5$${salt}$${encoded}`
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

export interface CryptoCommandContext {
  fs?: FsCapability
  stdin?: string
}

/**
 * Execute sha256sum command
 */
export async function executeSha256sum(
  args: string[],
  ctx: CryptoCommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return executeHashCommand('sha256', 64, 'SHA256', args, ctx)
}

/**
 * Execute sha1sum command
 */
export async function executeSha1sum(
  args: string[],
  ctx: CryptoCommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return executeHashCommand('sha1', 40, 'SHA1', args, ctx)
}

/**
 * Execute sha512sum command
 */
export async function executeSha512sum(
  args: string[],
  ctx: CryptoCommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return executeHashCommand('sha512', 128, 'SHA512', args, ctx)
}

/**
 * Execute md5sum command
 */
export async function executeMd5sum(
  args: string[],
  ctx: CryptoCommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return executeHashCommand('md5', 32, 'MD5', args, ctx)
}

/**
 * Generic hash command executor
 */
async function executeHashCommand(
  algorithm: 'md5' | 'sha1' | 'sha256' | 'sha384' | 'sha512',
  hashLength: number,
  tagName: string,
  args: string[],
  ctx: CryptoCommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const hashFn = {
    md5: md5sum,
    sha1: sha1sum,
    sha256: sha256sum,
    sha384: sha384sum,
    sha512: sha512sum,
  }[algorithm]

  // Parse options
  let checkMode = false
  let bsdStyle = false
  let binaryMode = false
  let textMode = false
  let quiet = false
  let status = false
  let warn = false
  const files: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-c' || arg === '--check') {
      checkMode = true
    } else if (arg === '--tag') {
      bsdStyle = true
    } else if (arg === '-b') {
      binaryMode = true
    } else if (arg === '-t') {
      textMode = true
    } else if (arg === '--quiet') {
      quiet = true
    } else if (arg === '--status') {
      status = true
    } else if (arg === '--warn') {
      warn = true
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    }
  }

  // Check mode: verify checksums from file
  if (checkMode) {
    return verifyChecksums(files, hashFn, ctx, { quiet, status, warn })
  }

  // Hash mode: compute hashes
  let stdout = ''
  let stderr = ''
  let exitCode = 0

  // If no files and stdin provided, hash stdin
  if (files.length === 0 || (files.length === 1 && files[0] === '-')) {
    const input = ctx.stdin || ''
    const hash = await hashFn(input)
    if (bsdStyle) {
      stdout = `${tagName} (-) = ${hash}\n`
    } else {
      stdout = `${hash}  -\n`
    }
    return { stdout, stderr, exitCode }
  }

  // Hash each file
  for (const file of files) {
    try {
      if (!ctx.fs) {
        stderr += `${algorithm}sum: ${file}: No filesystem available\n`
        exitCode = 1
        continue
      }

      const content = await ctx.fs.read(file, { encoding: 'utf-8' }) as string
      const hash = await hashFn(content)

      if (bsdStyle) {
        stdout += `${tagName} (${file}) = ${hash}\n`
      } else if (binaryMode) {
        stdout += `${hash} *${file}\n`
      } else {
        stdout += `${hash}  ${file}\n`
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stderr += `${algorithm}sum: ${file}: No such file or directory\n`
      exitCode = 1
    }
  }

  return { stdout, stderr, exitCode }
}

/**
 * Verify checksums from a file
 */
async function verifyChecksums(
  files: string[],
  hashFn: (input: string | Uint8Array) => Promise<string>,
  ctx: CryptoCommandContext,
  options: { quiet: boolean; status: boolean; warn: boolean }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  let failures = 0
  let validLinesProcessed = 0

  if (!ctx.fs || files.length === 0) {
    return { stdout: '', stderr: 'No checksum file specified\n', exitCode: 1 }
  }

  for (const checksumFile of files) {
    try {
      const content = await ctx.fs.read(checksumFile, { encoding: 'utf-8' }) as string
      const lines = content.trim().split('\n')
      let malformedCount = 0

      for (const line of lines) {
        // Parse checksum line: "hash  filename" or "hash *filename"
        const match = line.match(/^([a-f0-9]+)\s+[\s*]?(.+)$/)
        if (!match) {
          malformedCount++
          if (options.warn) {
            stderr += `${checksumFile}: improperly formatted checksum line\n`
          }
          continue
        }

        validLinesProcessed++
        const [, expectedHash, filename] = match

        try {
          const fileContent = await ctx.fs!.read(filename, { encoding: 'utf-8' }) as string
          const actualHash = await hashFn(fileContent)

          if (actualHash === expectedHash) {
            if (!options.quiet && !options.status) {
              stdout += `${filename}: OK\n`
            }
          } else {
            failures++
            if (!options.status) {
              stdout += `${filename}: FAILED\n`
            }
          }
        } catch {
          failures++
          if (!options.status) {
            stdout += `${filename}: FAILED open or read\n`
          }
        }
      }

      // If all lines were malformed, report error
      if (validLinesProcessed === 0 && malformedCount > 0) {
        stderr += `${checksumFile}: no properly formatted checksum lines found\n`
        exitCode = 1
      }
    } catch (error) {
      stderr += `Cannot read ${checksumFile}\n`
      exitCode = 1
    }
  }

  if (failures > 0) {
    exitCode = 1
  }

  return { stdout, stderr, exitCode }
}

/**
 * Execute uuidgen command
 */
export async function executeUuidgen(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let version: UuidVersion = 4
  let count = 1
  let uppercase = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-r' || arg === '--random') {
      version = 4
    } else if (arg === '-t' || arg === '--time') {
      version = 1
    } else if (arg === '-n' && args[i + 1]) {
      count = parseInt(args[++i], 10)
    } else if (arg === '-u') {
      uppercase = true
    }
  }

  let stdout = ''
  for (let i = 0; i < count; i++) {
    let uuid: string
    if (version === 1) {
      uuid = uuidv1()
    } else {
      uuid = uuidv4()
    }
    if (uppercase) {
      uuid = uuid.toUpperCase()
    }
    stdout += uuid + '\n'
  }

  return { stdout, stderr: '', exitCode: 0 }
}

/**
 * Execute uuid command
 */
export async function executeUuid(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let version: UuidVersion = 4
  let namespace: string | undefined
  let name: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if ((arg === '-v' || arg === '--version') && args[i + 1]) {
      const v = parseInt(args[++i], 10)
      if (![1, 3, 4, 5].includes(v)) {
        return { stdout: '', stderr: `uuid: invalid version: ${v}\n`, exitCode: 1 }
      }
      version = v as UuidVersion
    } else if (arg === '--nil') {
      return { stdout: uuidNil() + '\n', stderr: '', exitCode: 0 }
    } else if (!arg.startsWith('-')) {
      if (!namespace) {
        namespace = arg
      } else if (!name) {
        name = arg
      }
    }
  }

  // For v3 and v5, we need namespace and name
  if ((version === 3 || version === 5) && (!namespace || !name)) {
    return {
      stdout: '',
      stderr: `uuid: version ${version} requires namespace and name\n`,
      exitCode: 1,
    }
  }

  try {
    let uuid: string

    switch (version) {
      case 1:
        uuid = uuidv1()
        break
      case 3:
        uuid = await uuidv3(resolveNamespace(namespace!), name!)
        break
      case 4:
        uuid = uuidv4()
        break
      case 5:
        uuid = await uuidv5(resolveNamespace(namespace!), name!)
        break
      default:
        return { stdout: '', stderr: `uuid: unsupported version: ${version}\n`, exitCode: 1 }
    }

    return { stdout: uuid + '\n', stderr: '', exitCode: 0 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { stdout: '', stderr: `uuid: ${message}\n`, exitCode: 1 }
  }
}

/**
 * Resolve namespace alias or UUID
 */
function resolveNamespace(ns: string): string {
  if (ns.startsWith('ns:')) {
    const name = ns.slice(3).toUpperCase() as keyof typeof UUID_NAMESPACES
    if (UUID_NAMESPACES[name]) {
      return UUID_NAMESPACES[name]
    }
    throw new Error(`Unknown namespace: ${ns}`)
  }
  // Assume it's a UUID string
  return ns
}

/**
 * Execute cksum command
 */
export async function executeCksum(
  args: string[],
  ctx: CryptoCommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const files = args.filter(a => !a.startsWith('-'))

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  // If no files, use stdin
  if (files.length === 0) {
    const input = stringToBytes(ctx.stdin || '')
    const crc = crc32(input)
    stdout = `${crc} ${input.length}\n`
    return { stdout, stderr, exitCode }
  }

  for (const file of files) {
    try {
      if (!ctx.fs) {
        stderr += `cksum: ${file}: No filesystem available\n`
        exitCode = 1
        continue
      }

      const content = await ctx.fs.read(file, { encoding: 'utf-8' }) as string
      const data = stringToBytes(content)
      const crc = crc32(data)
      stdout += `${crc} ${data.length} ${file}\n`
    } catch (error) {
      stderr += `cksum: ${file}: No such file or directory\n`
      exitCode = 1
    }
  }

  return { stdout, stderr, exitCode }
}

/**
 * Execute sum command
 */
export async function executeSum(
  args: string[],
  ctx: CryptoCommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let useSysv = false
  const files: string[] = []

  for (const arg of args) {
    if (arg === '-s' || arg === '--sysv') {
      useSysv = true
    } else if (arg === '-r') {
      useSysv = false // BSD is default
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    }
  }

  const sumFn = useSysv ? sysvSum : bsdSum

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  // If no files, use stdin
  if (files.length === 0) {
    const input = stringToBytes(ctx.stdin || '')
    const { checksum, blocks } = sumFn(input)
    stdout = `${checksum} ${blocks}\n`
    return { stdout, stderr, exitCode }
  }

  for (const file of files) {
    try {
      if (!ctx.fs) {
        stderr += `sum: ${file}: No filesystem available\n`
        exitCode = 1
        continue
      }

      const content = await ctx.fs.read(file, { encoding: 'utf-8' }) as string
      const data = stringToBytes(content)
      const { checksum, blocks } = sumFn(data)
      stdout += `${checksum} ${blocks} ${file}\n`
    } catch (error) {
      stderr += `sum: ${file}: No such file or directory\n`
      exitCode = 1
    }
  }

  return { stdout, stderr, exitCode }
}

/**
 * Execute openssl command
 */
export async function executeOpenssl(
  args: string[],
  ctx: CryptoCommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (args.length === 0) {
    return { stdout: '', stderr: 'openssl: missing command\n', exitCode: 1 }
  }

  const subcommand = args[0]
  const subArgs = args.slice(1)

  switch (subcommand) {
    case 'dgst':
      return executeOpensslDgst(subArgs, ctx)
    case 'enc':
      return executeOpensslEnc(subArgs, ctx)
    case 'rand':
      return executeOpensslRand(subArgs)
    case 'passwd':
      return executeOpensslPasswd(subArgs, ctx)
    default:
      return { stdout: '', stderr: `openssl: unknown command: ${subcommand}\n`, exitCode: 1 }
  }
}

/**
 * Execute openssl dgst command
 */
async function executeOpensslDgst(
  args: string[],
  ctx: CryptoCommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let algorithm = 'sha256'
  let reverseFormat = false
  const files: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-sha256') {
      algorithm = 'sha256'
    } else if (arg === '-sha1') {
      algorithm = 'sha1'
    } else if (arg === '-sha512') {
      algorithm = 'sha512'
    } else if (arg === '-md5') {
      algorithm = 'md5'
    } else if (arg === '-r') {
      reverseFormat = true
    } else if (arg === '-hex') {
      // Default format, ignore
    } else if (arg.startsWith('-')) {
      if (!['sha256', 'sha1', 'sha512', 'md5', 'sha384'].includes(arg.slice(1))) {
        return { stdout: '', stderr: `openssl dgst: unknown option or digest: ${arg}\n`, exitCode: 1 }
      }
      algorithm = arg.slice(1)
    } else {
      files.push(arg)
    }
  }

  const hashFn = {
    md5: md5sum,
    sha1: sha1sum,
    sha256: sha256sum,
    sha384: sha384sum,
    sha512: sha512sum,
  }[algorithm]

  if (!hashFn) {
    return { stdout: '', stderr: `openssl dgst: unknown digest: ${algorithm}\n`, exitCode: 1 }
  }

  const tagName = {
    md5: 'MD5',
    sha1: 'SHA1',
    sha256: 'SHA2-256',
    sha384: 'SHA2-384',
    sha512: 'SHA2-512',
  }[algorithm]

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  // If no files, use stdin
  if (files.length === 0) {
    const input = ctx.stdin || ''
    const hash = await hashFn(input)
    if (reverseFormat) {
      stdout = `${hash} *stdin\n`
    } else {
      stdout = `${tagName}(stdin)= ${hash}\n`
    }
    return { stdout, stderr, exitCode }
  }

  for (const file of files) {
    try {
      if (!ctx.fs) {
        stderr += `openssl dgst: ${file}: No filesystem available\n`
        exitCode = 1
        continue
      }

      const content = await ctx.fs.read(file, { encoding: 'utf-8' }) as string
      const hash = await hashFn(content)

      if (reverseFormat) {
        stdout += `${hash} *${file}\n`
      } else {
        stdout += `${tagName}(${file})= ${hash}\n`
      }
    } catch (error) {
      stderr += `openssl dgst: ${file}: No such file or directory\n`
      exitCode = 1
    }
  }

  return { stdout, stderr, exitCode }
}

/**
 * Execute openssl enc command (base64 encoding/decoding)
 */
async function executeOpensslEnc(
  args: string[],
  ctx: CryptoCommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let decode = false
  let singleLine = false
  let inputFile: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-d' || arg === '-decode') {
      decode = true
    } else if (arg === '-A') {
      singleLine = true
    } else if (arg === '-in' && args[i + 1]) {
      inputFile = args[++i]
    } else if (arg === '-base64') {
      // Default, ignore
    }
  }

  let input: string

  if (inputFile) {
    if (!ctx.fs) {
      return { stdout: '', stderr: 'openssl enc: No filesystem available\n', exitCode: 1 }
    }
    try {
      input = await ctx.fs.read(inputFile, { encoding: 'utf-8' }) as string
    } catch {
      return { stdout: '', stderr: `openssl enc: ${inputFile}: No such file\n`, exitCode: 1 }
    }
  } else {
    input = ctx.stdin || ''
  }

  try {
    let output: string

    if (decode) {
      // Base64 decode
      const cleaned = input.replace(/\s/g, '')
      output = atob(cleaned)
    } else {
      // Base64 encode
      output = btoa(input)
      if (!singleLine && output.length > 64) {
        // Wrap at 64 characters
        output = output.match(/.{1,64}/g)?.join('\n') || output
      }
    }

    return { stdout: output + (decode ? '' : '\n'), stderr: '', exitCode: 0 }
  } catch (error) {
    return { stdout: '', stderr: 'openssl enc: error encoding/decoding\n', exitCode: 1 }
  }
}

/**
 * Execute openssl rand command
 */
async function executeOpensslRand(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let format: 'hex' | 'base64' = 'hex'
  let numBytes = 0

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-hex') {
      format = 'hex'
    } else if (arg === '-base64') {
      format = 'base64'
    } else if (!arg.startsWith('-') || /^-\d+$/.test(arg)) {
      const n = parseInt(arg, 10)
      if (isNaN(n)) {
        return { stdout: '', stderr: `openssl rand: invalid number: ${arg}\n`, exitCode: 1 }
      }
      if (n < 0) {
        return { stdout: '', stderr: 'openssl rand: invalid count\n', exitCode: 1 }
      }
      numBytes = n
    }
  }

  if (numBytes === 0) {
    return { stdout: '\n', stderr: '', exitCode: 0 }
  }

  const result = randomBytes(numBytes, format) as string
  return { stdout: result + '\n', stderr: '', exitCode: 0 }
}

/**
 * Execute openssl passwd command
 */
async function executeOpensslPasswd(
  args: string[],
  ctx: CryptoCommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let algorithm: '5' | '6' = '6'
  let salt: string | undefined
  let useStdin = false
  let password: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-5') {
      algorithm = '5'
    } else if (arg === '-6') {
      algorithm = '6'
    } else if (arg === '-salt' && args[i + 1]) {
      salt = args[++i]
    } else if (arg === '-stdin') {
      useStdin = true
    } else if (!arg.startsWith('-')) {
      password = arg
    }
  }

  if (useStdin) {
    password = (ctx.stdin || '').trim()
  }

  if (!password) {
    return { stdout: '', stderr: 'openssl passwd: password required\n', exitCode: 1 }
  }

  try {
    let hash: string
    if (algorithm === '5') {
      hash = await sha256Crypt(password, salt)
    } else {
      hash = await sha512Crypt(password, salt)
    }
    return { stdout: hash + '\n', stderr: '', exitCode: 0 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { stdout: '', stderr: `openssl passwd: ${message}\n`, exitCode: 1 }
  }
}

// ============================================================================
// COMMAND LIST FOR TIER 1 REGISTRATION
// ============================================================================

/**
 * List of crypto commands for Tier 1 native execution
 */
export const CRYPTO_COMMANDS = new Set([
  'sha256sum',
  'sha1sum',
  'sha512sum',
  'sha384sum',
  'md5sum',
  'uuidgen',
  'uuid',
  'cksum',
  'sum',
  'openssl',
])

/**
 * Execute a crypto command
 */
export async function executeCryptoCommand(
  cmd: string,
  args: string[],
  ctx: CryptoCommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  switch (cmd) {
    case 'sha256sum':
      return executeSha256sum(args, ctx)
    case 'sha1sum':
      return executeSha1sum(args, ctx)
    case 'sha512sum':
      return executeSha512sum(args, ctx)
    case 'sha384sum':
      return executeHashCommand('sha384', 96, 'SHA384', args, ctx)
    case 'md5sum':
      return executeMd5sum(args, ctx)
    case 'uuidgen':
      return executeUuidgen(args)
    case 'uuid':
      return executeUuid(args)
    case 'cksum':
      return executeCksum(args, ctx)
    case 'sum':
      return executeSum(args, ctx)
    case 'openssl':
      return executeOpenssl(args, ctx)
    default:
      return { stdout: '', stderr: `Unknown crypto command: ${cmd}\n`, exitCode: 1 }
  }
}
