/**
 * Git Wire Protocol Tests
 *
 * Comprehensive tests for the Git smart protocol implementation.
 * Covers pkt-line format, refs discovery, capabilities, and object negotiation.
 *
 * RED phase: These tests are written to fail until implementation is complete.
 */

import { describe, it, expect } from 'vitest'

// Imports from modules that don't exist yet (RED phase)
import {
  parsePktLine,
  parsePktLines,
  generatePktLine,
  generateFlushPkt,
  generateDelimPkt,
  PKT_LINE_MAX_LENGTH,
  FLUSH_PKT,
  DELIM_PKT,
} from '../../src/remote/pkt-line.js'

import {
  parseRefs,
  parseServiceHeader,
  extractCapabilities,
  type RefInfo,
  type RefsResponse,
} from '../../src/remote/refs.js'

import {
  parseCapabilities,
  type Capabilities,
  hasCapability,
  getCapabilityValue,
} from '../../src/remote/capabilities.js'

import {
  generateWantLine,
  generateHaveLine,
  generateDonePkt,
  parseNakResponse,
  parseAckResponse,
  type AckResponse,
  type NegotiationState,
} from '../../src/remote/negotiation.js'

// =============================================================================
// PKT-LINE FORMAT TESTS
// =============================================================================

describe('pkt-line Format', () => {
  describe('parsing', () => {
    it('should parse 4-digit hex length prefix', () => {
      // Format: 4 hex digits indicating total line length (including the 4 bytes)
      const input = '000ahello'
      const result = parsePktLine(input)

      expect(result).toBeDefined()
      expect(result.length).toBe(10) // 0x000a = 10
      expect(result.payload).toBe('hello')
      expect(result.remainder).toBe('')
    })

    it('should extract payload correctly', () => {
      // Real example from git protocol
      const input = '0032want abc123def456 multi_ack side-band-64k\n'
      const result = parsePktLine(input)

      expect(result.payload).toBe('want abc123def456 multi_ack side-band-64k\n')
      expect(result.length).toBe(0x32) // 50 bytes total
    })

    it('should handle flush packet (0000)', () => {
      const input = '0000more data'
      const result = parsePktLine(input)

      expect(result.type).toBe('flush')
      expect(result.payload).toBeNull()
      expect(result.remainder).toBe('more data')
    })

    it('should handle delimiter packet (0001)', () => {
      // Used in protocol v2 to separate sections
      const input = '0001section data'
      const result = parsePktLine(input)

      expect(result.type).toBe('delimiter')
      expect(result.payload).toBeNull()
      expect(result.remainder).toBe('section data')
    })

    it('should parse multiple consecutive pkt-lines', () => {
      const input =
        '000bline 1\n' + // 11 bytes: "line 1\n"
        '000bline 2\n' + // 11 bytes: "line 2\n"
        '0000'           // flush

      const results = parsePktLines(input)

      expect(results).toHaveLength(3)
      expect(results[0].payload).toBe('line 1\n')
      expect(results[1].payload).toBe('line 2\n')
      expect(results[2].type).toBe('flush')
    })

    it('should handle binary data in payload', () => {
      // Binary data is common in packfiles
      const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe])
      const lengthHex = (4 + binaryData.length).toString(16).padStart(4, '0')
      const input = Buffer.concat([
        Buffer.from(lengthHex),
        Buffer.from(binaryData),
      ])

      const result = parsePktLine(input)

      expect(result.payload).toBeInstanceOf(Uint8Array)
      expect(result.payload).toEqual(binaryData)
    })

    it('should reject invalid length prefix', () => {
      const invalidInputs = [
        'XXXX',      // non-hex
        '00',        // too short
        '0002data',  // length too small (min is 4)
        '0003data',  // length too small (min is 4 for header only)
      ]

      for (const input of invalidInputs) {
        expect(() => parsePktLine(input)).toThrow(/invalid pkt-line/i)
      }
    })

    it('should reject length exceeding max (65520 bytes)', () => {
      // Max length is 65520 (0xfff0) per Git protocol spec
      expect(PKT_LINE_MAX_LENGTH).toBe(65520)

      const oversizedLength = 'fff1' // 65521 bytes
      const input = oversizedLength + 'x'.repeat(65517)

      expect(() => parsePktLine(input)).toThrow(/exceeds maximum/i)
    })

    it('should handle pkt-line with only length (no payload)', () => {
      // Length 4 means just the length bytes, no payload
      const input = '0004rest'
      const result = parsePktLine(input)

      expect(result.payload).toBe('')
      expect(result.remainder).toBe('rest')
    })
  })

  describe('generation', () => {
    it('should generate pkt-lines with correct length prefix', () => {
      const payload = 'hello world\n'
      const result = generatePktLine(payload)

      // Length = 4 (prefix) + 12 (payload) = 16 = 0x0010
      expect(result).toBe('0010hello world\n')
    })

    it('should zero-pad length to 4 digits', () => {
      const shortPayload = 'hi'
      const result = generatePktLine(shortPayload)

      // Length = 4 + 2 = 6 = 0x0006
      expect(result).toBe('0006hi')
      expect(result.slice(0, 4)).toBe('0006')
    })

    it('should generate flush packet', () => {
      const result = generateFlushPkt()
      expect(result).toBe('0000')
      expect(result).toBe(FLUSH_PKT)
    })

    it('should generate delimiter packet', () => {
      const result = generateDelimPkt()
      expect(result).toBe('0001')
      expect(result).toBe(DELIM_PKT)
    })

    it('should handle binary payload', () => {
      const binaryPayload = new Uint8Array([0x50, 0x41, 0x43, 0x4b]) // "PACK"
      const result = generatePktLine(binaryPayload)

      expect(result.slice(0, 4)).toBe('0008') // 4 + 4 = 8
      // Rest should be the binary data
    })

    it('should throw for payload exceeding max length', () => {
      const oversizedPayload = 'x'.repeat(65520)

      expect(() => generatePktLine(oversizedPayload)).toThrow(/exceeds maximum/i)
    })

    it('should use lowercase hex digits', () => {
      // Git protocol uses lowercase hex
      const payload = 'x'.repeat(250) // 250 + 4 = 254 = 0x00fe
      const result = generatePktLine(payload)

      expect(result.slice(0, 4)).toBe('00fe')
      expect(result.slice(0, 4)).not.toBe('00FE')
    })
  })
})

