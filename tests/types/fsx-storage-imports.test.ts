/**
 * fsx.do/storage Type Import Tests (RED Phase)
 *
 * Tests that verify type imports from fsx.do/storage work correctly.
 * These tests are in the RED phase - they document the expected type exports
 * that should be available from fsx.do/storage but currently aren't.
 *
 * Expected exports from fsx.do/storage (based on bashx/src/storage/columnar-store.ts):
 *
 * Classes:
 *   - WriteBufferCache - Write buffer cache for batching writes
 *   - ColumnarStore - Generic columnar store with write buffering
 *
 * Types:
 *   - WriteBufferCacheOptions - Configuration for write buffer cache
 *   - EvictionReason - Reason for cache eviction
 *   - CacheStats - Cache statistics
 *   - ColumnType - Type of column (text, integer, real, blob, json, datetime)
 *   - ColumnDefinition - Definition for a column in the schema
 *   - SchemaDefinition - Full schema definition for a table
 *   - CheckpointTriggers - Triggers for when to checkpoint
 *   - ColumnarStoreOptions - Configuration for columnar store
 *   - CheckpointStats - Statistics from checkpointing
 *   - CostComparison - Cost comparison between storage strategies
 *
 * Functions:
 *   - analyzeWorkloadCost - Analyze storage costs for a workload
 *   - printCostReport - Print a formatted cost report
 *
 * Current state (fsx.do/storage actual exports):
 *   - TieredFS, TieredFSConfig
 *   - R2Storage, R2StorageConfig
 *   - SQLiteMetadata
 *   - TieredR2Storage and related types
 *   - ContentAddressableFS and CAS types
 *   - Hash utilities (sha1, sha256, etc.)
 *   - Compression utilities
 *
 * The imports below SHOULD work but currently FAIL because fsx.do/storage
 * does not export these columnar storage types.
 *
 * @module tests/types/fsx-storage-imports
 */

import { describe, it, expect } from 'vitest'

// ============================================================================
// Type imports that SHOULD work from fsx.do/storage
// These imports will cause TypeScript compilation errors until the types
// are properly exported from the fsx.do package.
// ============================================================================

// Class imports - these are needed for bashx storage module
import {
  WriteBufferCache,
  ColumnarStore,
} from 'fsx.do/storage'

// Type imports - schema definition types
import type {
  ColumnType,
  ColumnDefinition,
  SchemaDefinition,
} from 'fsx.do/storage'

// Type imports - cache types
import type {
  WriteBufferCacheOptions,
  EvictionReason,
  CacheStats,
} from 'fsx.do/storage'

// Type imports - store options and stats
import type {
  CheckpointTriggers,
  ColumnarStoreOptions,
  CheckpointStats,
  CostComparison,
} from 'fsx.do/storage'

// Function imports - cost analysis utilities
import {
  analyzeWorkloadCost,
  printCostReport,
} from 'fsx.do/storage'

// ============================================================================
// Tests verifying the type exports work correctly
// ============================================================================

