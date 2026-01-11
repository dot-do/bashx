/**
 * Shell RPC Implementation Module
 *
 * Exports ShellApiImpl, ShellStreamImpl, and rate limiting utilities
 * for Node.js environments.
 *
 * @packageDocumentation
 */

// Core implementations
export { ShellApiImpl, createShellApi } from './shell-api-impl.js'
export { ShellStreamImpl } from './shell-stream-impl.js'

// Rate limiting
export {
  RateLimiter,
  RateLimitedShellApi,
  RateLimitError,
  withRateLimit,
  createRateLimiter,
  type RateLimitConfig,
  type RateLimitStats,
} from './rate-limiter.js'
