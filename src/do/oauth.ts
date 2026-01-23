/**
 * OAuth.do Integration Module
 *
 * Provides OAuth integration for bashx.do with:
 * - Token extraction from Authorization header (Bearer token)
 * - Token extraction from Cookie
 * - JWT verification using verifyJWT() from oauth.do/server
 * - Session validation caching
 * - Permission scopes for bash: exec (run commands), admin (dangerous commands)
 * - Rejection of invalid/expired tokens
 * - Integration with BashModule and security policies
 *
 * @module bashx/do/oauth
 */

import { BashModule, type BashExecutor, type BashModuleOptions } from './index.js'
import type { BashResult, ExecOptions, FsCapability } from '../types.js'
import { createSecurityPolicy, type SecurityPolicy, type ValidationResult as SecurityValidationResult } from './security/security-policy.js'

// ============================================================================
// TYPES
// ============================================================================

/**
 * JWT verification result from oauth.do
 */
export interface JWTVerifyResult {
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
export interface JWTPayload {
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
export interface BashPermissions {
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
 * Result of token extraction
 */
export interface TokenExtractionResult {
  /** The extracted token */
  token: string
  /** Source of the token (header or cookie) */
  source: 'header' | 'cookie'
}

/**
 * Options for token extraction
 */
export interface TokenExtractionOptions {
  /** Cookie name for token extraction */
  cookieName?: string
}

/**
 * Options for token verification
 */
export interface VerifyTokenOptions {
  /** JWKS URL for verifying JWT signatures */
  jwksUrl: string
  /** The verifyJWT function from oauth.do/server */
  verifyJWT: (token: string, options: { jwksUrl: string }) => Promise<JWTVerifyResult>
  /** Expected issuer claim */
  issuer?: string
  /** Expected audience claim */
  audience?: string | string[]
  /** Clock tolerance in seconds for expiration checks */
  clockTolerance?: number
  /** Function to check if a token is revoked */
  isRevoked?: (jti: string) => boolean
}

/**
 * Result of token verification
 */
export interface TokenVerificationResult {
  /** Whether the token is valid */
  valid: boolean
  /** The decoded payload if valid */
  payload?: JWTPayload
  /** Error code if invalid */
  error?: 'missing_token' | 'token_expired' | 'invalid_signature' | 'invalid_issuer' | 'invalid_audience' | 'verification_failed' | 'invalid_token' | 'token_revoked'
  /** Human-readable error message */
  message?: string
}

/**
 * OAuth authentication context
 */
export interface OAuthContext {
  /** Whether the user is authenticated */
  authenticated: boolean
  /** User ID from the token subject */
  userId?: string
  /** Permissions from the token */
  permissions: BashPermissions
  /** Scopes from the token */
  scopes: string[]
  /** Error if authentication failed */
  error?: string
}

/**
 * OAuth configuration for BashModule
 */
export interface OAuthConfig {
  /** JWKS URL for verifying JWT signatures */
  jwksUrl: string
  /** The verifyJWT function from oauth.do/server */
  verifyJWT?: (token: string, options: { jwksUrl: string }) => Promise<JWTVerifyResult>
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
  /** Audit callback for logging blocked commands */
  onAudit?: (entry: { userId: string; command: string; blocked: boolean; reason: string }) => void
}

/**
 * Session validation cache entry
 */
export interface CachedSession {
  /** Validated JWT payload */
  payload: JWTPayload
  /** Cache timestamp */
  cachedAt: number
  /** Expiration timestamp */
  expiresAt: number
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Number of cache hits */
  hits: number
  /** Number of cache misses */
  misses: number
  /** Current cache size */
  size: number
}

/**
 * Options for OAuthBashModule exec
 */
export interface OAuthExecOptions extends ExecOptions {
  /** Authentication context */
  authContext?: OAuthContext
}

// ============================================================================
// DANGEROUS COMMANDS LIST
// ============================================================================

/**
 * Commands that require admin scope
 */
const DANGEROUS_COMMAND_PATTERNS = [
  /^rm\s+(-[^\s]*\s+)*-[^\s]*r/i,  // rm with -r flag
  /^sudo\b/i,
  /^chmod\b/i,
  /^chown\b/i,
  /^chgrp\b/i,
  /^mkfs\b/i,
  /^dd\b/i,
  /^fdisk\b/i,
  /^mount\b/i,
  /^umount\b/i,
  /^kill\b/i,
  /^killall\b/i,
  /^pkill\b/i,
  /^reboot\b/i,
  /^shutdown\b/i,
  /^halt\b/i,
  /^poweroff\b/i,
  /^init\b/i,
  /^systemctl\b/i,
  /^service\b/i,
  /^iptables\b/i,
  /^ip6tables\b/i,
  /^nft\b/i,
  /^useradd\b/i,
  /^userdel\b/i,
  /^usermod\b/i,
  /^groupadd\b/i,
  /^groupdel\b/i,
  /^groupmod\b/i,
  /^passwd\b/i,
]

/**
 * Check if a command is dangerous and requires admin scope
 */
function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some(pattern => pattern.test(command))
}

/**
 * Check if a command matches a glob pattern
 */
function matchesGlobPattern(command: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regex = new RegExp(
    '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars
      .replace(/\*/g, '.*')  // * matches anything
      .replace(/\?/g, '.')   // ? matches single char
    + '$'
  )
  return regex.test(command)
}

/**
 * Check if a path is within allowed paths
 */
function isPathAllowed(commandPath: string, allowedPaths: string[]): boolean {
  return allowedPaths.some(allowed =>
    commandPath.startsWith(allowed) || commandPath === allowed
  )
}

/**
 * Extract path from a command argument
 */
function extractPathFromCommand(command: string): string | null {
  // Match common patterns like: cat /path/to/file, echo something > /path/to/file
  const pathMatch = command.match(/(?:cat|head|tail|less|more|vim|vi|nano|edit)\s+([^\s]+)/i) ||
                   command.match(/(?:>|>>)\s*([^\s]+)/i) ||
                   command.match(/([^\s]+)/g)

  if (pathMatch) {
    // Find the first absolute path in the matches
    const matches = command.match(/\/[^\s]+/g)
    if (matches && matches.length > 0) {
      return matches[0]
    }
  }
  return null
}

// ============================================================================
// TOKEN EXTRACTION
// ============================================================================

/**
 * Extract a token from request headers.
 *
 * Checks Authorization header first (Bearer token), then falls back to cookie.
 * Returns null if no token is found.
 *
 * @param headers - The request headers
 * @param options - Extraction options
 * @returns The extracted token and source, or null
 *
 * @example
 * ```typescript
 * const headers = new Headers({ Authorization: 'Bearer eyJ...' })
 * const result = extractToken(headers)
 * // { token: 'eyJ...', source: 'header' }
 * ```
 */
export function extractToken(
  headers: Headers,
  options?: TokenExtractionOptions
): TokenExtractionResult | null {
  // Try Authorization header first
  const authHeader = headers.get('Authorization')
  if (authHeader) {
    const match = authHeader.match(/^bearer\s+(.+)$/i)
    if (match) {
      const token = match[1].trim()
      if (token) {
        return { token, source: 'header' }
      }
    }
    // Non-Bearer scheme or empty token - return null
    return null
  }

  // Try cookie if cookieName is provided
  if (options?.cookieName) {
    const cookieHeader = headers.get('Cookie')
    if (cookieHeader) {
      const cookies = parseCookies(cookieHeader)
      const cookieValue = cookies[options.cookieName]
      if (cookieValue) {
        // Decode URL-encoded cookie values
        try {
          const decodedToken = decodeURIComponent(cookieValue)
          return { token: decodedToken, source: 'cookie' }
        } catch {
          return { token: cookieValue, source: 'cookie' }
        }
      }
    }
  }

  return null
}

/**
 * Parse a cookie header into key-value pairs
 */
function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {}
  const pairs = cookieHeader.split(';')

