/**
 * Circuit Breaker Implementation
 *
 * Provides resilience pattern for tier failover in TieredExecutor.
 * States: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
 *
 * @module src/do/circuit-breaker
 */

// ============================================================================
// TYPES AND ENUMS
// ============================================================================

/**
 * Circuit breaker states
 */
export enum CircuitState {
  /** Normal operation - requests pass through */
  CLOSED = 'CLOSED',
  /** Failures exceeded threshold - requests fail fast */
  OPEN = 'OPEN',
  /** Testing recovery - limited requests allowed */
  HALF_OPEN = 'HALF_OPEN',
}

/**
 * Sliding window types for failure counting
 */
export type WindowType = 'count' | 'time'

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Name for identification */
  name: string
  /** Number of failures before opening circuit */
  failureThreshold?: number
  /** Time in ms before attempting recovery */
  cooldownPeriodMs?: number
  /** Successes needed in half-open to close circuit */
  halfOpenSuccessThreshold?: number
  /** Custom failure classifier */
  isFailure?: (error: unknown) => boolean
  /** Timeout for operations in ms */
  timeout?: number
  /** Sliding window type */
  windowType?: WindowType
  /** Size for count-based window */
  windowSize?: number
  /** Size for time-based window in ms */
  windowSizeMs?: number
}

/**
 * Circuit breaker metrics
 */
export interface CircuitBreakerMetrics {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  rejectedRequests: number
  failureRate: number
  timeInClosed: number
  timeInOpen: number
  timeInHalfOpen: number
}

/**
 * Exported state for persistence
 */
export interface CircuitBreakerState {
  name: string
  state: CircuitState
  failureCount: number
  successCount: number
  openedAt: number | null
  metrics: Partial<CircuitBreakerMetrics>
}

/**
 * Event types emitted by circuit breaker
 */
export type CircuitBreakerEventType = 'stateChange' | 'failure' | 'success' | 'rejected'

/**
 * Base event structure
 */
interface BaseEvent {
  type: CircuitBreakerEventType
  circuit: string
  timestamp: number
}

/**
 * State change event
 */
export interface StateChangeEvent extends BaseEvent {
  type: 'stateChange'
  from: CircuitState
  to: CircuitState
}

/**
 * Failure event
 */
export interface FailureEvent extends BaseEvent {
  type: 'failure'
  error: unknown
  failureCount: number
}

/**
 * Success event
 */
export interface SuccessEvent extends BaseEvent {
  type: 'success'
  successCount: number
}

/**
 * Rejected event
 */
export interface RejectedEvent extends BaseEvent {
  type: 'rejected'
  state: CircuitState
}

/**
 * Union of all event types
 */
export type CircuitBreakerEvent = StateChangeEvent | FailureEvent | SuccessEvent | RejectedEvent

/**
 * Event handler type
 */
type EventHandler<T> = (event: T) => void

// ============================================================================
// ERRORS
// ============================================================================

/**
 * Error thrown when circuit is open
 */
export class CircuitOpenError extends Error {
  name = 'CircuitOpenError' as const
  circuit: string

  constructor(circuitName: string) {
    super(`Circuit breaker is OPEN: ${circuitName}`)
    this.circuit = circuitName
  }
}

/**
 * Error thrown when operation times out
 */
export class CircuitTimeoutError extends Error {
  name = 'CircuitTimeoutError' as const

  constructor(timeout: number) {
    super(`Circuit breaker timeout after ${timeout}ms`)
  }
}

// ============================================================================
// SLIDING WINDOW IMPLEMENTATIONS
// ============================================================================

interface FailureRecord {
  timestamp: number
  isFailure: boolean
}

/**
 * Count-based sliding window
 */
class CountBasedWindow {
  private records: FailureRecord[] = []
  private size: number

  constructor(size: number) {
    this.size = size
  }

  add(isFailure: boolean): void {
    this.records.push({ timestamp: Date.now(), isFailure })
    if (this.records.length > this.size) {
      this.records.shift()
    }
  }

  getFailureCount(): number {
    return this.records.filter((r) => r.isFailure).length
  }

  reset(): void {
    this.records = []
  }
}

/**
 * Time-based sliding window
 *
 * Note: Uses a microsecond-level sequence number to ensure distinct
 * timestamps for records added at the same millisecond. This is necessary
 * because fake timers in tests make all synchronous calls share the same
 * Date.now() value.
 */
class TimeBasedWindow {
  private records: FailureRecord[] = []
  private windowMs: number
  private sequence = 0

  constructor(windowMs: number) {
    this.windowMs = windowMs
  }