// =============================================================================
// REFS DISCOVERY TESTS
// =============================================================================

describe('Refs Discovery Parsing', () => {
  describe('service header', () => {
    it('should parse service header line', () => {
      const input = '001e# service=git-upload-pack\n'
      const result = parseServiceHeader(input)

      expect(result.service).toBe('git-upload-pack')
    })

    it('should handle git-receive-pack service', () => {
      const input = '001f# service=git-receive-pack\n'
      const result = parseServiceHeader(input)

      expect(result.service).toBe('git-receive-pack')
    })

    it('should throw for invalid service header', () => {
      const invalidInputs = [
        '0016# service=invalid\n',
        '0010# nothing\n',
        '0004',
      ]

      for (const input of invalidInputs) {
        expect(() => parseServiceHeader(input)).toThrow(/invalid service/i)
      }
    })
  })

  describe('ref parsing', () => {
    it('should extract HEAD ref with SHA', () => {
      // First line has capabilities after \0
      const input = [
        '00a0abc123def456789012345678901234567890 HEAD\0multi_ack thin-pack side-band\n',
        '003fabc123def456789012345678901234567890 refs/heads/main\n',
        '0000',
      ].join('')

      const result = parseRefs(input)

      expect(result.head).toBeDefined()
      expect(result.head!.sha).toBe('abc123def456789012345678901234567890')
      expect(result.head!.name).toBe('HEAD')
    })

    it('should extract all branch refs', () => {
      const mainSha = 'abc123def456789012345678901234567890'
      const devSha = 'def456789012345678901234567890abc123'
      const featureSha = '789012345678901234567890abc123def456'

      const input = [
        `003f${mainSha} HEAD\0capabilities\n`,
        `003f${mainSha} refs/heads/main\n`,
        `003f${devSha} refs/heads/develop\n`,
        `0045${featureSha} refs/heads/feature/new-thing\n`,
        '0000',
      ].join('')

      const result = parseRefs(input)

      expect(result.branches).toHaveLength(3)
      expect(result.branches).toContainEqual({
        sha: mainSha,
        name: 'refs/heads/main',
        shortName: 'main',
      })
      expect(result.branches).toContainEqual({
        sha: devSha,
        name: 'refs/heads/develop',
        shortName: 'develop',
      })
      expect(result.branches).toContainEqual({
        sha: featureSha,
        name: 'refs/heads/feature/new-thing',
        shortName: 'feature/new-thing',
      })
    })

    it('should extract tag refs', () => {
      const v1Sha = 'abc123def456789012345678901234567890'
      const v2Sha = 'def456789012345678901234567890abc123'
      // Annotated tags have a peeled ref with ^{}
      const v2PeeledSha = '111222333444555666777888999000aaabbb'

      const input = [
        `003f${v1Sha} HEAD\0capabilities\n`,
        `0036${v1Sha} refs/tags/v1.0.0\n`,
        `0036${v2Sha} refs/tags/v2.0.0\n`,
        `003b${v2PeeledSha} refs/tags/v2.0.0^{}\n`,
        '0000',
      ].join('')

      const result = parseRefs(input)

      expect(result.tags).toHaveLength(2)
      expect(result.tags).toContainEqual({
        sha: v1Sha,
        name: 'refs/tags/v1.0.0',
        shortName: 'v1.0.0',
        peeled: undefined,
      })
      expect(result.tags).toContainEqual({
        sha: v2Sha,
        name: 'refs/tags/v2.0.0',
        shortName: 'v2.0.0',
        peeled: v2PeeledSha,
      })
    })

    it('should parse capabilities from first ref line (after NUL byte)', () => {
      const sha = 'abc123def456789012345678901234567890'
      const input = [
        `005f${sha} HEAD\0multi_ack thin-pack side-band side-band-64k ofs-delta\n`,
        '0000',
      ].join('')

      const result = parseRefs(input)

      expect(result.capabilities).toBeDefined()
      expect(result.capabilities).toContain('multi_ack')
      expect(result.capabilities).toContain('thin-pack')
      expect(result.capabilities).toContain('side-band')
      expect(result.capabilities).toContain('side-band-64k')
      expect(result.capabilities).toContain('ofs-delta')
    })

    it('should handle symref capability', () => {
      const sha = 'abc123def456789012345678901234567890'
      const input = [
        `0066${sha} HEAD\0symref=HEAD:refs/heads/main multi_ack thin-pack\n`,
        '0000',
      ].join('')

      const result = parseRefs(input)

      expect(result.symrefs).toBeDefined()
      expect(result.symrefs!['HEAD']).toBe('refs/heads/main')
    })

    it('should handle multiple symrefs', () => {
      const sha = 'abc123def456789012345678901234567890'
      const input = [
        `0080${sha} HEAD\0symref=HEAD:refs/heads/main symref=refs/remotes/origin/HEAD:refs/remotes/origin/main\n`,
        '0000',
      ].join('')

      const result = parseRefs(input)

      expect(result.symrefs!['HEAD']).toBe('refs/heads/main')
      expect(result.symrefs!['refs/remotes/origin/HEAD']).toBe('refs/remotes/origin/main')
    })

    it('should handle empty repository (no refs)', () => {
      const input = [
        '0000', // Just a flush packet, no refs
      ].join('')

      const result = parseRefs(input)

      expect(result.head).toBeUndefined()
      expect(result.branches).toHaveLength(0)
      expect(result.tags).toHaveLength(0)
      expect(result.refs).toHaveLength(0)
    })

    it('should handle repository with only capabilities (empty repo with version)', () => {
      // Some servers send capabilities even for empty repos
      const input = [
        '0046\0version 2 multi_ack thin-pack side-band-64k\n',
        '0000',
      ].join('')

      const result = parseRefs(input)

      expect(result.head).toBeUndefined()
      expect(result.refs).toHaveLength(0)
      expect(result.capabilities).toContain('version 2')
    })

    it('should extract other refs (not branches or tags)', () => {
      const sha = 'abc123def456789012345678901234567890'
      const prSha = 'def456789012345678901234567890abc123'

      const input = [
        `003f${sha} HEAD\0capabilities\n`,
        `003f${sha} refs/heads/main\n`,
        `0045${prSha} refs/pull/123/head\n`,
        `0046${prSha} refs/pull/123/merge\n`,
        '0000',
      ].join('')

      const result = parseRefs(input)

      expect(result.refs).toContainEqual({
        sha: prSha,
        name: 'refs/pull/123/head',
      })
      expect(result.refs).toContainEqual({
        sha: prSha,
        name: 'refs/pull/123/merge',
      })
    })
  })
})