  for (const pair of pairs) {
    const [name, ...valueParts] = pair.trim().split('=')
    if (name) {
      cookies[name.trim()] = valueParts.join('=').trim()
    }
  }

  return cookies
}

// ============================================================================
// TOKEN VERIFICATION
// ============================================================================

/**
 * Verify a JWT token using oauth.do's verifyJWT function.
 *
 * @param token - The JWT token to verify
 * @param options - Verification options
 * @returns The verification result
 *
 * @example
 * ```typescript
 * const result = await verifyToken('eyJ...', {
 *   jwksUrl: 'https://oauth.do/.well-known/jwks.json',
 *   verifyJWT: verifyJWT,
 * })
 * if (result.valid) {
 *   console.log('User:', result.payload.sub)
 * }
 * ```
 */
export async function verifyToken(
  token: string | null | undefined,
  options: VerifyTokenOptions
): Promise<TokenVerificationResult> {
  // Check for missing token
  if (!token || token === '') {
    return {
      valid: false,
      error: 'missing_token',
      message: 'No token provided',
    }
  }

  try {
    // Verify the token signature and decode
    const result = await options.verifyJWT(token, { jwksUrl: options.jwksUrl })
    const payload = result.payload

    // Check expiration with clock tolerance
    const now = Math.floor(Date.now() / 1000)
    const tolerance = options.clockTolerance ?? 0
    if (payload.exp <= now - tolerance) {
      return {
        valid: false,
        error: 'token_expired',
        message: 'Token has expired',
      }
    }

    // Check issuer if specified
    if (options.issuer && payload.iss !== options.issuer) {
      return {
        valid: false,
        error: 'invalid_issuer',
        message: `Invalid issuer: expected ${options.issuer}, got ${payload.iss}`,
      }
    }

    // Check audience if specified
    if (options.audience) {
      const tokenAud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
      const expectedAud = Array.isArray(options.audience) ? options.audience : [options.audience]
      const hasValidAudience = expectedAud.some(aud => tokenAud.includes(aud))

      if (!hasValidAudience) {
        return {
          valid: false,
          error: 'invalid_audience',
          message: `Invalid audience: expected one of ${expectedAud.join(', ')}, got ${tokenAud.join(', ')}`,
        }
      }
    }

    // Check revocation
    if (options.isRevoked && payload.jti && options.isRevoked(payload.jti)) {
      return {
        valid: false,
        error: 'token_revoked',
        message: 'Token has been revoked',
      }
    }

    return {
      valid: true,
      payload,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    // Classify the error
    if (message.toLowerCase().includes('signature')) {
      return {
        valid: false,
        error: 'invalid_signature',
        message: 'Invalid token signature',
      }
    }

    if (message.toLowerCase().includes('jwks') || message.toLowerCase().includes('fetch')) {
      return {
        valid: false,
        error: 'verification_failed',
        message: 'Failed to verify token: ' + message,
      }
    }

    return {
      valid: false,
      error: 'invalid_token',
      message: 'Invalid token: ' + message,
    }
  }
}

// ============================================================================
// SESSION CACHE
// ============================================================================

/**
 * Session cache for storing validated JWT payloads.
 *
 * Reduces verification overhead by caching validated sessions for a configurable TTL.
 * Automatically expires entries based on both cache TTL and token expiration.
 *
 * @example
 * ```typescript
 * const cache = new SessionCache({ ttl: 300 })
 * cache.set('token-abc', payload)
 *
 * const cached = cache.get('token-abc')
 * if (cached) {
 *   // Use cached session
 * }
 * ```
 */
export class SessionCache {
  private cache: Map<string, CachedSession> = new Map()
  private ttl: number
  private hits = 0
  private misses = 0

  /**
   * Create a new session cache.
   * @param options - Cache options
   */
  constructor(options: { ttl: number }) {
    this.ttl = options.ttl
  }

  /**
   * Store a validated session in the cache.
   * @param tokenKey - Unique key for the token (usually the token itself or a hash)
   * @param payload - The validated JWT payload
   */
  set(tokenKey: string, payload: JWTPayload): void {
    const now = Date.now()
    this.cache.set(tokenKey, {
      payload,
      cachedAt: now,
      expiresAt: now + this.ttl * 1000,
    })
  }

  /**
   * Get a cached session.
   * @param tokenKey - The token key
   * @returns The cached session or null if not found/expired
   */
  get(tokenKey: string): CachedSession | null {
    const entry = this.cache.get(tokenKey)
    if (!entry) {
      this.misses++
      return null
    }

    const now = Date.now()

    // Check cache expiration
    if (now >= entry.expiresAt) {
      this.cache.delete(tokenKey)
      this.misses++
      return null
    }

    // Check token expiration (payload.exp is in seconds)
    if (entry.payload.exp * 1000 <= now) {
      this.cache.delete(tokenKey)
      this.misses++
      return null
    }

    this.hits++
    return entry
  }

  /**
   * Invalidate a specific session.
   * @param tokenKey - The token key to invalidate
   */
  invalidate(tokenKey: string): void {
    this.cache.delete(tokenKey)
  }

  /**
   * Invalidate all sessions for a specific user.
   * @param userId - The user ID (sub claim)
   */
  invalidateUser(userId: string): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.payload.sub === userId) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * Clear all cached sessions.
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Get cache statistics.
   * @returns Cache hit/miss statistics
   */
  getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
    }
  }
}

