/**
 * OAuth.do Integration Tests (TDD RED Phase)
 *
 * Tests for oauth.do integration in bashx.do providing:
 * - Token extraction from Authorization header (Bearer token)
 * - Token extraction from Cookie
 * - JWT verification using verifyJWT() from oauth.do/server
 * - Session validation caching
 * - Permission scopes for bash: exec (run commands), admin (dangerous commands)
 * - Rejection of invalid/expired tokens
 * - Integration with BashModule and security policies
 *
 * oauth.do API Reference:
 * - extractToken(headers: Headers): string | null
 * - verifyJWT(token, { jwksUrl }): Promise<JWTVerifyResult>
 *
 * These tests are designed to FAIL initially (RED phase).
 * Implementation will make them pass (GREEN phase).
 *
 * @module bashx/tests/do/oauth
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BashResult } from '../../src/types.js'

// ============================================================================
// Mock Types (oauth.do interfaces we expect to integrate with)
// ============================================================================

/**
 * JWT verification result from oauth.do
 */
interface JWTVerifyResult {
  /** The decoded JWT payload */
  payload: JWTPayload
  /** Protected header from the JWT */
  protectedHeader: {
    alg: string
    typ?: string
    kid?: string
  }
}

/**
 * JWT payload structure for bashx.do tokens
 */
interface JWTPayload {
  /** Subject - typically user ID */
  sub: string
  /** Issuer */
  iss: string
  /** Audience */
  aud: string | string[]
  /** Expiration time (Unix timestamp) */
  exp: number
  /** Issued at time (Unix timestamp) */
  iat: number
  /** JWT ID (unique identifier) */
  jti?: string
  /** Session ID for session-based tokens */
  sid?: string
  /** Permission scopes granted to this token */
  scope?: string
  /** Custom claims for bashx-specific permissions */
  'bashx:permissions'?: BashPermissions
}

/**
 * Bashx-specific permission claims
 */
interface BashPermissions {
  /** Can execute standard commands */
  exec: boolean
  /** Can execute dangerous/admin commands */
  admin: boolean
  /** Allowed command patterns (glob) */
  allowedCommands?: string[]
  /** Blocked command patterns (glob) */
  blockedCommands?: string[]
  /** Allowed working directories */
  allowedPaths?: string[]
}

/**
 * OAuth configuration for BashModule
 */
interface OAuthConfig {
  /** JWKS URL for verifying JWT signatures */
  jwksUrl: string
  /** Expected issuer claim */
  issuer?: string
  /** Expected audience claim */
  audience?: string | string[]
  /** Cookie name for token extraction */
  cookieName?: string
  /** Enable session caching */
  enableCache?: boolean
  /** Cache TTL in seconds */
  cacheTtl?: number
}

/**
 * Session validation cache entry
 */
interface CachedSession {
  /** Validated JWT payload */
  payload: JWTPayload
  /** Cache timestamp */
  cachedAt: number
  /** Expiration timestamp */
  expiresAt: number
}

// ============================================================================
// Import statements for implementation (will fail until implemented)
// ============================================================================

// These imports will fail initially - that's expected for RED phase
// Once oauth integration is implemented, these will resolve
import {
  extractToken,
  verifyToken,
  OAuthMiddleware,
  createOAuthMiddleware,
  OAuthBashModule,
  withOAuth,
  SessionCache,
  type OAuthContext,
  type TokenExtractionResult,
} from '../../src/do/oauth.js'

// ============================================================================
// Token Extraction Tests
// ============================================================================

