/**
 * @dotdo/bashx - Core Library
 *
 * Pure library for bash command parsing, classification, escaping, and safety analysis.
 * Zero Cloudflare dependencies - works in any JavaScript environment.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import { shellEscape, classifyInput, analyze, ShellBackend } from '@dotdo/bashx'
 *
 * // Escape values for shell interpolation
 * const file = 'my file.txt'
 * const escaped = shellEscape(file)  // => 'my file.txt'
 *
 * // Classify input as command or natural language
 * const result = await classifyInput('ls -la')
 * // { type: 'command', confidence: 0.95, ... }
 *
 * // Analyze AST for safety classification
 * const ast = { type: 'Program', body: [...] }
 * const { classification, intent } = analyze(ast)
 * ```
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
  // AST Types
  BashNode,
  Program,
  List,
  Pipeline,
  Command,
  Subshell,
  CompoundCommand,
  FunctionDef,
  Word,
  Redirect,
  Assignment,
  Expansion,
  ParseError,
  // Intent & Classification Types
  Intent,
  SafetyClassification,
  CommandClassification,
  SafetyAnalysis,
  DangerCheck,
  OperationType,
  ImpactLevel,
  Fix,
} from './types.js'

// ============================================================================
// Backend Interface
// ============================================================================
// Note: ShellResult is exported from RPC instead (see RPC Types below)

export type {
  ShellBackend,
  ShellOptions,
  BackendInfo,
} from './backend.js'

// ============================================================================
// Escape Utilities
// ============================================================================

export {
  shellEscape,
  shellEscapeArg,
  createShellTemplate,
  rawTemplate,
  safeTemplate,
} from './escape/index.js'

// ============================================================================
// Classification
// ============================================================================

export {
  classifyInput,
} from './classify/index.js'

export type {
  InputClassification,
  ClassificationAlternative,
} from './classify/index.js'

// ============================================================================
// AST Utilities
// ============================================================================

export {
  // Type guards
  isProgram,
  isCommand,
  isPipeline,
  isList,
  isWord,
  isRedirect,
  isAssignment,
  isSubshell,
  isCompoundCommand,
  isFunctionDef,
  isExpansion,
  isBashNode,
  getNodeType,
  // Factory functions
  createProgram,
  createCommand,
  createPipeline,
  createList,
  createWord,
  createRedirect,
  createAssignment,
  // Serialization
  serializeAST,
  deserializeAST,
  // Constants
  NodeType,
  NODE_TYPES,
} from './ast/index.js'

// ============================================================================
// Safety Analysis
// ============================================================================

export {
  analyze,
  isDangerous,
  classifyCommand,
  extractIntent,
  extractIntentFromAST,
  describeIntent,
} from './safety/index.js'

export type { ExtendedIntent } from './safety/index.js'

// ============================================================================
// PTY Emulation (Virtual Terminal)
// ============================================================================

export {
  VirtualPTY,
  ANSIParser,
  TerminalBuffer,
  createDefaultAttributes,
  createEmptyCell,
  createDefaultCursor,
} from './pty/index.js'

export type {
  // Core configuration
  VirtualPTYOptions,
  PTYInfo,
  // Screen buffer types
  ScreenBuffer,
  Cell,
  CellAttributes,
  CursorState,
  Color,
  ColorCode,
  RGBColor,
  // Parser types
  ParserState,
  ParsedSequence,
  // Event types
  PTYEvent,
  ScreenChangeEvent,
  BellEvent,
  TitleChangeEvent,
  // Callback types
  DataCallback,
  ScreenChangeCallback,
  SequenceCallback,
  EventCallback,
} from './pty/index.js'

// ============================================================================
// RPC Types (Remote Shell Execution)
// ============================================================================

export type {
  ShellResult,
  ShellExecOptions,
  ShellSpawnOptions,
  ShellStream,
  ShellApi,
  ShellDataCallback,
  ShellExitCallback,
} from './rpc/index.js'