// ============================================================================
// OAUTH MIDDLEWARE
// ============================================================================

/**
 * OAuth middleware for authenticating requests and checking permissions.
 */
export interface OAuthMiddleware {
  /**
   * Authenticate a request and return the auth context.
   * @param request - The incoming request
   * @param options - Optional verification options
   * @returns The authentication context
   */
  authenticate(
    request: Request,
    options?: { verifyJWT?: VerifyTokenOptions['verifyJWT'] }
  ): Promise<OAuthContext>

  /**
   * Check if a permission is granted for a command.
   * @param context - The authentication context
   * @param permission - The permission to check ('exec' or 'admin')
   * @param command - The command being executed
   * @returns Whether the permission is granted
   */
  checkPermission(context: OAuthContext, permission: 'exec' | 'admin', command: string): boolean
}

/**
 * Create an OAuth middleware instance.
 *
 * @param config - OAuth configuration
 * @returns The middleware instance
 *
 * @example
 * ```typescript
 * const middleware = createOAuthMiddleware({
 *   jwksUrl: 'https://oauth.do/.well-known/jwks.json',
 * })
 *
 * const context = await middleware.authenticate(request)
 * if (context.authenticated) {
 *   const canExec = middleware.checkPermission(context, 'exec', 'ls -la')
 * }
 * ```
 */
