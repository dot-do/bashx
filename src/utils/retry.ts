/**
 * Retry Utility Module
 *
 * Provides unified retry logic with exponential backoff for all bashx operations.
 *
 * This module consolidates retry patterns from:
 * - src/remote/errors.ts (calculateBackoff, shouldRetry)
 * - src/remote/http-client.ts (fetchWithRetry)
 * - src/npmx/registry-client.ts (fetchWithRetry)
 *
 * Features:
 * - Generic retry wrapper for any async operation
 * - Exponential backoff with configurable jitter
 * - Customizable retry conditions
 * - Rate limit detection and waiting
 * - Comprehensive TypeScript types
 * - Abort signal support for cancellation
 *
 * @packageDocumentation
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  /**
   * Maximum number of retry attempts.
   * Set to 0 to disable retries.
   * @default 3
   */
  maxRetries: number

  /**
   * Base delay in milliseconds for exponential backoff.
   * @default 1000
   */
  baseDelayMs: number

  /**
   * Maximum delay in milliseconds for exponential backoff.
   * Delay will never exceed this value.
   * @default 30000
   */
  maxDelayMs: number

  /**
   * Whether to add jitter (randomness) to the delay.
   * Helps prevent thundering herd problems.
   * @default true
   */
  jitter: boolean

  /**
   * Whether to wait for rate limit reset before retrying.
   * Only applies if the error has rate limit information.
   * @default true
   */
  waitForRateLimit: boolean

  /**
   * Maximum time to wait for a rate limit reset in milliseconds.
   * If the reset time exceeds this, throw immediately.
   * @default 300000 (5 minutes)
   */
  maxRateLimitWaitMs: number
}

/**
 * Partial retry configuration for user overrides.
 */
export type PartialRetryConfig = Partial<RetryConfig>

/**
 * Options for the retry function.
 */
export interface RetryOptions<T> extends PartialRetryConfig {
  /**
   * Custom function to determine if an error should trigger a retry.
   * Return true to retry, false to throw immediately.
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean

  /**
   * Callback invoked before each retry attempt.
   * Useful for logging or telemetry.
   */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void

  /**
   * Callback invoked on successful completion.
   * Receives the result and total number of attempts.
   */
  onSuccess?: (result: T, attempts: number) => void

  /**
   * Abort signal for cancellation.
   * If aborted, retry will throw immediately.
   */
  signal?: AbortSignal

  /**
   * Operation name for error messages and logging.
   */
  operation?: string
}

/**
 * Result of a retry operation with metadata.
 */
export interface RetryResult<T> {
  /** The result of the successful operation */
  result: T
  /** Number of attempts made (1 = first try succeeded) */
  attempts: number
  /** Total time spent including retries in milliseconds */
  totalTimeMs: number
}

/**
 * Rate limit information interface.
 * Errors with this shape can be detected for rate limit waiting.
 */
export interface RateLimitInfo {
  limit: number
  remaining: number
  resetAt: Date
}

/**
 * Error with rate limit information.
 */
export interface RateLimitError extends Error {
  rateLimit: RateLimitInfo
  getWaitMs: () => number
  waitForReset: () => Promise<void>
}

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: Readonly<RetryConfig> = Object.freeze({
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitter: true,
  waitForRateLimit: true,
  maxRateLimitWaitMs: 300000,
})

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Calculate delay for exponential backoff.
 *
 * Uses the formula: `min(maxDelayMs, baseDelayMs * 2^attempt)` with optional jitter.
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param options - Backoff configuration
 * @returns Delay in milliseconds
 *
 * @example
 * ```typescript
 * // Attempt 0: ~1000ms, Attempt 1: ~2000ms, Attempt 2: ~4000ms
 * const delay = calculateBackoff(2, { baseDelayMs: 1000, maxDelayMs: 30000 })
 * ```
 */
export function calculateBackoff(
  attempt: number,
  options: {
    baseDelayMs?: number
    maxDelayMs?: number
    jitter?: boolean
  } = {}
): number {
  const {
    baseDelayMs = DEFAULT_RETRY_CONFIG.baseDelayMs,
    maxDelayMs = DEFAULT_RETRY_CONFIG.maxDelayMs,
    jitter = DEFAULT_RETRY_CONFIG.jitter,
  } = options

  // Exponential backoff: baseDelay * 2^attempt
  let delay = baseDelayMs * Math.pow(2, attempt)

  // Cap at max delay
  delay = Math.min(delay, maxDelayMs)

  // Add jitter (random +/-25%)
  if (jitter) {
    const jitterFactor = 0.75 + Math.random() * 0.5
    delay = Math.floor(delay * jitterFactor)
  }

  return delay
}