// =============================================================================
// CAPABILITIES TESTS
// =============================================================================

describe('Capabilities', () => {
  describe('parsing', () => {
    it('should parse space-separated capabilities', () => {
      const capString = 'multi_ack thin-pack side-band ofs-delta'
      const result = parseCapabilities(capString)

      expect(result.list).toContain('multi_ack')
      expect(result.list).toContain('thin-pack')
      expect(result.list).toContain('side-band')
      expect(result.list).toContain('ofs-delta')
    })

    it('should parse key=value capabilities', () => {
      const capString = 'symref=HEAD:refs/heads/main agent=git/2.40.0 object-format=sha1'
      const result = parseCapabilities(capString)

      expect(result.values['symref']).toBe('HEAD:refs/heads/main')
      expect(result.values['agent']).toBe('git/2.40.0')
      expect(result.values['object-format']).toBe('sha1')
    })

    it('should handle mixed capabilities', () => {
      const capString = 'multi_ack symref=HEAD:refs/heads/main thin-pack agent=git/2.40.0'
      const result = parseCapabilities(capString)

      expect(result.list).toContain('multi_ack')
      expect(result.list).toContain('thin-pack')
      expect(result.values['symref']).toBe('HEAD:refs/heads/main')
      expect(result.values['agent']).toBe('git/2.40.0')
    })

    it('should detect multi_ack capability', () => {
      const caps = parseCapabilities('multi_ack side-band')
      expect(hasCapability(caps, 'multi_ack')).toBe(true)
      expect(hasCapability(caps, 'multi_ack_detailed')).toBe(false)
    })

    it('should detect thin-pack capability', () => {
      const caps = parseCapabilities('thin-pack ofs-delta')
      expect(hasCapability(caps, 'thin-pack')).toBe(true)
    })

    it('should detect side-band-64k capability', () => {
      const caps = parseCapabilities('side-band side-band-64k')
      expect(hasCapability(caps, 'side-band')).toBe(true)
      expect(hasCapability(caps, 'side-band-64k')).toBe(true)
    })

    it('should detect ofs-delta capability', () => {
      const caps = parseCapabilities('ofs-delta no-progress')
      expect(hasCapability(caps, 'ofs-delta')).toBe(true)
    })

    it('should get capability value', () => {
      const caps = parseCapabilities('symref=HEAD:refs/heads/main agent=git/2.40.0')
      expect(getCapabilityValue(caps, 'symref')).toBe('HEAD:refs/heads/main')
      expect(getCapabilityValue(caps, 'agent')).toBe('git/2.40.0')
      expect(getCapabilityValue(caps, 'nonexistent')).toBeUndefined()
    })

    it('should handle empty capabilities string', () => {
      const result = parseCapabilities('')
      expect(result.list).toHaveLength(0)
      expect(Object.keys(result.values)).toHaveLength(0)
    })

    it('should handle multiple values for same key', () => {
      // Some capabilities like symref can appear multiple times
      const capString = 'symref=HEAD:refs/heads/main symref=refs/remotes/origin/HEAD:refs/remotes/origin/main'
      const result = parseCapabilities(capString)

      // Should store as array or last value, depending on implementation
      expect(result.multiValues?.['symref']).toContain('HEAD:refs/heads/main')
      expect(result.multiValues?.['symref']).toContain('refs/remotes/origin/HEAD:refs/remotes/origin/main')
    })
  })
})