export function createOAuthMiddleware(config: OAuthConfig): OAuthMiddleware {
  const cache = config.enableCache !== false ? new SessionCache({ ttl: config.cacheTtl ?? 300 }) : null

  async function authenticate(
    request: Request,
    options?: { verifyJWT?: VerifyTokenOptions['verifyJWT'] }
  ): Promise<OAuthContext> {
    // Extract token from request
    const tokenResult = extractToken(request.headers, { cookieName: config.cookieName })

    if (!tokenResult) {
      return {
        authenticated: false,
        permissions: { exec: false, admin: false },
        scopes: [],
        error: 'missing_token',
      }
    }

    // Check cache first
    if (cache) {
      const cached = cache.get(tokenResult.token)
      if (cached) {
        return payloadToContext(cached.payload)
      }
    }

    // Verify token
    const verifyJWT = options?.verifyJWT || config.verifyJWT
    if (!verifyJWT) {
      return {
        authenticated: false,
        permissions: { exec: false, admin: false },
        scopes: [],
        error: 'verification_failed',
      }
    }

    const verifyResult = await verifyToken(tokenResult.token, {
      jwksUrl: config.jwksUrl,
      verifyJWT,
      issuer: config.issuer,
      audience: config.audience,
    })

    if (!verifyResult.valid || !verifyResult.payload) {
      return {
        authenticated: false,
        permissions: { exec: false, admin: false },
        scopes: [],
        error: verifyResult.error,
      }
    }

    // Cache the validated session
    if (cache) {
      cache.set(tokenResult.token, verifyResult.payload)
    }

    return payloadToContext(verifyResult.payload)
  }

  function checkPermission(context: OAuthContext, permission: 'exec' | 'admin', command: string): boolean {
    // Must be authenticated
    if (!context.authenticated) {
      return false
    }

    // Check basic permission
    if (!context.permissions[permission]) {
      return false
    }

    // For exec permission, also need exec: true
    if (permission === 'admin' && !context.permissions.exec) {
      return false
    }

    // Check if command requires admin and user doesn't have it
    if (isDangerousCommand(command) && !context.permissions.admin) {
      return false
    }

    // Check allowed commands if specified
    if (context.permissions.allowedCommands && context.permissions.allowedCommands.length > 0) {
      const commandName = command.split(/\s+/)[0]
      const isAllowed = context.permissions.allowedCommands.some(pattern =>
        matchesGlobPattern(command, pattern) || matchesGlobPattern(commandName, pattern.split(/\s+/)[0])
      )
      if (!isAllowed) {
        return false
      }
    }

    // Check blocked commands if specified
    if (context.permissions.blockedCommands && context.permissions.blockedCommands.length > 0) {
      const commandName = command.split(/\s+/)[0]
      const isBlocked = context.permissions.blockedCommands.some(pattern =>
        matchesGlobPattern(command, pattern) || matchesGlobPattern(commandName, pattern.split(/\s+/)[0])
      )
      if (isBlocked) {
        return false
      }
    }

    // Check allowed paths if specified
    if (context.permissions.allowedPaths && context.permissions.allowedPaths.length > 0) {
      const path = extractPathFromCommand(command)
      if (path && !isPathAllowed(path, context.permissions.allowedPaths)) {
        return false
      }
    }

    return true
  }

  return {
    authenticate,
    checkPermission,
  }
}