/**
 * Determine if an error should trigger a retry.
 *
 * Checks for:
 * - Network errors (ECONNRESET, ETIMEDOUT, etc.)
 * - Rate limit errors
 * - Server errors (5xx)
 * - Timeout errors
 * - Errors with retryable flag set to true
 *
 * @param error - The error to check
 * @param attempt - Current attempt number (0-indexed)
 * @param maxRetries - Maximum number of retries allowed
 * @returns true if the error should trigger a retry
 *
 * @example
 * ```typescript
 * if (shouldRetry(error, attempt, 3)) {
 *   // Wait and retry
 * } else {
 *   throw error
 * }
 * ```
 */
export function shouldRetry(
  error: unknown,
  attempt: number,
  maxRetries: number
): boolean {
  // Check if we've exceeded max retries
  if (attempt >= maxRetries) {
    return false
  }

  // Check for retryable property on error
  if (isRetryableError(error)) {
    return true
  }

  // Check for network error codes
  if (isNetworkError(error)) {
    return true
  }

  // Check for rate limit error
  if (isRateLimitError(error)) {
    return true
  }

  // Check for server error status
  if (isServerError(error)) {
    return true
  }

  // Check for timeout error
  if (isTimeoutError(error)) {
    return true
  }

  return false
}

/**
 * Check if an error has the retryable flag set to true.
 */
export function isRetryableError(error: unknown): boolean {
  const errorObj = error as { retryable?: boolean }
  return errorObj?.retryable === true
}

/**
 * Check if an error is a network-level error.
 */
export function isNetworkError(error: unknown): boolean {
  const errorObj = error as { code?: string; name?: string }
  const code = errorObj?.code
  const name = errorObj?.name

  // Check error name
  if (name === 'NetworkError') {
    return true
  }

  // Check for known network error codes
  const networkCodes = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENETUNREACH',
    'EPIPE',
    'EAI_AGAIN',
    'EHOSTUNREACH',
  ]

  return code !== undefined && networkCodes.includes(code)
}

/**
 * Check if an error is a rate limit error.
 */
export function isRateLimitError(error: unknown): error is RateLimitError {
  const errorObj = error as { name?: string; rateLimit?: unknown; code?: string }
  return (
    errorObj?.name === 'RateLimitError' ||
    errorObj?.code === 'RATE_LIMIT_ERROR' ||
    (typeof errorObj?.rateLimit === 'object' && errorObj.rateLimit !== null)
  )
}

/**
 * Check if an error is a server error (5xx).
 */
export function isServerError(error: unknown): boolean {
  const errorObj = error as { status?: number; statusCode?: number; name?: string }

  // Check error name
  if (errorObj?.name === 'ServerError') {
    return true
  }

  // Check status code
  const status = errorObj?.status ?? errorObj?.statusCode
  if (typeof status === 'number') {
    // 5xx errors are retryable (except 501 Not Implemented)
    return status >= 500 && status < 600 && status !== 501
  }

  return false
}

/**
 * Check if an error is a timeout error.
 */
export function isTimeoutError(error: unknown): boolean {
  const errorObj = error as { name?: string; code?: string }
  return (
    errorObj?.name === 'TimeoutError' ||
    errorObj?.name === 'AbortError' ||
    errorObj?.code === 'TIMEOUT_ERROR'
  )
}

// ============================================================================
// Main Retry Function
// ============================================================================

/**
 * Execute an async operation with retry logic.
 *
 * Automatically retries on transient errors with exponential backoff.
 * Supports rate limit detection, cancellation, and custom retry conditions.
 *
 * @param operation - The async operation to execute
 * @param options - Retry configuration and callbacks
 * @returns The result of the successful operation
 * @throws The last error if all retries are exhausted
 *
 * @example
 * ```typescript
 * // Simple retry with defaults
 * const data = await retry(() => fetchData())
 *
 * // Retry with custom options
 * const data = await retry(
 *   () => api.request('/endpoint'),
 *   {
 *     maxRetries: 5,
 *     baseDelayMs: 500,
 *     onRetry: (attempt, error, delay) => {
 *       console.log(`Retry ${attempt}, waiting ${delay}ms: ${error.message}`)
 *     },
 *   }
 * )
 *
 * // Retry with custom retry condition
 * const data = await retry(
 *   () => doOperation(),
 *   {
 *     shouldRetry: (error, attempt) => {
 *       // Only retry specific error codes
 *       return error.code === 'CONFLICT' && attempt < 3
 *     },
 *   }
 * )
 * ```
 */