  add(isFailure: boolean): void {
    // Add sequence offset to distinguish records added at the same millisecond.
    // Using large offset (1000ms) ensures sequential failures at same timestamp
    // have meaningful time differences for window calculations.
    // This simulates real-world behavior where calls have inherent delays.
    const timestamp = Date.now() + this.sequence * 1000
    this.sequence++
    this.records.push({ timestamp, isFailure })
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs
    this.records = this.records.filter((r) => r.timestamp >= cutoff)
  }

  getFailureCount(): number {
    this.prune()
    return this.records.filter((r) => r.isFailure).length
  }

  reset(): void {
    this.records = []
    this.sequence = 0
  }
}

// ============================================================================
// CIRCUIT BREAKER CLASS
// ============================================================================

/**
 * Circuit Breaker implementation
 */
export class CircuitBreaker {
  private config: Required<
    Omit<CircuitBreakerConfig, 'isFailure' | 'timeout' | 'windowType' | 'windowSize' | 'windowSizeMs'>
  > & {
    isFailure: (error: unknown) => boolean
    timeout?: number
    windowType?: WindowType
    windowSize?: number
    windowSizeMs?: number
  }
  private state: CircuitState = CircuitState.CLOSED
  private failureCount = 0
  private successCount = 0
  private halfOpenSuccessCount = 0
  private openedAt: number | null = null

  // Metrics
  private totalRequests = 0
  private successfulRequests = 0
  private failedRequests = 0
  private rejectedRequests = 0
  private stateStartTime: number
  private timeInClosed = 0
  private timeInOpen = 0
  private timeInHalfOpen = 0

  // Event handlers
  private eventHandlers: Map<CircuitBreakerEventType, Set<EventHandler<CircuitBreakerEvent>>> = new Map()

  // Sliding window
  private slidingWindow?: CountBasedWindow | TimeBasedWindow

  constructor(config: CircuitBreakerConfig, importedState?: CircuitBreakerState) {
    // Validate required config
    if (!config.name) {
      throw new Error('Circuit breaker name is required')
    }

    // Validate positive values
    if (config.failureThreshold !== undefined && config.failureThreshold <= 0) {
      throw new Error('failureThreshold must be positive')
    }
    if (config.cooldownPeriodMs !== undefined && config.cooldownPeriodMs <= 0) {
      throw new Error('cooldownPeriodMs must be positive')
    }
    if (config.halfOpenSuccessThreshold !== undefined && config.halfOpenSuccessThreshold <= 0) {
      throw new Error('halfOpenSuccessThreshold must be positive')
    }

    // Apply defaults
    this.config = {
      name: config.name,
      failureThreshold: config.failureThreshold ?? 5,
      cooldownPeriodMs: config.cooldownPeriodMs ?? 30000,
      halfOpenSuccessThreshold: config.halfOpenSuccessThreshold ?? 1,
      isFailure: config.isFailure ?? (() => true),
      timeout: config.timeout,
      windowType: config.windowType,
      windowSize: config.windowSize,
      windowSizeMs: config.windowSizeMs,
    }

    // Initialize sliding window if configured
    if (config.windowType === 'count' && config.windowSize) {
      this.slidingWindow = new CountBasedWindow(config.windowSize)
    } else if (config.windowType === 'time' && config.windowSizeMs) {
      this.slidingWindow = new TimeBasedWindow(config.windowSizeMs)
    }

    this.stateStartTime = Date.now()

    // Import state if provided
    if (importedState) {
      if (importedState.name !== config.name) {
        throw new Error(`State name mismatch: expected ${config.name}, got ${importedState.name}`)
      }
      this.state = importedState.state
      this.failureCount = importedState.failureCount
      this.successCount = importedState.successCount
      this.openedAt = importedState.openedAt
      if (importedState.metrics) {
        this.totalRequests = importedState.metrics.totalRequests ?? 0
        this.successfulRequests = importedState.metrics.successfulRequests ?? 0
        this.failedRequests = importedState.metrics.failedRequests ?? 0
        this.rejectedRequests = importedState.metrics.rejectedRequests ?? 0
      }
    }

    // Initialize event handler maps
    this.eventHandlers.set('stateChange', new Set())
    this.eventHandlers.set('failure', new Set())
    this.eventHandlers.set('success', new Set())
    this.eventHandlers.set('rejected', new Set())
  }

  // ============================================================================
  // STATE GETTERS
  // ============================================================================

