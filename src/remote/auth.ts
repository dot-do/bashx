/**
 * Git Authentication (Stub)
 *
 * This file is a stub for TDD RED phase.
 * Implementation will be added in GREEN phase.
 */

// Type exports
export type AuthMethod = 'bearer' | 'basic'

export interface AuthCredentials {
  method: AuthMethod
  token?: string
  username?: string
  password?: string
}

export interface RateLimitInfo {
  limit: number
  remaining: number
  resetAt: Date
}

export interface WwwAuthenticateInfo {
  scheme: string
  schemes?: string[]
  realm?: string
  error?: string
  errorDescription?: string
}

export type TokenType =
  | 'github-pat'
  | 'github-oauth'
  | 'github-app'
  | 'gitlab-pat'
  | 'gitlab-oauth'
  | 'bitbucket'
  | 'unknown'

// Function exports - stubs
export function createAuthHeader(credentials: AuthCredentials): string {
  throw new Error('Not implemented')
}

export function getTokenFromEnv(host: string, envVar?: string): string | undefined {
  throw new Error('Not implemented')
}

export function parseWwwAuthenticate(header: string): WwwAuthenticateInfo {
  throw new Error('Not implemented')
}

// Class export - stub
export class GitAuth {
  private static cache = new Map<string, { auth: GitAuth; expiresAt: number }>()

  constructor(options: { token?: string; username?: string; password?: string }) {
    throw new Error('Not implemented')
  }

  static fromEnv(host: string): GitAuth {
    throw new Error('Not implemented')
  }

  static getCached(host: string): GitAuth | undefined {
    throw new Error('Not implemented')
  }

  hasCredentials(): boolean {
    throw new Error('Not implemented')
  }

  getHeader(): string {
    throw new Error('Not implemented')
  }

  getTokenType(): TokenType {
    throw new Error('Not implemented')
  }

  cacheFor(host: string, ttlSeconds: number): void {
    throw new Error('Not implemented')
  }
}
