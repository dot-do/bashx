/**
 * Git HTTP Transport Client (Stub)
 *
 * This file is a stub for TDD RED phase.
 * Implementation will be added in GREEN phase.
 */

// Type exports
export interface RefAdvertisement {
  name: string
  oid: string
  peeled?: string
}

export interface ServerCapabilities {
  multiAck?: boolean
  thinPack?: boolean
  sideBand?: boolean
  sideBand64k?: boolean
  ofsDelta?: boolean
  shallow?: boolean
  deepenSince?: boolean
  deepenNot?: boolean
  deepenRelative?: boolean
  noProgress?: boolean
  includeTag?: boolean
  multiAckDetailed?: boolean
  symrefs?: Record<string, string>
  agent?: string
}

export interface RefsDiscoveryResult {
  refs: RefAdvertisement[]
  capabilities: ServerCapabilities
  isSmartServer: boolean
  isEmpty?: boolean
  head?: string
}

export interface UploadPackRequest {
  wants: string[]
  haves: string[]
  done?: boolean
  capabilities?: string[]
  depth?: number
  deepenSince?: Date
}

export interface UploadPackResponse {
  packfile: Uint8Array
  progress?: string
}

export interface RefUpdate {
  ref: string
  oldOid: string
  newOid: string
}

export interface RefUpdateResult {
  ref: string
  ok: boolean
  error?: string
}

export interface ReceivePackRequest {
  updates: RefUpdate[]
  packfile?: Uint8Array
  capabilities?: string[]
}

export interface ReceivePackResponse {
  unpackOk: boolean
  unpackError?: string
  results: RefUpdateResult[]
}

export interface GitHttpClientOptions {
  timeout?: number
  userAgent?: string
  auth?: import('./auth.js').AuthCredentials
  authProvider?: () => Promise<import('./auth.js').AuthCredentials>
}

// Main class - stub implementation
export class GitHttpClient {
  httpsUrl: string
  repoPath: string

  constructor(url: string, options?: GitHttpClientOptions) {
    // Stub: convert various URL formats to HTTPS
    this.httpsUrl = url
    this.repoPath = ''
    throw new Error('Not implemented')
  }

  async discoverRefs(service: 'upload-pack' | 'receive-pack'): Promise<RefsDiscoveryResult> {
    throw new Error('Not implemented')
  }

  async uploadPack(request: UploadPackRequest): Promise<UploadPackResponse> {
    throw new Error('Not implemented')
  }

  async receivePack(request: ReceivePackRequest): Promise<ReceivePackResponse> {
    throw new Error('Not implemented')
  }
}
