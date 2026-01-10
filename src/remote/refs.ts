/**
 * Git Refs Discovery
 *
 * Parsing of refs advertisement from git-upload-pack and git-receive-pack.
 * See: https://git-scm.com/docs/protocol-v2#_ref_advertisement
 *
 * STUB: This file exports types and functions that throw "not implemented"
 * for TDD RED phase.
 */

/** Information about a single ref */
export interface RefInfo {
  /** SHA-1 or SHA-256 hash */
  sha: string
  /** Full ref name (e.g., refs/heads/main) */
  name: string
  /** Short name (e.g., main) */
  shortName?: string
  /** Peeled commit SHA for annotated tags */
  peeled?: string
}

/** Complete refs response from server */
export interface RefsResponse {
  /** HEAD ref info */
  head?: RefInfo
  /** Branch refs */
  branches: RefInfo[]
  /** Tag refs */
  tags: RefInfo[]
  /** All other refs (pull requests, notes, etc.) */
  refs: RefInfo[]
  /** Raw capabilities string list */
  capabilities: string[]
  /** Parsed symref mappings */
  symrefs?: Record<string, string>
}

/** Service header parsing result */
export interface ServiceHeaderResult {
  /** Service name (git-upload-pack or git-receive-pack) */
  service: string
}

/**
 * Parse the service header line (# service=git-upload-pack)
 */
export function parseServiceHeader(_input: string): ServiceHeaderResult {
  throw new Error('not implemented: parseServiceHeader')
}

/**
 * Parse refs from refs advertisement
 */
export function parseRefs(_input: string): RefsResponse {
  throw new Error('not implemented: parseRefs')
}

/**
 * Extract capabilities from first ref line
 */
export function extractCapabilities(_line: string): string[] {
  throw new Error('not implemented: extractCapabilities')
}