/**
 * Convert a JWT payload to an OAuth context
 */
function payloadToContext(payload: JWTPayload): OAuthContext {
  const permissions = payload['bashx:permissions'] ?? { exec: false, admin: false }
  const scopes = payload.scope ? payload.scope.split(' ') : []

  // Infer permissions from scopes if not explicitly set
  if (!payload['bashx:permissions']) {
    permissions.exec = scopes.includes('bash:exec')
    permissions.admin = scopes.includes('bash:admin')
  }

  return {
    authenticated: true,
    userId: payload.sub,
    permissions,
    scopes,
  }
}

// ============================================================================
// OAUTH BASH MODULE
// ============================================================================

/**
 * Extended BashModule options with OAuth configuration
 */
export interface OAuthBashModuleOptions extends BashModuleOptions {
  /** OAuth configuration */
  oauth: OAuthConfig
}

/**
 * OAuthBashModule - BashModule with OAuth authentication.
 *
 * Extends BashModule to add OAuth-based authentication and authorization.
 * Commands are blocked unless a valid authentication context is provided.
 *
 * @example
 * ```typescript
 * const module = new OAuthBashModule(executor, {
 *   oauth: {
 *     jwksUrl: 'https://oauth.do/.well-known/jwks.json',
 *   },
 * })
 *
 * // Execute with authentication context
 * const context = await module.authenticate(request)
 * const result = await module.exec('ls', ['-la'], { authContext: context })
 * ```
 */
export class OAuthBashModule extends BashModule {
  private readonly oauthConfig: OAuthConfig
  private readonly middleware: OAuthMiddleware
  private readonly securityPolicy: SecurityPolicy

  /**
   * Create a new OAuthBashModule.
   * @param executor - The command executor
   * @param options - Module options including OAuth config
   */
  constructor(executor: BashExecutor, options: OAuthBashModuleOptions) {
    super(executor, options)
    this.oauthConfig = options.oauth
    this.middleware = createOAuthMiddleware(options.oauth)
    // Use a permissive security policy that doesn't block dangerous commands
    // (OAuth scopes handle that), but still blocks command injection and path traversal
    this.securityPolicy = createSecurityPolicy({
      allowedPaths: ['/home', '/tmp', '/var/tmp'],
      // Empty blocked patterns - we handle dangerous command checks via OAuth scopes
      blockedPatterns: [],
    })
  }

  /**
   * Authenticate a request.
   * @param request - The incoming request
   * @returns The authentication context
   */
  async authenticate(request: Request): Promise<OAuthContext> {
    return this.middleware.authenticate(request, {
      verifyJWT: this.oauthConfig.verifyJWT,
    })
  }

  /**
   * Execute a command with OAuth authentication.
   * @param command - The command to execute
   * @param args - Command arguments
   * @param options - Execution options including auth context
   * @returns The execution result
   */
  async exec(command: string, args?: string[], options?: OAuthExecOptions): Promise<BashResult> {
    const fullCommand = args && args.length > 0 ? `${command} ${args.join(' ')}` : command

    // Check authentication
    if (!options?.authContext) {
      return this.createBlockedResult(fullCommand, 'authentication required')
    }

    const context = options.authContext
    if (!context.authenticated) {
      return this.createBlockedResult(fullCommand, 'authentication required')
    }

    // Check if command is dangerous and requires admin - do this FIRST before security checks
    const requiresAdmin = isDangerousCommand(fullCommand)
    if (requiresAdmin) {
      if (!this.middleware.checkPermission(context, 'admin', fullCommand)) {
        const reason = 'admin scope required for dangerous commands'
        this.auditCommand(context.userId || 'unknown', fullCommand, true, reason)
        return this.createBlockedResult(fullCommand, reason)
      }
    } else {
      // Check basic exec permission for non-dangerous commands
      if (!this.middleware.checkPermission(context, 'exec', fullCommand)) {
        const reason = 'exec permission denied'
        this.auditCommand(context.userId || 'unknown', fullCommand, true, reason)
        return this.createBlockedResult(fullCommand, reason)
      }
    }

    // Check path security for arguments (path traversal)
    for (const arg of args || []) {
      if (arg.includes('..')) {
        const pathResult = this.securityPolicy.validatePath(arg)
        if (!pathResult.valid) {
          const reason = `security: ${pathResult.violation?.message || 'path traversal blocked'}`
          this.auditCommand(context.userId || 'unknown', fullCommand, true, reason)
          return this.createBlockedResult(fullCommand, reason)
        }
      }
    }

    // Check command injection in arguments
    for (const arg of args || []) {
      if (arg.includes('$(') || arg.includes('`')) {
        const reason = 'security: command injection blocked'
        this.auditCommand(context.userId || 'unknown', fullCommand, true, reason)
        return this.createBlockedResult(fullCommand, reason)
      }
    }

    // Execute the command
    this.auditCommand(context.userId || 'unknown', fullCommand, false, 'executed')
    return super.exec(command, args, options)
  }