describe('fsx.do/storage type exports', () => {
  describe('WriteBufferCache', () => {
    it('should be exported as a class constructor', () => {
      expect(WriteBufferCache).toBeDefined()
      expect(typeof WriteBufferCache).toBe('function')
    })

    it('should accept WriteBufferCacheOptions in constructor', () => {
      const options: WriteBufferCacheOptions = {
        maxSize: 1000,
        maxAge: 60000,
      }
      expect(options.maxSize).toBe(1000)
    })
  })

  describe('ColumnarStore', () => {
    it('should be exported as a class constructor', () => {
      expect(ColumnarStore).toBeDefined()
      expect(typeof ColumnarStore).toBe('function')
    })

    it('should be generic over record type', () => {
      // Type-level test: ColumnarStore<T> should work with any record type
      type TestRecord = {
        id: string
        name: string
        value: number
      }

      // This is a type assertion test - if it compiles, the generic works
      type TestStore = typeof ColumnarStore<TestRecord>
      const _typeCheck: TestStore = ColumnarStore
      expect(_typeCheck).toBeDefined()
    })
  })

  describe('Schema types', () => {
    it('should export ColumnType union type', () => {
      // ColumnType should be a union of valid column types
      const textType: ColumnType = 'text'
      const intType: ColumnType = 'integer'
      const realType: ColumnType = 'real'
      const blobType: ColumnType = 'blob'
      const jsonType: ColumnType = 'json'
      const datetimeType: ColumnType = 'datetime'

      expect(textType).toBe('text')
      expect(intType).toBe('integer')
      expect(realType).toBe('real')
      expect(blobType).toBe('blob')
      expect(jsonType).toBe('json')
      expect(datetimeType).toBe('datetime')
    })

    it('should export ColumnDefinition type', () => {
      const column: ColumnDefinition = {
        type: 'text',
        required: true,
        defaultValue: "'default'",
      }
      expect(column.type).toBe('text')
      expect(column.required).toBe(true)
    })

    it('should export SchemaDefinition type', () => {
      type TestRecord = {
        id: string
        name: string
        createdAt: Date
        updatedAt: Date
        version: number
      }

      const schema: SchemaDefinition<TestRecord> = {
        tableName: 'test_table',
        primaryKey: 'id',
        versionField: 'version',
        updatedAtField: 'updatedAt',
        createdAtField: 'createdAt',
        columns: {
          id: { type: 'text', required: true },
          name: { type: 'text', required: true },
          createdAt: { type: 'datetime', column: 'created_at', required: true },
          updatedAt: { type: 'datetime', column: 'updated_at', required: true },
          version: { type: 'integer', defaultValue: '1', required: true },
        },
      }

      expect(schema.tableName).toBe('test_table')
      expect(schema.primaryKey).toBe('id')
    })
  })

  describe('Cache types', () => {
    it('should export EvictionReason type', () => {
      const sizeReason: EvictionReason = 'size'
      const ageReason: EvictionReason = 'age'
      const manualReason: EvictionReason = 'manual'

      expect(sizeReason).toBe('size')
      expect(ageReason).toBe('age')
      expect(manualReason).toBe('manual')
    })

    it('should export CacheStats type', () => {
      const stats: CacheStats = {
        hits: 100,
        misses: 10,
        evictions: 5,
        size: 50,
        maxSize: 100,
      }

      expect(stats.hits).toBe(100)
      expect(stats.misses).toBe(10)
    })
  })

  describe('Store options types', () => {
    it('should export CheckpointTriggers type', () => {
      const triggers: CheckpointTriggers = {
        afterWrites: 100,
        afterMs: 60000,
        onShutdown: true,
      }

      expect(triggers.afterWrites).toBe(100)
    })

    it('should export ColumnarStoreOptions type', () => {
      type TestRecord = { id: string; name: string }

      const options: ColumnarStoreOptions<TestRecord> = {
        checkpointTriggers: {
          afterWrites: 50,
          afterMs: 30000,
        },
      }

      expect(options.checkpointTriggers?.afterWrites).toBe(50)
    })

    it('should export CheckpointStats type', () => {
      const stats: CheckpointStats = {
        rowsCheckpointed: 100,
        bytesWritten: 50000,
        durationMs: 150,
      }

      expect(stats.rowsCheckpointed).toBe(100)
    })

    it('should export CostComparison type', () => {
      const comparison: CostComparison = {
        columnar: {
          reads: 100,
          writes: 50,
          totalCost: 150,
        },
        normalized: {
          reads: 500,
          writes: 250,
          totalCost: 750,
        },
        savings: 600,
        savingsPercent: 80,
      }

      expect(comparison.savings).toBe(600)
      expect(comparison.savingsPercent).toBe(80)
    })
  })

  describe('Cost analysis functions', () => {
    it('should export analyzeWorkloadCost function', () => {
      expect(analyzeWorkloadCost).toBeDefined()
      expect(typeof analyzeWorkloadCost).toBe('function')
    })

    it('should export printCostReport function', () => {
      expect(printCostReport).toBeDefined()
      expect(typeof printCostReport).toBe('function')
    })
  })
})

// ============================================================================
// Integration test: Verify types work together correctly
// ============================================================================

describe('fsx.do/storage type integration', () => {
  it('should allow creating a schema and using it with ColumnarStore', () => {
    // This test verifies that all the types work together correctly
    type SessionData = {
      id: string
      userId: string
      data: Record<string, unknown>
      createdAt: Date
      updatedAt: Date
      version: number
    }

    const schema: SchemaDefinition<SessionData> = {
      tableName: 'sessions',
      primaryKey: 'id',
      versionField: 'version',
      updatedAtField: 'updatedAt',
      createdAtField: 'createdAt',
      columns: {
        id: { type: 'text', required: true },
        userId: { type: 'text', column: 'user_id', required: true },
        data: { type: 'json', defaultValue: "'{}'" },
        createdAt: { type: 'datetime', column: 'created_at', required: true },
        updatedAt: { type: 'datetime', column: 'updated_at', required: true },
        version: { type: 'integer', defaultValue: '1', required: true },
      },
    }

    const options: ColumnarStoreOptions<SessionData> = {
      checkpointTriggers: {
        afterWrites: 100,
        afterMs: 60000,
        onShutdown: true,
      },
    }

    // Type checks - these verify the types are correctly defined
    expect(schema.tableName).toBe('sessions')
    expect(options.checkpointTriggers?.afterWrites).toBe(100)
  })

  it('should allow WriteBufferCache to be configured with correct options', () => {
    const cacheOptions: WriteBufferCacheOptions = {
      maxSize: 1000,
      maxAge: 60000,
      onEvict: (key: string, reason: EvictionReason) => {
        console.log(`Evicted ${key} due to ${reason}`)
      },
    }

    expect(cacheOptions.maxSize).toBe(1000)
    expect(cacheOptions.maxAge).toBe(60000)
    expect(typeof cacheOptions.onEvict).toBe('function')
  })
})
