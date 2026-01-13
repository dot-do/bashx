/**
 * Pipeline Stages Barrel Export
 *
 * Re-exports all pipeline stages for the MCP bash tool.
 * These stages form a composable pipeline:
 *
 * classifyAndGenerate -> parseAndFix -> analyzeSafety -> applyGate -> executeOrBlock -> formatResult
 */

// Stage 1: Classify input and generate command from natural language
export { classifyAndGenerate } from './classify.js'
export type { ClassifyInput, ClassifyResult } from './classify.js'

// Stage 2: Parse command into AST and auto-fix syntax errors
export { parseAndFix } from './parse.js'
export type { ParseInput, ParseResult } from './parse.js'

// Stage 3: Analyze command for safety classification
export { analyzeSafety } from './safety.js'
export type { SafetyInput, SafetyResult } from './safety.js'

// Stage 4: Apply safety gate to block dangerous operations
export { applyGate } from './gate.js'
export type { GateInput, GateResult } from './gate.js'

// Stage 5: Execute command or return blocked result
export { executeOrBlock } from './execute.js'
export type { ExecuteInput, ExecuteResult, ExecuteOptions } from './execute.js'

// Stage 6: Format all stage outputs into final BashResult
export { formatResult } from './format.js'
export type { FormatInput, FormatResult } from './format.js'
