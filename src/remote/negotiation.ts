/**
 * Git Object Negotiation
 *
 * Implementation of the Git fetch/clone negotiation protocol.
 * See: https://git-scm.com/docs/pack-protocol#_packfile_negotiation
 *
 * STUB: This file exports types and functions that throw "not implemented"
 * for TDD RED phase.
 */

/** ACK response types */
export type AckStatus = 'continue' | 'ready' | 'common'

/** Parsed ACK response */
export interface AckResponse {
  type: 'ACK'
  sha: string
  status?: AckStatus
}

/** Parsed NAK response */
export interface NakResponse {
  type: 'NAK'
}

/** State for multi-round negotiation */
export interface NegotiationState {
  /** Common ancestors found so far */
  commonAncestors: string[]
  /** Haves that haven't been acknowledged */
  pendingHaves: string[]
  /** Server has enough info to send pack */
  isReady: boolean
  /** Negotiation is complete */
  isDone: boolean
}

/**
 * Generate a want line with optional capabilities (first want)
 */
export function generateWantLine(_sha: string, _capabilities: string[]): string {
  throw new Error('not implemented: generateWantLine')
}

/**
 * Generate a have line
 */
export function generateHaveLine(_sha: string): string {
  throw new Error('not implemented: generateHaveLine')
}

/**
 * Generate a done packet
 */
export function generateDonePkt(): string {
  throw new Error('not implemented: generateDonePkt')
}

/**
 * Parse a NAK response
 */
export function parseNakResponse(_input: string): NakResponse | null {
  throw new Error('not implemented: parseNakResponse')
}

/**
 * Parse an ACK response
 */
export function parseAckResponse(_input: string): AckResponse | null {
  throw new Error('not implemented: parseAckResponse')
}