// =============================================================================
// OBJECT NEGOTIATION TESTS
// =============================================================================

describe('Object Negotiation', () => {
  describe('want line generation', () => {
    it('should generate want line with capabilities (first want)', () => {
      const sha = 'abc123def456789012345678901234567890'
      const capabilities = ['multi_ack', 'thin-pack', 'side-band-64k', 'ofs-delta']

      const result = generateWantLine(sha, capabilities)

      expect(result).toContain(`want ${sha}`)
      expect(result).toContain('multi_ack')
      expect(result).toContain('thin-pack')
      expect(result).toContain('side-band-64k')
      expect(result).toContain('ofs-delta')
      expect(result).toMatch(/^[0-9a-f]{4}want /)
    })

    it('should generate want line without capabilities (subsequent wants)', () => {
      const sha = 'abc123def456789012345678901234567890'

      const result = generateWantLine(sha, [])

      // Format: "want <sha>\n" with pkt-line prefix
      expect(result).toBe(`0032want ${sha}\n`)
      expect(result).not.toContain('multi_ack')
    })

    it('should validate SHA format', () => {
      const invalidShas = [
        'short',                                     // too short
        'abc123def456789012345678901234567890xyz',  // too long
        'ghijklmnopqrstuvwxyz12345678901234567890', // invalid hex chars
      ]

      for (const sha of invalidShas) {
        expect(() => generateWantLine(sha, [])).toThrow(/invalid sha/i)
      }
    })
  })

  describe('have line generation', () => {
    it('should generate have line', () => {
      const sha = 'abc123def456789012345678901234567890'

      const result = generateHaveLine(sha)

      // Format: "have <sha>\n" with pkt-line prefix
      expect(result).toBe(`0032have ${sha}\n`)
    })

    it('should validate SHA format', () => {
      expect(() => generateHaveLine('invalid')).toThrow(/invalid sha/i)
    })
  })

  describe('done packet generation', () => {
    it('should generate done packet', () => {
      const result = generateDonePkt()

      // Format: "done\n" with pkt-line prefix
      expect(result).toBe('0009done\n')
    })
  })

  describe('fresh clone (no-have case)', () => {
    it('should handle negotiation with no local objects', () => {
      // When cloning, client has no objects, sends only wants
      const wantShas = [
        'abc123def456789012345678901234567890',
        'def456789012345678901234567890abc123',
      ]
      const capabilities = ['multi_ack', 'side-band-64k']

      // First want includes capabilities
      const firstWant = generateWantLine(wantShas[0], capabilities)
      expect(firstWant).toContain('multi_ack')

      // Subsequent wants don't include capabilities
      const secondWant = generateWantLine(wantShas[1], [])
      expect(secondWant).not.toContain('multi_ack')

      // Then just send done (no haves)
      const done = generateDonePkt()
      expect(done).toBe('0009done\n')
    })
  })

  describe('NAK response parsing', () => {
    it('should parse NAK response', () => {
      const input = '0008NAK\n'
      const result = parseNakResponse(input)

      expect(result.type).toBe('NAK')
    })

    it('should return null for non-NAK response', () => {
      const input = '0032ACK abc123def456789012345678901234567890\n'
      const result = parseNakResponse(input)

      expect(result).toBeNull()
    })
  })

  describe('ACK response parsing', () => {
    it('should parse simple ACK response', () => {
      const sha = 'abc123def456789012345678901234567890'
      const input = `0032ACK ${sha}\n`

      const result = parseAckResponse(input)

      expect(result.type).toBe('ACK')
      expect(result.sha).toBe(sha)
      expect(result.status).toBeUndefined()
    })

    it('should parse ACK continue response', () => {
      const sha = 'abc123def456789012345678901234567890'
      const input = `003bACK ${sha} continue\n`

      const result = parseAckResponse(input)

      expect(result.type).toBe('ACK')
      expect(result.sha).toBe(sha)
      expect(result.status).toBe('continue')
    })

    it('should parse ACK ready response', () => {
      const sha = 'abc123def456789012345678901234567890'
      const input = `0038ACK ${sha} ready\n`

      const result = parseAckResponse(input)

      expect(result.type).toBe('ACK')
      expect(result.sha).toBe(sha)
      expect(result.status).toBe('ready')
    })

    it('should parse ACK common response', () => {
      const sha = 'abc123def456789012345678901234567890'
      const input = `0039ACK ${sha} common\n`

      const result = parseAckResponse(input)

      expect(result.type).toBe('ACK')
      expect(result.sha).toBe(sha)
      expect(result.status).toBe('common')
    })

    it('should return null for non-ACK response', () => {
      const input = '0008NAK\n'
      const result = parseAckResponse(input)

      expect(result).toBeNull()
    })
  })

  describe('multi-round negotiation', () => {
    it('should track negotiation state through multiple rounds', () => {
      const state: NegotiationState = {
        commonAncestors: [],
        pendingHaves: [],
        isReady: false,
        isDone: false,
      }

      // Simulate receiving ACK continue
      const ack1: AckResponse = {
        type: 'ACK',
        sha: 'abc123def456789012345678901234567890',
        status: 'continue',
      }

      // After ACK continue, add to common ancestors
      state.commonAncestors.push(ack1.sha)
      expect(state.commonAncestors).toContain(ack1.sha)
      expect(state.isReady).toBe(false)

      // Simulate receiving ACK ready
      const ack2: AckResponse = {
        type: 'ACK',
        sha: 'def456789012345678901234567890abc123',
        status: 'ready',
      }

      state.commonAncestors.push(ack2.sha)
      state.isReady = true

      expect(state.isReady).toBe(true)
      expect(state.commonAncestors).toHaveLength(2)
    })
  })
})

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Protocol Integration', () => {
  it('should parse complete refs discovery response', () => {
    // Simulates a real response from git-upload-pack
    const response = [
      '001e# service=git-upload-pack\n',
      '0000',
      '00a0abc123def456789012345678901234567890 HEAD\0multi_ack thin-pack side-band side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=git/2.40.0\n',
      '003fabc123def456789012345678901234567890 refs/heads/main\n',
      '0040def456789012345678901234567890abc123 refs/heads/develop\n',
      '0036789012345678901234567890abc123def456 refs/tags/v1.0.0\n',
      '0000',
    ].join('')

    // Should parse service header
    const headerResult = parseServiceHeader(response)
    expect(headerResult.service).toBe('git-upload-pack')

    // Should parse refs after header flush
    const refsStart = response.indexOf('00a0')
    const refsResult = parseRefs(response.slice(refsStart))

    expect(refsResult.head).toBeDefined()
    expect(refsResult.branches).toHaveLength(2)
    expect(refsResult.tags).toHaveLength(1)
    expect(refsResult.capabilities).toContain('multi_ack')
    expect(refsResult.symrefs!['HEAD']).toBe('refs/heads/main')
  })

  it('should build complete negotiation request', () => {
    // Build a complete fetch negotiation request
    const wants = [
      'abc123def456789012345678901234567890',
      'def456789012345678901234567890abc123',
    ]
    const haves = [
      '111222333444555666777888999000aaabbb',
      '222333444555666777888999000aaabbbccc',
    ]
    const capabilities = ['multi_ack', 'side-band-64k', 'ofs-delta', 'thin-pack']

    const lines: string[] = []

    // First want with capabilities
    lines.push(generateWantLine(wants[0], capabilities))

    // Subsequent wants without capabilities
    for (let i = 1; i < wants.length; i++) {
      lines.push(generateWantLine(wants[i], []))
    }

    // Flush after wants
    lines.push(generateFlushPkt())

    // Haves
    for (const have of haves) {
      lines.push(generateHaveLine(have))
    }

    // Done
    lines.push(generateDonePkt())

    const request = lines.join('')

    // Verify structure
    expect(request).toContain('want abc123')
    expect(request).toContain('multi_ack')
    expect(request).toContain('0000') // flush
    expect(request).toContain('have 111222')
    expect(request).toContain('have 222333')
    expect(request).toContain('done')
  })
})

