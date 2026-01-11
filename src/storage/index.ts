/**
 * bashx Storage Module
 *
 * Cost-optimized storage patterns for Durable Object SQLite.
 *
 * @module bashx/storage
 */

export {
  // Types
  type SessionState,
  type CommandHistoryEntry,
  type OpenFileHandle,
  type ProcessInfo,
  type EvictionReason,
  type WriteBufferCacheOptions,
  type CheckpointTriggers,
  type ColumnarSessionStoreOptions,
  type CheckpointStats,
  type CostComparison,

  // Classes
  WriteBufferCache,
  ColumnarSessionStore,

  // Utilities
  analyzeWorkloadCost,
  printCostReport,
} from './columnar-store.js'
