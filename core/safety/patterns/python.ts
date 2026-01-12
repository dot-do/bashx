/**
 * Python Safety Pattern Detection
 *
 * Detects dangerous patterns in Python code including:
 * - eval/exec code execution
 * - os.system/subprocess system calls
 * - pickle deserialization attacks
 * - __import__ injection
 * - Dangerous file operations
 *
 * @packageDocumentation
 */

import type { SafetyClassification } from '../../types.js'
import {
  type DetectedPattern,
  type PatternDefinition,
  detectPatterns,
  getHighestImpact,
  buildReasonString,
} from './shared.js'

// Re-export DetectedPattern for backwards compatibility
export type { DetectedPattern }

/**
 * Result of Python safety analysis.
 */
export interface PythonSafetyAnalysis {
  /** Overall safety classification */
  classification: SafetyClassification
  /** List of detected patterns */
  patterns: DetectedPattern[]
  /** List of detected imports */
  imports: string[]
  /** Whether the code contains inline execution (-c flag) */
  hasInlineCode: boolean
}

/**
 * Python safety patterns to detect.
 * Ordered by severity (critical patterns first).
 */
const PYTHON_PATTERNS: PatternDefinition[] = [
  // Code eval - critical
  { type: 'eval', pattern: /\beval\s*\(/, impact: 'critical' },
  { type: 'exec', pattern: /\bexec\s*\(/, impact: 'critical' },

  // Code compile - high
  { type: 'compile', pattern: /\bcompile\s*\(/, impact: 'high' },

  // System execution - high
  { type: 'system', pattern: /\bos\.system\s*\(/, impact: 'high' },
  { type: 'subprocess', pattern: /\bsubprocess\.\w+\s*\(/, impact: 'high' },
  { type: 'popen', pattern: /\bos\.popen\s*\(/, impact: 'high' },

  // Pickle/imports - high
  { type: 'pickle', pattern: /\bpickle\.(load|loads)\s*\(/, impact: 'high' },
  { type: 'import_injection', pattern: /__import__\s*\(/, impact: 'high' },

  // File operations - medium
  { type: 'file_write', pattern: /\bopen\s*\([^)]*,\s*['"][wa]/, impact: 'medium' },
]

/**
 * Determines the classification type based on detected patterns.
 */
function determineType(
  patterns: DetectedPattern[]
): SafetyClassification['type'] {
  if (patterns.length === 0) {
    return 'read'
  }

  // Check for system execution patterns
  const systemTypes = ['system', 'subprocess', 'popen']
  if (patterns.some((p) => systemTypes.includes(p.type))) {
    return 'system'
  }

  // Check for code execution patterns
  const executeTypes = ['eval', 'exec', 'compile', 'import_injection']
  if (patterns.some((p) => executeTypes.includes(p.type))) {
    return 'execute'
  }

  // Check for file write patterns
  if (patterns.some((p) => p.type === 'file_write')) {
    return 'write'
  }

  // Check for pickle (deserialization can execute code)
  if (patterns.some((p) => p.type === 'pickle')) {
    return 'execute'
  }

  return 'read'
}

/**
 * Analyzes Python code for safety patterns.
 *
 * Detects dangerous operations such as:
 * - eval() and exec() for arbitrary code execution
 * - os.system(), subprocess.run(), subprocess.Popen() for shell commands
 * - pickle.load() and pickle.loads() for deserialization attacks
 * - __import__() for dynamic import injection
 * - File operations with write modes
 *
 * @param code - The Python code to analyze
 * @returns Safety analysis result with classification and detected patterns
 *
 * @example
 * ```typescript
 * const result = analyzePythonSafety('eval(user_input)')
 * // Returns: { classification: { impact: 'critical', ... }, patterns: [...] }
 * ```
 */
export function analyzePythonSafety(code: string): PythonSafetyAnalysis {
  const imports: string[] = []

  // Extract imports (both 'import x' and 'from x import y' forms)
  const importMatches = code.matchAll(/^(?:import|from)\s+([\w.]+)/gm)
  for (const match of importMatches) {
    imports.push(match[1])
  }

  // Detect patterns using shared utility
  const patterns = detectPatterns(code, PYTHON_PATTERNS)

  // Determine max impact level using shared utility
  const maxImpact = getHighestImpact(patterns)

  // Determine classification type
  const type = determineType(patterns)

  return {
    classification: {
      type,
      impact: maxImpact,
      reversible: false,
      reason: buildReasonString(patterns),
    },
    patterns,
    imports,
    hasInlineCode: code.includes('-c'),
  }
}
