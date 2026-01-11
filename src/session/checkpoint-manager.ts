/**
 * Checkpoint Manager
 *
 * Manages automatic and manual checkpointing of session state to R2.
 * Implements the Iceberg pattern: recent ops in DO SQLite (WAL),
 * checkpoints in R2 for durability.
 *
 * @module bashx/session/checkpoint-manager
 */

import type {
  SessionState,
  SessionId,
  Checkpoint,
  CheckpointType,
  CheckpointConfig,
  CheckpointStorage,
  WALStorage,
  WALEntry,
  SessionRef,
} from './types.js'

// ============================================================================
// Checkpoint Manager
// ============================================================================

/**
 * Manages session checkpointing to R2 storage.
 *
 * Responsibilities:
 * - Track pending operations since last checkpoint
 * - Auto-checkpoint on idle or threshold
 * - Create checkpoints on fork/branch/manual
 * - Manage HEAD reference updates
 */
export class CheckpointManager {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingOps: number = 0
  private lastCheckpoint: number = Date.now()
  private latestCheckpointHash: string | null = null

  constructor(
    private sessionId: SessionId,
    private config: CheckpointConfig,
    private checkpointStorage: CheckpointStorage,
    private walStorage: WALStorage,
    private getTreeHash: () => Promise<string>
  ) {}

  /**
   * Called after each operation to potentially trigger checkpoint.
   */
  async onOperation(entry: WALEntry): Promise<void> {
    // Record in WAL
    await this.walStorage.append(this.sessionId, entry)

    this.pendingOps++

    // Reset idle timer
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(
      () => this.checkpointIfNeeded('idle'),
      this.config.idleTimeout * 1000
    )

    // Check command threshold
    if (this.pendingOps >= this.config.commandThreshold) {
      await this.checkpoint('auto', 'Automatic checkpoint (threshold)')
    }
  }

  /**
   * Check if checkpoint is needed and create one if so.
   */
  private async checkpointIfNeeded(reason: 'idle'): Promise<void> {
    const now = Date.now()

    // Enforce minimum interval
    if (now - this.lastCheckpoint < this.config.minInterval * 1000) {
      return
    }

    if (this.pendingOps > 0) {
      await this.checkpoint('auto', `Automatic checkpoint (${reason})`)
    }
  }

  /**
   * Create a checkpoint of current session state.
   */
  async checkpoint(
    type: CheckpointType,
    message?: string,
    state?: SessionState
  ): Promise<Checkpoint> {
    const now = Date.now()

    // Get current tree hash from filesystem
    const treeHash = await this.getTreeHash()

    // Build checkpoint
    const checkpoint: Checkpoint = {
      hash: '', // Will be computed
      state: state || await this.buildCurrentState(treeHash),
      parentHash: this.latestCheckpointHash,
      type,
      message,
      r2Key: '', // Will be set
      size: 0,
      compression: 'gzip',
    }

    // Compute content hash
    checkpoint.hash = await this.computeCheckpointHash(checkpoint)
    checkpoint.r2Key = `checkpoints/${checkpoint.hash}`

    // Serialize and store
    const serialized = JSON.stringify(checkpoint)
    checkpoint.size = serialized.length

    await this.checkpointStorage.putCheckpoint(checkpoint)

    // Update HEAD reference
    const headRef: SessionRef = {
      name: `sessions/${this.sessionId}/HEAD`,
      checkpointHash: checkpoint.hash,
      type: 'head',
      sessionId: this.sessionId,
      updatedAt: now,
    }
    await this.checkpointStorage.putRef(headRef)

    // Mark WAL entries as checkpointed
    const latestSeq = await this.walStorage.getLatestSeq(this.sessionId)
    await this.walStorage.markCheckpointed(this.sessionId, latestSeq)

    // Update local state
    this.pendingOps = 0
    this.lastCheckpoint = now
    this.latestCheckpointHash = checkpoint.hash

    return checkpoint
  }

  /**
   * Build current session state from WAL and last checkpoint.
   */
  private async buildCurrentState(treeHash: string): Promise<SessionState> {
    // This is a placeholder - in real implementation,
    // we'd reconstruct state from the last checkpoint + WAL entries
    throw new Error('buildCurrentState not yet implemented')
  }

  /**
   * Compute content hash for a checkpoint.
   */
  private async computeCheckpointHash(checkpoint: Omit<Checkpoint, 'hash'>): Promise<string> {
    const content = JSON.stringify({
      state: checkpoint.state,
      parentHash: checkpoint.parentHash,
      type: checkpoint.type,
    })

    // Use SubtleCrypto for SHA-1 (or SHA-256)
    const encoder = new TextEncoder()
    const data = encoder.encode(content)
    const hashBuffer = await crypto.subtle.digest('SHA-1', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  }

  /**
   * Get the latest checkpoint for this session.
   */
  async getLatestCheckpoint(): Promise<Checkpoint | null> {
    if (this.latestCheckpointHash) {
      return this.checkpointStorage.getCheckpoint(this.latestCheckpointHash)
    }

    // Try to load from HEAD ref
    const headRef = await this.checkpointStorage.getRef(
      `sessions/${this.sessionId}/HEAD`
    )
    if (headRef) {
      this.latestCheckpointHash = headRef.checkpointHash
      return this.checkpointStorage.getCheckpoint(headRef.checkpointHash)
    }

    return null
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