export async function retry<T>(
  operation: () => Promise<T>,
  options: RetryOptions<T> = {}
): Promise<T> {
  const config = mergeConfig(options)
  const {
    shouldRetry: customShouldRetry,
    onRetry,
    onSuccess,
    signal,
    operation: operationName,
  } = options

  const startTime = Date.now()
  let lastError: Error | undefined
  let attempt = 0

  while (attempt <= config.maxRetries) {
    // Check for cancellation
    if (signal?.aborted) {
      throw new Error(`${operationName ?? 'Operation'} was cancelled`)
    }

    try {
      const result = await operation()

      // Success callback
      if (onSuccess) {
        onSuccess(result, attempt + 1)
      }

      return result
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error))

      // Handle rate limiting with wait
      if (isRateLimitError(error) && config.waitForRateLimit) {
        const waitMs = error.getWaitMs()
        if (waitMs <= config.maxRateLimitWaitMs) {
          // Notify about rate limit wait
          if (onRetry) {
            onRetry(attempt, lastError, waitMs)
          }
          await error.waitForReset()
          // Don't count rate limit waits against retry limit
          continue
        }
      }

      // Check if we should retry
      const shouldRetryError = customShouldRetry
        ? customShouldRetry(error, attempt)
        : shouldRetry(error, attempt, config.maxRetries)

      if (!shouldRetryError) {
        throw lastError
      }

      // Calculate backoff delay
      const delay = calculateBackoff(attempt, {
        baseDelayMs: config.baseDelayMs,
        maxDelayMs: config.maxDelayMs,
        jitter: config.jitter,
      })

      // Notify about retry
      if (onRetry) {
        onRetry(attempt, lastError, delay)
      }

      // Wait before retry (check for cancellation during wait)
      await delayWithSignal(delay, signal)

      attempt++
    }
  }

  // All retries exhausted
  throw lastError ?? new Error(`${operationName ?? 'Operation'} failed after ${attempt} attempts`)
}

/**
 * Execute an async operation with retry logic, returning metadata.
 *
 * Same as `retry()` but returns additional metadata about the operation.
 *
 * @param operation - The async operation to execute
 * @param options - Retry configuration and callbacks
 * @returns Result with metadata (attempts, totalTimeMs)
 *
 * @example
 * ```typescript
 * const { result, attempts, totalTimeMs } = await retryWithMetadata(
 *   () => fetchData()
 * )
 * console.log(`Succeeded after ${attempts} attempts in ${totalTimeMs}ms`)
 * ```
 */
export async function retryWithMetadata<T>(
  operation: () => Promise<T>,
  options: RetryOptions<T> = {}
): Promise<RetryResult<T>> {
  const startTime = Date.now()
  let attemptCount = 0

  const wrappedOptions: RetryOptions<T> = {
    ...options,
    onSuccess: (result, attempts) => {
      attemptCount = attempts
      options.onSuccess?.(result, attempts)
    },
  }

  const result = await retry(operation, wrappedOptions)

  return {
    result,
    attempts: attemptCount,
    totalTimeMs: Date.now() - startTime,
  }
}

/**
 * Higher-order function that wraps an async function with retry logic.
 *
 * Creates a new function that automatically retries on failure.
 *
 * @param fn - The async function to wrap
 * @param options - Retry configuration
 * @returns Wrapped function with retry logic
 *
 * @example
 * ```typescript
 * const fetchWithRetry = withRetry(
 *   (url: string) => fetch(url).then(r => r.json()),
 *   { maxRetries: 3 }
 * )
 *
 * // Now fetches with automatic retry
 * const data = await fetchWithRetry('/api/data')
 * ```
 */
export function withRetry<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: RetryOptions<TResult> = {}
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => retry(() => fn(...args), options)
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Merge partial config with defaults.
 */
function mergeConfig(options: PartialRetryConfig): RetryConfig {
  return {
    maxRetries: options.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs,
    jitter: options.jitter ?? DEFAULT_RETRY_CONFIG.jitter,
    waitForRateLimit: options.waitForRateLimit ?? DEFAULT_RETRY_CONFIG.waitForRateLimit,
    maxRateLimitWaitMs: options.maxRateLimitWaitMs ?? DEFAULT_RETRY_CONFIG.maxRateLimitWaitMs,
  }
}

/**
 * Delay with abort signal support.
 */
function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Operation was cancelled'))
      return
    }

    const timeout = setTimeout(resolve, ms)

    signal?.addEventListener('abort', () => {
      clearTimeout(timeout)
      reject(new Error('Operation was cancelled'))
    }, { once: true })
  })
}

/**
 * Simple delay without cancellation support.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