describe('Token Extraction', () => {
  describe('extractToken from Authorization header', () => {
    it('should extract Bearer token from Authorization header', () => {
      const headers = new Headers({
        Authorization: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      })

      const result = extractToken(headers)

      expect(result).not.toBeNull()
      expect(result?.token).toBe('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature')
      expect(result?.source).toBe('header')
    })

    it('should handle case-insensitive Bearer prefix', () => {
      const headers = new Headers({
        Authorization: 'bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      })

      const result = extractToken(headers)

      expect(result).not.toBeNull()
      expect(result?.token).toBe('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature')
    })

    it('should handle BEARER in uppercase', () => {
      const headers = new Headers({
        Authorization: 'BEARER eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      })

      const result = extractToken(headers)

      expect(result).not.toBeNull()
      expect(result?.token).toBeDefined()
    })

    it('should return null for missing Authorization header', () => {
      const headers = new Headers()

      const result = extractToken(headers)

      expect(result).toBeNull()
    })

    it('should return null for non-Bearer authorization schemes', () => {
      const headers = new Headers({
        Authorization: 'Basic dXNlcm5hbWU6cGFzc3dvcmQ=',
      })

      const result = extractToken(headers)

      expect(result).toBeNull()
    })

    it('should return null for malformed Bearer token', () => {
      const headers = new Headers({
        Authorization: 'Bearer ',
      })

      const result = extractToken(headers)

      expect(result).toBeNull()
    })

    it('should handle Bearer token with extra whitespace', () => {
      const headers = new Headers({
        Authorization: 'Bearer   eyJhbGciOiJSUzI1NiJ9.payload.sig  ',
      })

      const result = extractToken(headers)

      expect(result).not.toBeNull()
      expect(result?.token).toBe('eyJhbGciOiJSUzI1NiJ9.payload.sig')
    })
  })

  describe('extractToken from Cookie', () => {
    it('should extract token from default cookie name', () => {
      const headers = new Headers({
        Cookie: 'bashx_session=eyJhbGciOiJSUzI1NiJ9.payload.sig; other=value',
      })

      const result = extractToken(headers, { cookieName: 'bashx_session' })

      expect(result).not.toBeNull()
      expect(result?.token).toBe('eyJhbGciOiJSUzI1NiJ9.payload.sig')
      expect(result?.source).toBe('cookie')
    })

    it('should extract token from custom cookie name', () => {
      const headers = new Headers({
        Cookie: 'auth_token=eyJhbGciOiJSUzI1NiJ9.payload.sig',
      })

      const result = extractToken(headers, { cookieName: 'auth_token' })

      expect(result).not.toBeNull()
      expect(result?.token).toBe('eyJhbGciOiJSUzI1NiJ9.payload.sig')
    })

    it('should return null when cookie is not present', () => {
      const headers = new Headers({
        Cookie: 'other_cookie=value',
      })

      const result = extractToken(headers, { cookieName: 'bashx_session' })

      expect(result).toBeNull()
    })

    it('should handle URL-encoded cookie values', () => {
      const encodedToken = encodeURIComponent('eyJhbGciOiJSUzI1NiJ9.pay+load.sig')
      const headers = new Headers({
        Cookie: `bashx_session=${encodedToken}`,
      })

      const result = extractToken(headers, { cookieName: 'bashx_session' })

      expect(result).not.toBeNull()
      expect(result?.token).toBe('eyJhbGciOiJSUzI1NiJ9.pay+load.sig')
    })

    it('should prefer Authorization header over Cookie when both present', () => {
      const headers = new Headers({
        Authorization: 'Bearer header_token',
        Cookie: 'bashx_session=cookie_token',
      })

      const result = extractToken(headers, { cookieName: 'bashx_session' })

      expect(result).not.toBeNull()
      expect(result?.token).toBe('header_token')
      expect(result?.source).toBe('header')
    })
  })
})

// ============================================================================
// JWT Verification Tests
// ============================================================================

describe('JWT Verification', () => {
  const mockJwksUrl = 'https://oauth.do/.well-known/jwks.json'
  const validPayload: JWTPayload = {
    sub: 'user-123',
    iss: 'https://oauth.do',
    aud: 'bashx.do',
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    iat: Math.floor(Date.now() / 1000),
    jti: 'jwt-id-abc123',
    sid: 'session-xyz',
    scope: 'bash:exec bash:admin',
    'bashx:permissions': {
      exec: true,
      admin: true,
    },
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('verifyToken', () => {
    it('should verify a valid JWT token', async () => {
      // Mock the JWT verification
      const mockVerifyJWT = vi.fn().mockResolvedValue({
        payload: validPayload,
        protectedHeader: { alg: 'RS256', typ: 'JWT' },
      })

      const result = await verifyToken('valid.jwt.token', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
      })

      expect(result.valid).toBe(true)
      expect(result.payload).toEqual(validPayload)
      expect(mockVerifyJWT).toHaveBeenCalledWith('valid.jwt.token', { jwksUrl: mockJwksUrl })
    })

    it('should reject expired tokens', async () => {
      const expiredPayload: JWTPayload = {
        ...validPayload,
        exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
      }

      const mockVerifyJWT = vi.fn().mockResolvedValue({
        payload: expiredPayload,
        protectedHeader: { alg: 'RS256' },
      })

      const result = await verifyToken('expired.jwt.token', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('token_expired')
      expect(result.message).toContain('expired')
    })

    it('should reject tokens with invalid signature', async () => {
      const mockVerifyJWT = vi.fn().mockRejectedValue(new Error('signature verification failed'))

      const result = await verifyToken('invalid.signature.token', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('invalid_signature')
    })

    it('should reject tokens with wrong issuer', async () => {
      const wrongIssuerPayload: JWTPayload = {
        ...validPayload,
        iss: 'https://malicious.site',
      }

      const mockVerifyJWT = vi.fn().mockResolvedValue({
        payload: wrongIssuerPayload,
        protectedHeader: { alg: 'RS256' },
      })

      const result = await verifyToken('wrong.issuer.token', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
        issuer: 'https://oauth.do',
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('invalid_issuer')
    })

    it('should reject tokens with wrong audience', async () => {
      const wrongAudiencePayload: JWTPayload = {
        ...validPayload,
        aud: 'other-service',
      }

      const mockVerifyJWT = vi.fn().mockResolvedValue({
        payload: wrongAudiencePayload,
        protectedHeader: { alg: 'RS256' },
      })

      const result = await verifyToken('wrong.audience.token', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
        audience: 'bashx.do',
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('invalid_audience')
    })

    it('should accept tokens with array audience containing expected value', async () => {
      const arrayAudiencePayload: JWTPayload = {
        ...validPayload,
        aud: ['other-service', 'bashx.do', 'another-service'],
      }

      const mockVerifyJWT = vi.fn().mockResolvedValue({
        payload: arrayAudiencePayload,
        protectedHeader: { alg: 'RS256' },
      })

      const result = await verifyToken('array.audience.token', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
        audience: 'bashx.do',
      })

      expect(result.valid).toBe(true)
    })

    it('should handle JWKS fetch errors gracefully', async () => {
      const mockVerifyJWT = vi.fn().mockRejectedValue(new Error('Failed to fetch JWKS'))

      const result = await verifyToken('any.token', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('verification_failed')
    })

    it('should handle malformed JWT tokens', async () => {
      const mockVerifyJWT = vi.fn().mockRejectedValue(new Error('Invalid JWT format'))

      const result = await verifyToken('not-a-jwt', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('invalid_token')
    })
  })
})

// ============================================================================
// Session Validation Caching Tests
// ============================================================================

describe('Session Validation Caching', () => {
  let cache: SessionCache

  beforeEach(() => {
    cache = new SessionCache({ ttl: 300 }) // 5 minute TTL
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should cache validated sessions', async () => {
    const payload: JWTPayload = {
      sub: 'user-123',
      iss: 'https://oauth.do',
      aud: 'bashx.do',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }

    cache.set('token-abc', payload)

    const cached = cache.get('token-abc')

    expect(cached).not.toBeNull()
    expect(cached?.payload.sub).toBe('user-123')
  })

  it('should return null for uncached tokens', () => {
    const cached = cache.get('uncached-token')

    expect(cached).toBeNull()
  })

  it('should expire cached sessions after TTL', async () => {
    const payload: JWTPayload = {
      sub: 'user-123',
      iss: 'https://oauth.do',
      aud: 'bashx.do',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }

    cache.set('token-abc', payload)

    // Advance time past TTL
    vi.advanceTimersByTime(301 * 1000) // 301 seconds

    const cached = cache.get('token-abc')

    expect(cached).toBeNull()
  })

  it('should not return cached sessions after token expiration', async () => {
    const payload: JWTPayload = {
      sub: 'user-123',
      iss: 'https://oauth.do',
      aud: 'bashx.do',
      exp: Math.floor(Date.now() / 1000) + 60, // Expires in 1 minute
      iat: Math.floor(Date.now() / 1000),
    }

    cache.set('token-abc', payload)

    // Advance time past token expiration
    vi.advanceTimersByTime(61 * 1000) // 61 seconds

    const cached = cache.get('token-abc')

    expect(cached).toBeNull()
  })

  it('should invalidate specific session', () => {
    const payload: JWTPayload = {
      sub: 'user-123',
      iss: 'https://oauth.do',
      aud: 'bashx.do',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }

    cache.set('token-abc', payload)
    cache.invalidate('token-abc')

    const cached = cache.get('token-abc')

    expect(cached).toBeNull()
  })

  it('should invalidate all sessions for a user', () => {
    const payloadUser1: JWTPayload = {
      sub: 'user-123',
      iss: 'https://oauth.do',
      aud: 'bashx.do',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }

    const payloadUser2: JWTPayload = {
      sub: 'user-456',
      iss: 'https://oauth.do',
      aud: 'bashx.do',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }

    cache.set('token-1', payloadUser1)
    cache.set('token-2', payloadUser1)
    cache.set('token-3', payloadUser2)

    cache.invalidateUser('user-123')

    expect(cache.get('token-1')).toBeNull()
    expect(cache.get('token-2')).toBeNull()
    expect(cache.get('token-3')).not.toBeNull()
  })

  it('should clear all cached sessions', () => {
    const payload: JWTPayload = {
      sub: 'user-123',
      iss: 'https://oauth.do',
      aud: 'bashx.do',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }

    cache.set('token-1', payload)
    cache.set('token-2', payload)

    cache.clear()

    expect(cache.get('token-1')).toBeNull()
    expect(cache.get('token-2')).toBeNull()
  })

  it('should report cache statistics', () => {
    const payload: JWTPayload = {
      sub: 'user-123',
      iss: 'https://oauth.do',
      aud: 'bashx.do',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }

    cache.set('token-1', payload)
    cache.get('token-1') // hit
    cache.get('token-1') // hit
    cache.get('nonexistent') // miss

    const stats = cache.getStats()

    expect(stats.hits).toBe(2)
    expect(stats.misses).toBe(1)
    expect(stats.size).toBe(1)
  })
})

// ============================================================================
// Permission Scopes Tests
// ============================================================================

describe('Permission Scopes', () => {
  describe('bash:exec scope', () => {
    it('should allow standard command execution with bash:exec scope', async () => {
      const context: OAuthContext = {
        authenticated: true,
        userId: 'user-123',
        permissions: {
          exec: true,
          admin: false,
        },
        scopes: ['bash:exec'],
      }

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      const canExecute = middleware.checkPermission(context, 'exec', 'ls -la')

      expect(canExecute).toBe(true)
    })

    it('should allow safe commands without explicit scope', async () => {
      const context: OAuthContext = {
        authenticated: true,
        userId: 'user-123',
        permissions: {
          exec: true,
          admin: false,
        },
        scopes: ['bash:exec'],
      }

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      // Safe read-only commands
      expect(middleware.checkPermission(context, 'exec', 'pwd')).toBe(true)
      expect(middleware.checkPermission(context, 'exec', 'echo hello')).toBe(true)
      expect(middleware.checkPermission(context, 'exec', 'cat file.txt')).toBe(true)
    })

    it('should block dangerous commands without bash:admin scope', async () => {
      const context: OAuthContext = {
        authenticated: true,
        userId: 'user-123',
        permissions: {
          exec: true,
          admin: false,
        },
        scopes: ['bash:exec'],
      }

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      const canExecute = middleware.checkPermission(context, 'exec', 'rm -rf /')

      expect(canExecute).toBe(false)
    })
  })

  describe('bash:admin scope', () => {
    it('should allow dangerous commands with bash:admin scope', async () => {
      const context: OAuthContext = {
        authenticated: true,
        userId: 'user-123',
        permissions: {
          exec: true,
          admin: true,
        },
        scopes: ['bash:exec', 'bash:admin'],
      }

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      const canExecute = middleware.checkPermission(context, 'admin', 'rm -rf /tmp/old')

      expect(canExecute).toBe(true)
    })

    it('should allow elevated commands with bash:admin scope', async () => {
      const context: OAuthContext = {
        authenticated: true,
        userId: 'user-123',
        permissions: {
          exec: true,
          admin: true,
        },
        scopes: ['bash:admin'],
      }

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(middleware.checkPermission(context, 'admin', 'sudo apt update')).toBe(true)
      expect(middleware.checkPermission(context, 'admin', 'chmod 777 file')).toBe(true)
    })

    it('should require both exec and admin for destructive operations', async () => {
      const contextAdminOnly: OAuthContext = {
        authenticated: true,
        userId: 'user-123',
        permissions: {
          exec: false,
          admin: true,
        },
        scopes: ['bash:admin'],
      }

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      // Admin without exec should not be able to execute
      const canExecute = middleware.checkPermission(contextAdminOnly, 'exec', 'ls')

      expect(canExecute).toBe(false)
    })
  })

  describe('custom permission patterns', () => {
    it('should respect allowedCommands patterns', async () => {
      const context: OAuthContext = {
        authenticated: true,
        userId: 'user-123',
        permissions: {
          exec: true,
          admin: false,
          allowedCommands: ['git *', 'npm *', 'node *'],
        },
        scopes: ['bash:exec'],
      }

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(middleware.checkPermission(context, 'exec', 'git status')).toBe(true)
      expect(middleware.checkPermission(context, 'exec', 'npm install')).toBe(true)
      expect(middleware.checkPermission(context, 'exec', 'python script.py')).toBe(false)
    })

    it('should respect blockedCommands patterns', async () => {
      const context: OAuthContext = {
        authenticated: true,
        userId: 'user-123',
        permissions: {
          exec: true,
          admin: true,
          blockedCommands: ['curl *', 'wget *', 'nc *'],
        },
        scopes: ['bash:exec', 'bash:admin'],
      }

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(middleware.checkPermission(context, 'exec', 'curl https://api.example.com')).toBe(false)
      expect(middleware.checkPermission(context, 'exec', 'wget http://evil.com')).toBe(false)
      expect(middleware.checkPermission(context, 'exec', 'ls -la')).toBe(true)
    })

    it('should respect allowedPaths restrictions', async () => {
      const context: OAuthContext = {
        authenticated: true,
        userId: 'user-123',
        permissions: {
          exec: true,
          admin: false,
          allowedPaths: ['/home/user', '/tmp'],
        },
        scopes: ['bash:exec'],
      }

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(middleware.checkPermission(context, 'exec', 'cat /home/user/file.txt')).toBe(true)
      expect(middleware.checkPermission(context, 'exec', 'cat /etc/passwd')).toBe(false)
    })
  })
})

// ============================================================================
// Token Rejection Tests
// ============================================================================

describe('Invalid/Expired Token Rejection', () => {
  const mockJwksUrl = 'https://oauth.do/.well-known/jwks.json'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('expired tokens', () => {
    it('should reject tokens that expired in the past', async () => {
      const mockVerifyJWT = vi.fn().mockResolvedValue({
        payload: {
          sub: 'user-123',
          iss: 'https://oauth.do',
          aud: 'bashx.do',
          exp: Math.floor(Date.now() / 1000) - 1, // Expired 1 second ago
          iat: Math.floor(Date.now() / 1000) - 3600,
        },
        protectedHeader: { alg: 'RS256' },
      })

      const result = await verifyToken('expired.token', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('token_expired')
    })

    it('should reject tokens with exp equal to current time', async () => {
      const mockVerifyJWT = vi.fn().mockResolvedValue({
        payload: {
          sub: 'user-123',
          iss: 'https://oauth.do',
          aud: 'bashx.do',
          exp: Math.floor(Date.now() / 1000), // Exactly now
          iat: Math.floor(Date.now() / 1000) - 3600,
        },
        protectedHeader: { alg: 'RS256' },
      })

      const result = await verifyToken('exact.expiry.token', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('token_expired')
    })

    it('should allow small clock skew tolerance', async () => {
      const mockVerifyJWT = vi.fn().mockResolvedValue({
        payload: {
          sub: 'user-123',
          iss: 'https://oauth.do',
          aud: 'bashx.do',
          exp: Math.floor(Date.now() / 1000) - 30, // 30 seconds ago
          iat: Math.floor(Date.now() / 1000) - 3600,
        },
        protectedHeader: { alg: 'RS256' },
      })

      const result = await verifyToken('slight.skew.token', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
        clockTolerance: 60, // 60 second tolerance
      })

      expect(result.valid).toBe(true)
    })
  })

  describe('invalid tokens', () => {
    it('should reject tokens with invalid structure', async () => {
      const mockVerifyJWT = vi.fn().mockRejectedValue(new Error('Invalid token structure'))

      const result = await verifyToken('not.a.valid.jwt', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('invalid_token')
    })

    it('should reject tokens signed with wrong key', async () => {
      const mockVerifyJWT = vi.fn().mockRejectedValue(new Error('signature verification failed'))

      const result = await verifyToken('wrong.key.token', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('invalid_signature')
    })

    it('should reject tokens with unsupported algorithm', async () => {
      const mockVerifyJWT = vi.fn().mockRejectedValue(new Error('Unsupported algorithm: none'))

      const result = await verifyToken('none.alg.token', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('invalid_token')
    })

    it('should reject empty token string', async () => {
      const result = await verifyToken('', {
        jwksUrl: mockJwksUrl,
        verifyJWT: vi.fn(),
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('missing_token')
    })

    it('should reject null token', async () => {
      const result = await verifyToken(null as unknown as string, {
        jwksUrl: mockJwksUrl,
        verifyJWT: vi.fn(),
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('missing_token')
    })
  })

  describe('revoked tokens', () => {
    it('should reject tokens on the revocation list', async () => {
      const mockVerifyJWT = vi.fn().mockResolvedValue({
        payload: {
          sub: 'user-123',
          iss: 'https://oauth.do',
          aud: 'bashx.do',
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
          jti: 'revoked-jwt-id',
        },
        protectedHeader: { alg: 'RS256' },
      })

      const revokedTokens = new Set(['revoked-jwt-id'])

      const result = await verifyToken('revoked.token', {
        jwksUrl: mockJwksUrl,
        verifyJWT: mockVerifyJWT,
        isRevoked: (jti) => revokedTokens.has(jti),
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('token_revoked')
    })
  })
})

// ============================================================================
// OAuthMiddleware Tests
// ============================================================================

describe('OAuthMiddleware', () => {
  describe('createOAuthMiddleware', () => {
    it('should create middleware with default configuration', () => {
      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(middleware).toBeDefined()
      expect(typeof middleware.authenticate).toBe('function')
      expect(typeof middleware.checkPermission).toBe('function')
    })

    it('should create middleware with custom configuration', () => {
      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://custom.oauth/.well-known/jwks.json',
        issuer: 'https://custom.oauth',
        audience: 'my-app',
        cookieName: 'my_session',
        enableCache: true,
        cacheTtl: 600,
      })

      expect(middleware).toBeDefined()
    })
  })

  describe('authenticate', () => {
    it('should authenticate valid request with Bearer token', async () => {
      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      // Mock the internal verifyJWT
      const mockVerifyJWT = vi.fn().mockResolvedValue({
        payload: {
          sub: 'user-123',
          iss: 'https://oauth.do',
          aud: 'bashx.do',
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
          'bashx:permissions': { exec: true, admin: false },
        },
        protectedHeader: { alg: 'RS256' },
      })

      const request = new Request('https://bashx.do/exec', {
        headers: {
          Authorization: 'Bearer valid.jwt.token',
        },
      })

      const context = await middleware.authenticate(request, { verifyJWT: mockVerifyJWT })

      expect(context.authenticated).toBe(true)
      expect(context.userId).toBe('user-123')
      expect(context.permissions.exec).toBe(true)
    })

    it('should return unauthenticated context for missing token', async () => {
      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      const request = new Request('https://bashx.do/exec')

      const context = await middleware.authenticate(request)

      expect(context.authenticated).toBe(false)
      expect(context.error).toBe('missing_token')
    })

    it('should return unauthenticated context for invalid token', async () => {
      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      const mockVerifyJWT = vi.fn().mockRejectedValue(new Error('Invalid token'))

      const request = new Request('https://bashx.do/exec', {
        headers: {
          Authorization: 'Bearer invalid.token',
        },
      })

      const context = await middleware.authenticate(request, { verifyJWT: mockVerifyJWT })

      expect(context.authenticated).toBe(false)
      expect(context.error).toBeDefined()
    })

    it('should use cached session for repeated requests', async () => {
      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        enableCache: true,
        cacheTtl: 300,
      })

      const mockVerifyJWT = vi.fn().mockResolvedValue({
        payload: {
          sub: 'user-123',
          iss: 'https://oauth.do',
          aud: 'bashx.do',
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
        },
        protectedHeader: { alg: 'RS256' },
      })

      const request = new Request('https://bashx.do/exec', {
        headers: {
          Authorization: 'Bearer cached.jwt.token',
        },
      })

      // First request - should verify
      await middleware.authenticate(request, { verifyJWT: mockVerifyJWT })

      // Second request - should use cache
      await middleware.authenticate(request, { verifyJWT: mockVerifyJWT })

      expect(mockVerifyJWT).toHaveBeenCalledTimes(1)
    })
  })
})

// ============================================================================
// OAuthBashModule Integration Tests
// ============================================================================

describe('OAuthBashModule Integration', () => {
  // Helper to create mock executor
  function createMockExecutor(results: Record<string, Partial<BashResult>> = {}) {
    return {
      execute: vi.fn(async (command: string): Promise<BashResult> => {
        const baseResult: BashResult = {
          input: command,
          command,
          valid: true,
          generated: false,
          stdout: '',
          stderr: '',
          exitCode: 0,
          intent: { commands: [], reads: [], writes: [], deletes: [], network: false, elevated: false },
          classification: { type: 'read', impact: 'none', reversible: true, reason: 'Mock' },
        }

        if (results[command]) {
          return { ...baseResult, ...results[command] }
        }

        return { ...baseResult, stdout: `executed: ${command}` }
      }),
    }
  }

  describe('OAuthBashModule constructor', () => {
    it('should create module with OAuth configuration', () => {
      const executor = createMockExecutor()
      const module = new OAuthBashModule(executor, {
        oauth: {
          jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        },
      })

      expect(module).toBeDefined()
      expect(module.name).toBe('bash')
    })
  })

  describe('exec with authentication', () => {
    it('should reject execution without authentication', async () => {
      const executor = createMockExecutor()
      const module = new OAuthBashModule(executor, {
        oauth: {
          jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        },
      })

      const result = await module.exec('ls')

      expect(result.blocked).toBe(true)
      expect(result.blockReason).toContain('authentication')
    })

    it('should allow execution with valid authentication context', async () => {
      const executor = createMockExecutor({
        'ls -la': { stdout: 'file1.txt\nfile2.txt', exitCode: 0 },
      })

      const module = new OAuthBashModule(executor, {
        oauth: {
          jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        },
      })

      const context: OAuthContext = {
        authenticated: true,
        userId: 'user-123',
        permissions: { exec: true, admin: false },
        scopes: ['bash:exec'],
      }

      const result = await module.exec('ls', ['-la'], { authContext: context })

      expect(result.blocked).toBeUndefined()
      expect(result.stdout).toBe('file1.txt\nfile2.txt')
    })

    it('should block dangerous commands without admin scope', async () => {
      const executor = createMockExecutor()

      const module = new OAuthBashModule(executor, {
        oauth: {
          jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        },
      })

      const context: OAuthContext = {
        authenticated: true,
        userId: 'user-123',
        permissions: { exec: true, admin: false },
        scopes: ['bash:exec'],
      }

      const result = await module.exec('rm', ['-rf', '/tmp/old'], { authContext: context })

      expect(result.blocked).toBe(true)
      expect(result.blockReason).toContain('admin')
    })

    it('should allow dangerous commands with admin scope', async () => {
      const executor = createMockExecutor({
        'rm -rf /tmp/old': { stdout: '', exitCode: 0 },
      })

      const module = new OAuthBashModule(executor, {
        oauth: {
          jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        },
      })

      const context: OAuthContext = {
        authenticated: true,
        userId: 'user-123',
        permissions: { exec: true, admin: true },
        scopes: ['bash:exec', 'bash:admin'],
      }

      const result = await module.exec('rm', ['-rf', '/tmp/old'], {
        authContext: context,
        confirm: true,
      })

      expect(result.blocked).toBeUndefined()
      expect(result.exitCode).toBe(0)
    })
  })

  describe('exec with request-based authentication', () => {
    it('should extract and verify token from request headers', async () => {
      const executor = createMockExecutor({
        'ls': { stdout: 'files', exitCode: 0 },
      })

      const mockVerifyJWT = vi.fn().mockResolvedValue({
        payload: {
          sub: 'user-123',
          iss: 'https://oauth.do',
          aud: 'bashx.do',
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
          'bashx:permissions': { exec: true, admin: false },
        },
        protectedHeader: { alg: 'RS256' },
      })

      const module = new OAuthBashModule(executor, {
        oauth: {
          jwksUrl: 'https://oauth.do/.well-known/jwks.json',
          verifyJWT: mockVerifyJWT,
        },
      })

      const request = new Request('https://bashx.do/exec', {
        headers: {
          Authorization: 'Bearer valid.token',
        },
      })

      const result = await module.execWithRequest('ls', [], request)

      expect(result.blocked).toBeUndefined()
      expect(result.stdout).toBe('files')
    })
  })
})

// ============================================================================
// withOAuth Mixin Tests
// ============================================================================

describe('withOAuth mixin', () => {
  function createMockExecutor() {
    return {
      execute: vi.fn(async (command: string): Promise<BashResult> => ({
        input: command,
        command,
        valid: true,
        generated: false,
        stdout: `executed: ${command}`,
        stderr: '',
        exitCode: 0,
        intent: { commands: [], reads: [], writes: [], deletes: [], network: false, elevated: false },
        classification: { type: 'read', impact: 'none', reversible: true, reason: 'Mock' },
      })),
    }
  }

  it('should add OAuth-enabled bash to class', () => {
    class BaseClass {
      value = 'base'
    }

    const executor = createMockExecutor()
    const MixedClass = withOAuth(BaseClass, {
      executor: () => executor,
      oauth: {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      },
    })

    const instance = new MixedClass()

    expect(instance.value).toBe('base')
    expect(instance.bash).toBeDefined()
    expect(instance.bash).toBeInstanceOf(OAuthBashModule)
  })

  it('should provide authenticate method', async () => {
    class BaseClass {}

    const executor = createMockExecutor()
    const mockVerifyJWT = vi.fn().mockResolvedValue({
      payload: {
        sub: 'user-123',
        iss: 'https://oauth.do',
        aud: 'bashx.do',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      },
      protectedHeader: { alg: 'RS256' },
    })

    const MixedClass = withOAuth(BaseClass, {
      executor: () => executor,
      oauth: {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        verifyJWT: mockVerifyJWT,
      },
    })

    const instance = new MixedClass()

    const request = new Request('https://bashx.do', {
      headers: {
        Authorization: 'Bearer test.token',
      },
    })

    const context = await instance.bash.authenticate(request)

    expect(context.authenticated).toBe(true)
    expect(context.userId).toBe('user-123')
  })

  it('should support Durable Object fetch pattern', async () => {
    class MockDurableObject {
      state: { id: string }

      constructor(state: { id: string }) {
        this.state = state
      }
    }

    const executor = createMockExecutor()
    const MixedClass = withOAuth(MockDurableObject, {
      executor: () => executor,
      oauth: {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      },
    })

    const instance = new MixedClass({ id: 'test-do-id' })

    expect(instance.state.id).toBe('test-do-id')
    expect(instance.bash).toBeDefined()
  })
})

// ============================================================================
// Security Policy Integration Tests
// ============================================================================

describe('OAuth + Security Policy Integration', () => {
  function createMockExecutor(results: Record<string, Partial<BashResult>> = {}) {
    return {
      execute: vi.fn(async (command: string): Promise<BashResult> => {
        const baseResult: BashResult = {
          input: command,
          command,
          valid: true,
          generated: false,
          stdout: '',
          stderr: '',
          exitCode: 0,
          intent: { commands: [], reads: [], writes: [], deletes: [], network: false, elevated: false },
          classification: { type: 'read', impact: 'none', reversible: true, reason: 'Mock' },
        }

        if (results[command]) {
          return { ...baseResult, ...results[command] }
        }

        return { ...baseResult, stdout: `executed: ${command}` }
      }),
    }
  }

  it('should apply both OAuth and SecurityPolicy checks', async () => {
    const executor = createMockExecutor()

    const module = new OAuthBashModule(executor, {
      oauth: {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      },
    })

    const context: OAuthContext = {
      authenticated: true,
      userId: 'user-123',
      permissions: { exec: true, admin: false },
      scopes: ['bash:exec'],
    }

    // Command injection should be blocked by SecurityPolicy
    const result = await module.exec('echo', ['$(cat /etc/passwd)'], { authContext: context })

    expect(result.blocked).toBe(true)
    // Could be blocked by either OAuth permissions or SecurityPolicy
  })

  it('should block path traversal attempts even with admin scope', async () => {
    const executor = createMockExecutor()

    const module = new OAuthBashModule(executor, {
      oauth: {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      },
    })

    const context: OAuthContext = {
      authenticated: true,
      userId: 'user-123',
      permissions: { exec: true, admin: true },
      scopes: ['bash:exec', 'bash:admin'],
    }

    // Path traversal should still be blocked
    const result = await module.exec('cat', ['../../../etc/passwd'], { authContext: context })

    expect(result.blocked).toBe(true)
    expect(result.blockReason).toContain('security')
  })

  it('should audit OAuth-blocked commands', async () => {
    const auditLog: Array<{ userId: string; command: string; blocked: boolean; reason: string }> = []

    const executor = createMockExecutor()

    const module = new OAuthBashModule(executor, {
      oauth: {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        onAudit: (entry) => auditLog.push(entry),
      },
    })

    const context: OAuthContext = {
      authenticated: true,
      userId: 'user-123',
      permissions: { exec: true, admin: false },
      scopes: ['bash:exec'],
    }

    await module.exec('rm', ['-rf', '/'], { authContext: context })

    expect(auditLog.length).toBe(1)
    expect(auditLog[0].userId).toBe('user-123')
    expect(auditLog[0].blocked).toBe(true)
  })
})

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('OAuth Error Handling', () => {
  it('should handle JWKS fetch failures gracefully', async () => {
    const middleware = createOAuthMiddleware({
      jwksUrl: 'https://unreachable.oauth/.well-known/jwks.json',
    })

    const mockVerifyJWT = vi.fn().mockRejectedValue(new Error('Network error: JWKS fetch failed'))

    const request = new Request('https://bashx.do/exec', {
      headers: {
        Authorization: 'Bearer some.token',
      },
    })

    const context = await middleware.authenticate(request, { verifyJWT: mockVerifyJWT })

    expect(context.authenticated).toBe(false)
    expect(context.error).toBeDefined()
  })

  it('should handle malformed JWT gracefully', async () => {
    const middleware = createOAuthMiddleware({
      jwksUrl: 'https://oauth.do/.well-known/jwks.json',
    })

    const mockVerifyJWT = vi.fn().mockRejectedValue(new Error('Invalid JWT'))

    const request = new Request('https://bashx.do/exec', {
      headers: {
        Authorization: 'Bearer not-a-valid-jwt-at-all',
      },
    })

    const context = await middleware.authenticate(request, { verifyJWT: mockVerifyJWT })

    expect(context.authenticated).toBe(false)
    expect(context.error).toBe('invalid_token')
  })

  it('should provide helpful error messages for common issues', async () => {
    const result = await verifyToken('expired.token', {
      jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      verifyJWT: vi.fn().mockResolvedValue({
        payload: {
          sub: 'user-123',
          iss: 'https://oauth.do',
          aud: 'bashx.do',
          exp: 0, // Long expired
          iat: 0,
        },
        protectedHeader: { alg: 'RS256' },
      }),
    })

    expect(result.valid).toBe(false)
    expect(result.message).toMatch(/expired|Token has expired/i)
  })
})