  /**
   * Execute a command with authentication from request headers.
   * @param command - The command to execute
   * @param args - Command arguments
   * @param request - The incoming request
   * @param options - Additional execution options
   * @returns The execution result
   */
  async execWithRequest(
    command: string,
    args: string[],
    request: Request,
    options?: ExecOptions
  ): Promise<BashResult> {
    const context = await this.authenticate(request)
    return this.exec(command, args, { ...options, authContext: context })
  }

  /**
   * Create a blocked result.
   */
  private createBlockedResult(command: string, reason: string): BashResult {
    return {
      input: command,
      command,
      valid: true,
      generated: false,
      stdout: '',
      stderr: '',
      exitCode: 0,
      intent: {
        commands: [command.split(' ')[0]],
        reads: [],
        writes: [],
        deletes: [],
        network: false,
        elevated: false,
      },
      classification: {
        type: 'read',
        impact: 'none',
        reversible: true,
        reason: 'Blocked by OAuth',
      },
      blocked: true,
      blockReason: reason,
    }
  }

  /**
   * Audit a command execution.
   */
  private auditCommand(userId: string, command: string, blocked: boolean, reason: string): void {
    this.oauthConfig.onAudit?.({ userId, command, blocked, reason })
  }
}

// ============================================================================
// WITH OAUTH MIXIN
// ============================================================================

/**
 * Type helper for classes with OAuth bash capability.
 */
export interface WithOAuthCapability {
  /** The OAuth-enabled bash module */
  readonly bash: OAuthBashModule
}

/**
 * Constructor type helper for mixin composition.
 */
export type Constructor<T = object> = new (...args: unknown[]) => T

/**
 * Internal type for mixin class extension.
 * @internal
 */
type MixinConstructor<T = object> = new (...args: any[]) => T

/**
 * Configuration for the withOAuth mixin.
 */
export interface WithOAuthConfig<TBase extends Constructor> {
  /**
   * Factory function to create the executor.
   */
  executor: (instance: InstanceType<TBase>) => BashExecutor

  /**
   * OAuth configuration.
   */
  oauth: OAuthConfig

  /**
   * Optional factory function to get FsCapability from the instance.
   */
  fs?: (instance: InstanceType<TBase>) => FsCapability | undefined

  /**
   * Whether to use native operations when FsCapability is available.
   * @default true
   */
  useNativeOps?: boolean
}

/**
 * Mixin function to add OAuth-enabled bash capability to a Durable Object class.
 *
 * @param Base - The base class to extend
 * @param config - OAuth and executor configuration
 * @returns Extended class with OAuth bash capability
 *
 * @example
 * ```typescript
 * const MixedClass = withOAuth(BaseClass, {
 *   executor: () => executor,
 *   oauth: {
 *     jwksUrl: 'https://oauth.do/.well-known/jwks.json',
 *   },
 * })
 *
 * const instance = new MixedClass()
 * const context = await instance.bash.authenticate(request)
 * const result = await instance.bash.exec('ls', [], { authContext: context })
 * ```
 */
export function withOAuth<TBase extends Constructor>(
  Base: TBase,
  config: WithOAuthConfig<TBase>
): TBase & Constructor<WithOAuthCapability> {
  // Cast to MixinConstructor to satisfy TypeScript's mixin requirements
  const MixinBase = Base as unknown as MixinConstructor

  abstract class OAuthMixin extends MixinBase implements WithOAuthCapability {
    private _bashModule?: OAuthBashModule

    get bash(): OAuthBashModule {
      if (!this._bashModule) {
        const executor = config.executor(this as InstanceType<TBase>)
        const fs = config.fs?.(this as InstanceType<TBase>)
        const useNativeOps = config.useNativeOps ?? true

        this._bashModule = new OAuthBashModule(executor, {
          fs,
          useNativeOps,
          oauth: config.oauth,
        })
      }
      return this._bashModule
    }
  }

  return OAuthMixin as TBase & Constructor<WithOAuthCapability>
}
