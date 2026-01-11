/**
 * Session Management Module
 *
 * Provides R2 Iceberg session persistence with fork/branch/experiment primitives.
 *
 * @module bashx/session
 */

// Re-export types
export * from './types.js'

// Re-export manager
export { CheckpointManager } from './checkpoint-manager.js'

// Re-export session class
export { Session } from './session.js'

// Factory function
export { createSession, loadSession } from './factory.js'