// =============================================================================
// EDGE CASES AND ERROR HANDLING
// =============================================================================

describe('Edge Cases', () => {
  describe('pkt-line edge cases', () => {
    it('should handle exactly max length payload', () => {
      const maxPayload = 'x'.repeat(65520 - 4) // Max total - header
      expect(() => generatePktLine(maxPayload)).not.toThrow()
    })

    it('should handle empty input to parsePktLines', () => {
      const result = parsePktLines('')
      expect(result).toHaveLength(0)
    })

    it('should handle trailing data after flush', () => {
      const input = '000bhello\n0000garbage'
      const results = parsePktLines(input)

      expect(results).toHaveLength(2)
      expect(results[0].payload).toBe('hello\n')
      expect(results[1].type).toBe('flush')
    })
  })

  describe('refs edge cases', () => {
    it('should handle refs with special characters', () => {
      const sha = 'abc123def456789012345678901234567890'
      const input = [
        `003f${sha} HEAD\0caps\n`,
        `004e${sha} refs/heads/feature/user@example.com.ai/test\n`,
        '0000',
      ].join('')

      const result = parseRefs(input)

      expect(result.branches).toContainEqual({
        sha,
        name: 'refs/heads/feature/user@example.com.ai/test',
        shortName: 'feature/user@example.com.ai/test',
      })
    })

    it('should handle SHA-256 refs (object-format=sha256)', () => {
      // SHA-256 hashes are 64 characters
      const sha256 = 'abc123def456789012345678901234567890abc123def456789012345678901234'
      const input = [
        `005f${sha256} HEAD\0object-format=sha256\n`,
        '0000',
      ].join('')

      const result = parseRefs(input)

      expect(result.head!.sha).toBe(sha256)
      expect(result.head!.sha).toHaveLength(64)
    })
  })

  describe('negotiation edge cases', () => {
    it('should handle empty capabilities list', () => {
      const sha = 'abc123def456789012345678901234567890'
      const result = generateWantLine(sha, [])

      expect(result).toBe(`0032want ${sha}\n`)
    })

    it('should handle very long capabilities list', () => {
      const sha = 'abc123def456789012345678901234567890'
      const capabilities = Array(50).fill(0).map((_, i) => `cap-${i}`)

      expect(() => generateWantLine(sha, capabilities)).not.toThrow()
    })
  })
})
