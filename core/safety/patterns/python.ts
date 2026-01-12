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

/**
 * A detected safety pattern in Python code.
 */
export interface DetectedPattern {
  /** Pattern type identifier (e.g., 'eval', 'system', 'pickle') */
  type: string
  /** Impact level of the pattern */
  impact: 'low' | 'medium' | 'high' | 'critical'
  /** The matched code snippet */
  match?: string
}

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
 * Pattern definition for Python safety analysis.
 */
interface PatternDefinition {
  /** Pattern type identifier */
  type: string
  /** Regex pattern to match */
  pattern: RegExp
  /** Impact level */
  impact: 'low' | 'medium' | 'high' | 'critical'
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
 * Impact level ordering from lowest to highest severity.
 */
const IMPACT_ORDER: Array<'low' | 'medium' | 'high' | 'critical'> = [
  'low',
  'medium',
  'high',
  'critical',
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
 * Builds a human-readable reason string from detected patterns.
 */
function buildReason(patterns: DetectedPattern[]): string {
  if (patterns.length === 0) {
    return 'No dangerous patterns detected'
  }

  const patternNames = patterns.map((p) => p.type)
  const uniqueNames = [...new Set(patternNames)]

  if (uniqueNames.length === 1) {
    return `Detected ${uniqueNames[0]} pattern`
  }

  return `Detected patterns: ${uniqueNames.join(', ')}`
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
  const patterns: DetectedPattern[] = []
  const imports: string[] = []

  // Extract imports (both 'import x' and 'from x import y' forms)
  const importMatches = code.matchAll(/^(?:import|from)\s+([\w.]+)/gm)
  for (const match of importMatches) {
    imports.push(match[1])
  }

  // Check patterns
  for (const p of PYTHON_PATTERNS) {
    const matchResult = code.match(p.pattern)
    if (matchResult) {
      patterns.push({
        type: p.type,
        impact: p.impact,
        match: matchResult[0],
      })
    }
  }

  // Determine max impact level
  const maxImpact: 'low' | 'medium' | 'high' | 'critical' =
    patterns.length > 0
      ? patterns.reduce((max, p) => {
          return IMPACT_ORDER.indexOf(p.impact) > IMPACT_ORDER.indexOf(max)
            ? p.impact
            : max
        }, 'low' as 'low' | 'medium' | 'high' | 'critical')
      : 'low'

  // Determine classification type
  const type = determineType(patterns)

  return {
    classification: {
      type,
      impact: maxImpact,
      reversible: false,
      reason: buildReason(patterns),
    },
    patterns,
    imports,
    hasInlineCode: code.includes('-c'),
  }
}