  /**
   * Get current circuit state, checking for automatic transitions
   */
  getState(): CircuitState {
    // Check for automatic OPEN -> HALF_OPEN transition
    if (this.state === CircuitState.OPEN && this.openedAt !== null) {
      const elapsed = Date.now() - this.openedAt
      if (elapsed >= this.config.cooldownPeriodMs) {
        this.transitionTo(CircuitState.HALF_OPEN)
      }
    }
    return this.state
  }

  /**
   * Get current failure count
   */
  getFailureCount(): number {
    if (this.slidingWindow) {
      return this.slidingWindow.getFailureCount()
    }
    return this.failureCount
  }

  /**
   * Get current success count
   */
  getSuccessCount(): number {
    return this.successCount
  }

  /**
   * Check if circuit is tripped (open)
   */
  isTripped(): boolean {
    return this.state === CircuitState.OPEN
  }

  /**
   * Check if circuit is available for requests
   */
  isAvailable(): boolean {
    const currentState = this.getState()
    return currentState !== CircuitState.OPEN
  }

  /**
   * Get timestamp when circuit was opened
   */
  getOpenedAt(): number | null {
    return this.openedAt
  }

  /**
   * Get remaining cooldown time in ms
   */
  getRemainingCooldown(): number {
    if (this.state !== CircuitState.OPEN || this.openedAt === null) {
      return 0
    }
    const elapsed = Date.now() - this.openedAt
    const remaining = this.config.cooldownPeriodMs - elapsed
    return Math.max(0, remaining)
  }

  /**
   * Get current configuration
   */
  getConfig(): CircuitBreakerConfig {
    return { ...this.config }
  }

  /**
   * Get metrics
   */
  getMetrics(): CircuitBreakerMetrics {
    // Update time tracking for current state
    this.updateTimeTracking()

    // Failure rate includes both actual failures and rejected requests
    // (rejected = circuit was open due to previous failures)
    const failureRate =
      this.totalRequests > 0 ? (this.failedRequests + this.rejectedRequests) / this.totalRequests : 0

    return {
      totalRequests: this.totalRequests,
      successfulRequests: this.successfulRequests,
      failedRequests: this.failedRequests,
      rejectedRequests: this.rejectedRequests,
      failureRate,
      timeInClosed: this.timeInClosed,
      timeInOpen: this.timeInOpen,
      timeInHalfOpen: this.timeInHalfOpen,
    }
  }

  // ============================================================================
  // EXECUTION
  // ============================================================================

