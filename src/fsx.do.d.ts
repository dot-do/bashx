/**
 * Type declarations for fsx.do/storage columnar storage module
 *
 * These types are used by bashx for cost-optimized session storage
 * using the columnar storage pattern with DO SQLite.
 *
 * The columnar pattern achieves ~99%+ cost reduction by:
 * - Storing entities as single rows with JSON columns (vs normalized many-row approach)
 * - Buffering writes in an LRU cache
 * - Batch checkpointing dirty entries
 *
 * @module fsx.do/storage
 */

import type { SqlStorage } from '@cloudflare/workers-types'

declare module 'fsx.do/storage' {
  // ============================================================================
  // Write Buffer Cache Types
  // ============================================================================

  /**
   * Eviction reason for cache callbacks
   */
  export type EvictionReason = 'count' | 'size' | 'expired' | 'deleted' | 'cleared' | 'checkpoint'

  /**
   * Options for the write-buffering LRU cache
   */
  export interface WriteBufferCacheOptions<V = unknown> {
    /** Maximum number of items (default: 500) */
    maxCount?: number
    /** Maximum size in bytes (default: 25MB) */
    maxBytes?: number
    /** Default TTL in milliseconds (default: 0, no expiry) */
    defaultTTL?: number
    /** Callback when an item is evicted */
    onEvict?: (key: string, value: V, reason: EvictionReason) => void
    /** Size calculator for values */
    sizeCalculator?: (value: V) => number
  }

  /**
   * Cache statistics
   */
  export interface CacheStats {
    count: number
    bytes: number
    dirtyCount: number
    hits: number
    misses: number
    hitRate: number
    evictions: number
    checkpoints: number
    memoryUsageRatio: number
  }

  /**
   * LRU Cache with write buffering for batch checkpoints
   *
   * This cache tracks dirty entries and flushes them in batches to minimize
   * row writes to SQLite.
   */
  export class WriteBufferCache<V> {
    constructor(options?: WriteBufferCacheOptions<V>)

    /** Get a value from the cache */
    get(key: string): V | undefined

    /** Set a value in the cache, marking it as dirty */
    set(key: string, value: V, options?: { ttl?: number; markDirty?: boolean }): void

    /** Delete a value from the cache */
    delete(key: string): boolean

    /** Check if a key exists in the cache */
    has(key: string): boolean

    /** Get all dirty entries for checkpointing */
    getDirtyEntries(): Map<string, V>

    /** Mark entries as clean after checkpoint */
    markClean(keys: string[]): void

    /** Get the number of dirty entries */
    readonly dirtyCount: number

    /** Get cache statistics */
    getStats(): CacheStats

    /** Clear all entries from the cache */
    clear(): void

    /** Iterate over cache entries */
    entries(): IterableIterator<[string, V]>
  }

  // ============================================================================
  // Columnar Store Types
  // ============================================================================

  /**
   * Column type for schema definition
   */
  export type ColumnType = 'text' | 'integer' | 'real' | 'blob' | 'json' | 'datetime'

  /**
   * Column definition for a single field
   */
  export interface ColumnDefinition<T = unknown, K extends keyof T = keyof T> {
    /** SQL column name (defaults to field name in snake_case) */
    column?: string
    /** Column type for SQL schema */
    type: ColumnType
    /** Whether this field is required (NOT NULL) */
    required?: boolean
    /** Default value for the column */
    defaultValue?: string
    /** Custom serializer for this field */
    serialize?: (value: T[K]) => unknown
    /** Custom deserializer for this field */
    deserialize?: (raw: unknown) => T[K]
  }

  /**
   * Schema definition for mapping type T to SQL columns
   */
  export interface SchemaDefinition<T> {
    /** SQL table name */
    tableName: string
    /** Primary key field name (must be a key of T) */
    primaryKey: keyof T & string
    /** Column definitions for each field */
    columns: {
      [K in keyof T]?: ColumnDefinition<T, K>
    }
    /** Version field for optimistic locking (optional) */
    versionField?: keyof T & string
    /** Updated at field for automatic timestamp (optional) */
    updatedAtField?: keyof T & string
    /** Created at field for automatic timestamp (optional) */
    createdAtField?: keyof T & string
    /** Checkpointed at field for tracking checkpoints (optional) */
    checkpointedAtField?: keyof T & string
  }

