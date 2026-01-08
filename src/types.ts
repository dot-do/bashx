/**
 * bashx.do Type Definitions
 *
 * Single tool architecture: ONE tool called 'bash' with AST-based validation
 */

// ============================================================================
// AST Types (tree-sitter-bash compatible)
// ============================================================================

export type BashNode =
  | Program
  | List
  | Pipeline
  | Command
  | Subshell
  | CompoundCommand
  | FunctionDef
  | Word
  | Redirect
  | Assignment

export interface Program {
  type: 'Program'
  body: BashNode[]
  errors?: ParseError[]
}

export interface List {
  type: 'List'
  operator: '&&' | '||' | ';' | '&'
  left: BashNode
  right: BashNode
}

export interface Pipeline {
  type: 'Pipeline'
  negated: boolean
  commands: Command[]
}

export interface Command {
  type: 'Command'
  name: Word | null
  prefix: Assignment[]
  args: Word[]
  redirects: Redirect[]
}

export interface Subshell {
  type: 'Subshell'
  body: BashNode[]
}

export interface CompoundCommand {
  type: 'CompoundCommand'
  kind: 'if' | 'for' | 'while' | 'until' | 'case' | 'select' | 'brace' | 'arithmetic'
  body: BashNode[]
}

export interface FunctionDef {
  type: 'FunctionDef'
  name: string
  body: BashNode
}

export interface Word {
  type: 'Word'
  value: string
  quoted?: 'single' | 'double' | 'ansi-c' | 'locale'
  expansions?: Expansion[]
}

export interface Expansion {
  type: 'ParameterExpansion' | 'CommandSubstitution' | 'ArithmeticExpansion' | 'ProcessSubstitution'
  start: number
  end: number
  content: string | BashNode[]
}

export interface Redirect {
  type: 'Redirect'
  op: '>' | '>>' | '<' | '<<' | '<<<' | '>&' | '<&' | '<>' | '>|'
  fd?: number
  target: Word
}

export interface Assignment {
  type: 'Assignment'
  name: string
  value: Word | null
  operator: '=' | '+='
}

export interface ParseError {
  message: string
  line: number
  column: number
  suggestion?: string
}

// ============================================================================
// Safety & Classification Types
// ============================================================================

export interface CommandClassification {
  type: 'read' | 'write' | 'delete' | 'execute' | 'network' | 'system' | 'mixed'
  impact: 'none' | 'low' | 'medium' | 'high' | 'critical'
  reversible: boolean
  reason: string
}

export interface Intent {
  commands: string[]
  reads: string[]
  writes: string[]
  deletes: string[]
  network: boolean
  elevated: boolean
}

export interface Fix {
  type: 'insert' | 'replace' | 'delete'
  position: number | 'start' | 'end'
  value?: string
  reason: string
}

// ============================================================================
// Result Type
// ============================================================================

export interface BashResult {
  // Input
  input: string

  // AST Analysis
  ast?: Program
  valid: boolean
  errors?: ParseError[]
  fixed?: {
    command: string
    changes: Fix[]
  }

  // Semantic Understanding
  intent: Intent

  // Safety Classification
  classification: CommandClassification

  // Execution
  command: string
  generated: boolean
  stdout: string
  stderr: string
  exitCode: number

  // Safety Gate
  blocked?: boolean
  requiresConfirm?: boolean
  blockReason?: string

  // Recovery
  undo?: string
  suggestions?: string[]
}

// ============================================================================
// Client Types
// ============================================================================

export interface BashOptions {
  confirm?: boolean
  dryRun?: boolean
  timeout?: number
  cwd?: string
}

export interface BashClient {
  (input: string, options?: BashOptions): Promise<BashResult>
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<BashResult>
}

// ============================================================================
// MCP Tool Type
// ============================================================================

export interface BashMcpTool {
  name: 'bash'
  description: string
  inputSchema: {
    type: 'object'
    properties: {
      input: { type: 'string'; description: string }
      confirm: { type: 'boolean'; description: string }
    }
    required: ['input']
  }
}
