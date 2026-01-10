/**
 * Git pkt-line Format
 *
 * Implementation of the Git protocol pkt-line format for framing data.
 * See: https://git-scm.com/docs/protocol-common#_pkt_line_format
 *
 * STUB: This file exports types and functions that throw "not implemented"
 * for TDD RED phase.
 */

/** Maximum pkt-line length (65520 bytes per Git spec) */
export const PKT_LINE_MAX_LENGTH = 65520

/** Flush packet constant */
export const FLUSH_PKT = '0000'

/** Delimiter packet constant (protocol v2) */
export const DELIM_PKT = '0001'

/** Result of parsing a single pkt-line */
export interface PktLineResult {
  /** Total length including the 4-byte header */
  length: number
  /** Payload content (null for flush/delimiter packets) */
  payload: string | Uint8Array | null
  /** Packet type */
  type: 'data' | 'flush' | 'delimiter'
  /** Remaining data after this packet */
  remainder: string
}

/**
 * Parse a single pkt-line from input
 */
export function parsePktLine(_input: string | Buffer): PktLineResult {
  throw new Error('not implemented: parsePktLine')
}

/**
 * Parse multiple consecutive pkt-lines
 */
export function parsePktLines(_input: string): PktLineResult[] {
  throw new Error('not implemented: parsePktLines')
}

/**
 * Generate a pkt-line with correct length prefix
 */
export function generatePktLine(_payload: string | Uint8Array): string {
  throw new Error('not implemented: generatePktLine')
}

/**
 * Generate a flush packet
 */
export function generateFlushPkt(): string {
  throw new Error('not implemented: generateFlushPkt')
}

/**
 * Generate a delimiter packet
 */
export function generateDelimPkt(): string {
  throw new Error('not implemented: generateDelimPkt')
}
