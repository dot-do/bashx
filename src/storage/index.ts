/**
 * bashx Storage Module
 *
 * Cost-optimized storage patterns for Durable Object SQLite.
 *
 * @module bashx/storage
 */

export {
  // Schema Types
  type ColumnType,
  type ColumnDefinition,
  type SchemaDefinition,

  // Session Types
  type SessionState,
  type CommandHistoryEntry,
  type OpenFileHandle,
  type ProcessInfo,

  // Cache Types
  type EvictionReason,
  type WriteBufferCacheOptions,
  type CheckpointTriggers,
  type ColumnarStoreOptions,
  type ColumnarSessionStoreOptions,
  type CheckpointStats,
  type CostComparison,

  // Classes
  WriteBufferCache,
  ColumnarStore,
  ColumnarSessionStore,

  // Schema Constants
  SESSION_SCHEMA,

  // Utilities
  analyzeWorkloadCost,
  printCostReport,
} from './columnar-store.js'