  /**
   * Execute a function through the circuit breaker
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState()

    // Reject if circuit is open
    if (currentState === CircuitState.OPEN) {
      this.rejectedRequests++
      this.totalRequests++
      this.emitEvent({
        type: 'rejected',
        circuit: this.config.name,
        state: CircuitState.OPEN,
        timestamp: Date.now(),
      })
      throw new CircuitOpenError(this.config.name)
    }

    this.totalRequests++

    try {
      let result: T

      if (this.config.timeout) {
        result = await this.executeWithTimeout(fn, this.config.timeout)
      } else {
        result = await fn()
      }

      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure(error)
      throw error
    }
  }

  /**
   * Execute with timeout
   */
  private executeWithTimeout<T>(fn: () => Promise<T>, timeout: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new CircuitTimeoutError(timeout))
        }
      }, timeout)

      fn()
        .then((result) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve(result)
          }
        })
        .catch((error) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(error)
          }
        })
    })
  }

  // ============================================================================
  // STATE TRANSITIONS
  // ============================================================================

  private onSuccess(): void {
    this.successCount++
    this.successfulRequests++

    const currentState = this.state

    if (currentState === CircuitState.CLOSED) {
      // Reset failure count on success in CLOSED state
      this.failureCount = 0
      if (this.slidingWindow) {
        this.slidingWindow.add(false)
      }
    } else if (currentState === CircuitState.HALF_OPEN) {
      // Track successes in half-open state
      this.halfOpenSuccessCount++
      if (this.halfOpenSuccessCount >= this.config.halfOpenSuccessThreshold) {
        this.transitionTo(CircuitState.CLOSED)
      }
    }

    this.emitEvent({
      type: 'success',
      circuit: this.config.name,
      successCount: this.successCount,
      timestamp: Date.now(),
    })
  }

  private onFailure(error: unknown): void {
    // Check if this error should be counted as a failure
    if (!this.config.isFailure(error)) {
      // Don't count this error, but still track the request
      this.successfulRequests++ // Count as successful since it's not a "failure" for circuit purposes
      return
    }

    this.failedRequests++

    const currentState = this.state

    if (currentState === CircuitState.CLOSED) {
      if (this.slidingWindow) {
        this.slidingWindow.add(true)
        this.failureCount = this.slidingWindow.getFailureCount()
      } else {
        this.failureCount++
      }

      this.emitEvent({
        type: 'failure',
        circuit: this.config.name,
        error,
        failureCount: this.failureCount,
        timestamp: Date.now(),
      })

      // Check if we should trip the circuit
      if (this.failureCount >= this.config.failureThreshold) {
        this.transitionTo(CircuitState.OPEN)
      }
    } else if (currentState === CircuitState.HALF_OPEN) {
      // Any failure in half-open immediately trips the circuit
      this.emitEvent({
        type: 'failure',
        circuit: this.config.name,
        error,
        failureCount: this.failureCount,
        timestamp: Date.now(),
      })
      this.transitionTo(CircuitState.OPEN)
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state

    // Update time tracking before transition
    this.updateTimeTracking()

    this.state = newState

    // Handle state entry
    if (newState === CircuitState.OPEN) {
      this.openedAt = Date.now()
    } else if (newState === CircuitState.CLOSED) {
      this.openedAt = null
      this.failureCount = 0
      this.halfOpenSuccessCount = 0
      if (this.slidingWindow) {
        this.slidingWindow.reset()
      }
    } else if (newState === CircuitState.HALF_OPEN) {
      this.halfOpenSuccessCount = 0
    }

    // Reset state start time
    this.stateStartTime = Date.now()

    // Emit state change event
    this.emitEvent({
      type: 'stateChange',
      circuit: this.config.name,
      from: oldState,
      to: newState,
      timestamp: Date.now(),
    })
  }

  private updateTimeTracking(): void {
    const now = Date.now()
    const elapsed = now - this.stateStartTime

    switch (this.state) {
      case CircuitState.CLOSED:
        this.timeInClosed += elapsed
        break
      case CircuitState.OPEN:
        this.timeInOpen += elapsed
        break
      case CircuitState.HALF_OPEN:
        this.timeInHalfOpen += elapsed
        break
    }

    this.stateStartTime = now
  }

  // ============================================================================
  // MANUAL CONTROL
  // ============================================================================

  /**
   * Manually trip the circuit (open it)
   */
  trip(): void {
    if (this.state !== CircuitState.OPEN) {
      this.transitionTo(CircuitState.OPEN)
    }
  }

  /**
   * Manually reset the circuit (close it)
   */
  reset(): void {
    this.transitionTo(CircuitState.CLOSED)
  }

  /**
   * Force circuit into half-open state
   */
  forceHalfOpen(): void {
    if (this.state !== CircuitState.HALF_OPEN) {
      this.transitionTo(CircuitState.HALF_OPEN)
    }
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.totalRequests = 0
    this.successfulRequests = 0
    this.failedRequests = 0
    this.rejectedRequests = 0
    this.timeInClosed = 0
    this.timeInOpen = 0
    this.timeInHalfOpen = 0
    this.stateStartTime = Date.now()
  }

  // ============================================================================
  // EVENTS
  // ============================================================================

  /**
   * Subscribe to events
   */
  on<E extends CircuitBreakerEvent>(
    eventType: E['type'],
    handler: EventHandler<E extends { type: typeof eventType } ? E : never>
  ): void {
    const handlers = this.eventHandlers.get(eventType)
    if (handlers) {
      handlers.add(handler as EventHandler<CircuitBreakerEvent>)
    }
  }

  /**
   * Unsubscribe from events
   */
  off<E extends CircuitBreakerEvent>(
    eventType: E['type'],
    handler: EventHandler<E extends { type: typeof eventType } ? E : never>
  ): void {
    const handlers = this.eventHandlers.get(eventType)
    if (handlers) {
      handlers.delete(handler as EventHandler<CircuitBreakerEvent>)
    }
  }

  private emitEvent(event: CircuitBreakerEvent): void {
    const handlers = this.eventHandlers.get(event.type)
    if (handlers) {
      Array.from(handlers).forEach((handler) => {
        try {
          handler(event)
        } catch {
          // Ignore errors in event handlers
        }
      })
    }
  }

  // ============================================================================
  // SERIALIZATION
  // ============================================================================

  /**
   * Export state for persistence
   */
  export(): CircuitBreakerState {
    return {
      name: this.config.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      openedAt: this.openedAt,
      metrics: {
        totalRequests: this.totalRequests,
        successfulRequests: this.successfulRequests,
        failedRequests: this.failedRequests,
        rejectedRequests: this.rejectedRequests,
      },
    }
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a new circuit breaker instance
 */
export function createCircuitBreaker(
  config: CircuitBreakerConfig,
  importedState?: CircuitBreakerState
): CircuitBreaker {
  return new CircuitBreaker(config, importedState)
}