  /**
   * Checkpoint trigger configuration
   */
  export interface CheckpointTriggers {
    /** Checkpoint after this many dirty entries */
    afterWrites?: number
    /** Checkpoint after this many milliseconds */
    afterMs?: number
    /** Checkpoint on shutdown */
    onShutdown?: boolean
    /** Checkpoint after this many dirty entries (alias for afterWrites) */
    dirtyCount?: number
    /** Checkpoint after this many milliseconds (alias for afterMs) */
    intervalMs?: number
    /** Checkpoint when memory usage exceeds this ratio */
    memoryPressureRatio?: number
  }

  /**
   * Options for ColumnarStore<T>
   */
  export interface ColumnarStoreOptions<T> {
    /** Cache configuration */
    cache?: WriteBufferCacheOptions<T>
    /** Checkpoint trigger configuration */
    checkpointTriggers?: CheckpointTriggers
    /** Callback when checkpoint occurs */
    onCheckpoint?: (entities: T[], stats: CheckpointStats) => void
  }

  /**
   * Statistics from a checkpoint operation
   */
  export interface CheckpointStats {
    /** Number of entities written (or rowsCheckpointed) */
    entityCount?: number
    rowsCheckpointed?: number
    /** Total bytes written */
    totalBytes?: number
    bytesWritten?: number
    /** Time taken in ms */
    durationMs: number
    /** Trigger reason */
    trigger?: 'count' | 'interval' | 'memory' | 'manual' | 'eviction'
  }

  /**
   * Cost comparison result
   */
  export interface CostComparison {
    /** Normalized approach stats */
    normalized: {
      rowWrites?: number
      reads?: number
      writes?: number
      estimatedCost?: number
      totalCost?: number
    }
    /** Columnar approach stats */
    columnar: {
      rowWrites?: number
      reads?: number
      writes?: number
      estimatedCost?: number
      totalCost?: number
    }
    /** Cost reduction percentage */
    reductionPercent?: number
    /** Cost reduction factor (e.g., 100x) */
    reductionFactor?: number
    /** Savings amount */
    savings?: number
    /** Savings percentage */
    savingsPercent?: number
  }

  /**
   * Generic Columnar Store with write buffering
   *
   * This store uses a columnar schema (one row per entity with JSON columns)
   * combined with an LRU cache and batch checkpointing to minimize row writes.
   */
  export class ColumnarStore<T extends object> {
    protected sql: SqlStorage
    protected schema: SchemaDefinition<T>
    protected cache: WriteBufferCache<T>

    constructor(sql: SqlStorage, schema: SchemaDefinition<T>, options?: ColumnarStoreOptions<T>)

    /** Get the SQL column name for a field */
    getColumnName(field: keyof T): string

    /** Get the field name for a SQL column */
    getFieldName(column: string): keyof T | undefined

    /** Initialize the database schema */
    ensureSchema(): Promise<void>

    /** Get an entity by its primary key */
    get(id: string): Promise<T | null>

    /** Create a new entity */
    create(entity: T): Promise<T>

    /** Update an existing entity */
    update(id: string, updates: Partial<T>): Promise<T | null>

    /** Delete an entity */
    delete(id: string): Promise<boolean>

    /** Force a checkpoint (flush all dirty data to SQLite) */
    checkpoint(trigger?: CheckpointStats['trigger']): Promise<CheckpointStats>

    /** Get cost comparison statistics */
    getCostComparison(): CostComparison

    /** Get cache statistics */
    getCacheStats(): CacheStats

    /** Stop the checkpoint timer */
    stop(): void
  }

  // ============================================================================
  // Cost Analysis Utilities
  // ============================================================================

  /**
   * Calculate cost comparison for a given workload
   */
  export function analyzeWorkloadCost(workload: {
    /** Number of concurrent entities */
    entities: number
    /** Average attributes per entity (env vars, history entries, etc.) */
    attributesPerEntity: number
    /** Average updates per entity per hour */
    updatesPerEntityPerHour: number
    /** Checkpoints per entity per hour (columnar approach) */
    checkpointsPerEntityPerHour: number
    /** Hours of operation per month */
    hoursPerMonth: number
  }): CostComparison

  /**
   * Print a cost comparison report
   */
  export function printCostReport(comparison: CostComparison): string
}
