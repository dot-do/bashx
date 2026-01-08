/**
 * bashx.do Type Definitions
 * AI-enhanced bash execution with safety, intent understanding, and intelligent recovery
 */

import type { TaggedTemplate, ClientOptions } from 'rpc.do'
import type { McpTool } from 'mcp.do'

// ============================================================================
// Core Types
// ============================================================================

/**
 * Result of any bashx operation
 */
export interface BashxResult {
  success: boolean
  stdout?: string
  stderr?: string
  exitCode?: number
  command?: string
  dryRun?: boolean
  explanation?: string
  error?: BashxError
  metadata?: ResultMetadata
}

export interface ResultMetadata {
  duration?: number
  startedAt?: string
  completedAt?: string
  attempts?: number
  recovered?: boolean
  recoveryStrategy?: string
}

export interface BashxError {
  code: string
  message: string
  category: ErrorCategory
  recoverable: boolean
  suggestions?: string[]
}

export type ErrorCategory =
  | 'permission_denied'
  | 'not_found'
  | 'disk_full'
  | 'network_timeout'
  | 'syntax_error'
  | 'command_not_found'
  | 'argument_error'
  | 'resource_busy'
  | 'unknown'

// ============================================================================
// Safety Types
// ============================================================================

/**
 * Classification of a command's safety characteristics
 */
export interface CommandClassification {
  type: CommandType
  reversible: boolean
  scope: CommandScope
  impact: ImpactLevel
  requires: SafetyRequirement[]
  confidence: number
}

export type CommandType =
  | 'read'      // Only reads data (ls, cat, grep)
  | 'write'     // Creates or modifies files
  | 'delete'    // Removes data
  | 'execute'   // Runs programs
  | 'network'   // Network operations
  | 'system'    // System-level operations
  | 'mixed'     // Multiple types combined

export type CommandScope =
  | 'file'       // Single file operation
  | 'directory'  // Directory operation
  | 'tree'       // Recursive directory operation
  | 'system'     // System-wide
  | 'network'    // External network
  | 'global'     // Affects everything

export type ImpactLevel =
  | 'none'       // No side effects (pure read)
  | 'low'        // Easily reversible
  | 'medium'     // Reversible with effort
  | 'high'       // Difficult to reverse
  | 'critical'   // Irreversible or dangerous

export type SafetyRequirement =
  | 'confirmation'  // User must confirm
  | 'backup'        // Create backup first
  | 'dryrun'        // Show what would happen
  | 'sudo'          // Requires elevation
  | 'audit'         // Log for audit trail

/**
 * Detailed safety analysis report
 */
export interface SafetyReport {
  safe: boolean
  classification: CommandClassification
  risks: Risk[]
  recommendations: string[]
  alternatives?: AlternativeCommand[]
}

export interface Risk {
  severity: 'low' | 'medium' | 'high' | 'critical'
  description: string
  mitigation?: string
}

export interface AlternativeCommand {
  command: string
  description: string
  saferBecause: string
}

export interface SafetyContext {
  cwd?: string
  user?: string
  environment?: Record<string, string>
  recentCommands?: string[]
  gitStatus?: { dirty: boolean; branch: string }
}

// ============================================================================
// Execution Types
// ============================================================================

export interface RunOptions {
  cmd: string
  intent?: string
  cwd?: string
  env?: Record<string, string>
  timeout?: number
  require?: {
    safe?: boolean
    reversible?: boolean
    maxImpact?: ImpactLevel
  }
  dryRun?: boolean
  recover?: boolean
  maxAttempts?: number
}

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  timeout?: number
  shell?: string
  recover?: boolean
  maxAttempts?: number
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export interface ExecResult extends BashxResult {
  pid?: number
  signal?: string
  timedOut?: boolean
}

// ============================================================================
// Generation Types
// ============================================================================

export interface GenerateContext {
  cwd?: string
  platform?: 'darwin' | 'linux' | 'windows'
  shell?: 'bash' | 'zsh' | 'sh' | 'fish' | 'powershell'
  availableCommands?: string[]
  installedPackages?: string[]
  projectType?: string
  gitStatus?: { dirty: boolean; branch: string }
}

export interface GeneratedCommand {
  command: string
  explanation: string
  classification: CommandClassification
  alternatives?: AlternativeCommand[]
  warnings?: string[]
}

// ============================================================================
// Explanation Types
// ============================================================================

export interface Explanation {
  command: string
  summary: string
  breakdown: CommandBreakdown[]
  classification: CommandClassification
  sideEffects: string[]
  examples?: string[]
  documentation?: string
  manPage?: string
}

export interface CommandBreakdown {
  part: string
  type: 'command' | 'flag' | 'argument' | 'operator' | 'redirect' | 'pipe'
  explanation: string
}

// ============================================================================
// Pipe Types
// ============================================================================

export type PipeStep =
  | string                              // Raw command
  | { cmd: string; transform?: boolean } // Command with AI transform
  | ((input: string) => string | Promise<string>) // Transform function

export interface PipeResult extends BashxResult {
  steps: PipeStepResult[]
}

export interface PipeStepResult {
  step: number
  command: string
  stdout: string
  stderr: string
  exitCode: number
  duration: number
}

// ============================================================================
// Client Types
// ============================================================================

export interface DoOptions {
  model?: string
  context?: GenerateContext
  safe?: boolean
  dryRun?: boolean
}

/**
 * Main bashx client interface
 */
export interface BashxClient {
  // Tagged template - natural language to command
  do: TaggedTemplate<Promise<BashxResult>>

  // Direct execution with intent
  run(options: RunOptions): Promise<BashxResult>

  // Explain what a command does
  explain(cmd: string): Promise<Explanation>

  // Safety analysis
  safe(cmd: string, context?: SafetyContext): Promise<SafetyReport>

  // Generate command from intent
  generate(intent: string, context?: GenerateContext): Promise<GeneratedCommand>

  // Execute with automatic recovery
  exec(cmd: string, options?: ExecOptions): Promise<ExecResult>

  // Pipe chains with AI understanding
  pipe(...steps: PipeStep[]): Promise<PipeResult>

  // Dry run - show what would happen
  dryRun(cmd: string): Promise<BashxResult>

  // Undo last command (if reversible)
  undo(): Promise<BashxResult>

  // Parse command output with schema
  parse<T>(output: string, schema: Record<string, string>): Promise<T>

  // Fix broken command
  fix(cmd: string, error: string): Promise<GeneratedCommand>

  // Get command history
  history(options?: { limit?: number; filter?: string }): Promise<HistoryEntry[]>

  // MCP integration
  listTools(): Promise<McpTool[]>
  invokeTool(name: string, params: Record<string, unknown>): Promise<BashxResult>
}

export interface HistoryEntry {
  command: string
  timestamp: string
  exitCode: number
  duration: number
  cwd: string
}

// ============================================================================
// MCP Types
// ============================================================================

export interface BashxMcpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export type BashxToolName =
  | 'bash_run'
  | 'bash_explain'
  | 'bash_safe'
  | 'bash_generate'
  | 'bash_dry_run'
  | 'bash_pipe'
  | 'bash_parse'
  | 'bash_env'
  | 'bash_history'
  | 'bash_alias'
  | 'bash_which'
  | 'bash_man'
  | 'bash_complete'
  | 'bash_fix'
  | 'bash_optimize'
  | 'bash_undo'
  | 'bash_script'
  | 'bash_cron'

// ============================================================================
// Recovery Types
// ============================================================================

export interface RecoveryStrategy {
  errorPattern: RegExp | string
  category: ErrorCategory
  actions: RecoveryAction[]
}

export type RecoveryAction =
  | { type: 'retry'; delay?: number }
  | { type: 'sudo' }
  | { type: 'create_directory'; path: string }
  | { type: 'install_package'; package: string }
  | { type: 'cleanup'; path: string }
  | { type: 'alternative'; command: string }
  | { type: 'ask_user'; message: string }
