/**
 * Math & Control Commands
 *
 * Native implementations for math and control flow commands:
 * - bc: arbitrary precision calculator
 * - expr: expression evaluator
 * - seq: sequence generator
 * - shuf: shuffle/randomize
 * - sleep: delay execution
 * - timeout: run with time limit
 *
 * @module bashx/do/commands/math-control
 */

// ============================================================================
// HELPER UTILITIES
// ============================================================================

/**
 * Parse a duration string into milliseconds
 * Supports: s (seconds), m (minutes), h (hours), d (days)
 * No suffix means seconds
 */
export function parseDuration(duration: string): number {
  if (duration === 'infinity') {
    return Infinity
  }

  const match = duration.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/)
  if (!match) {
    throw new Error(`Invalid duration: ${duration}`)
  }

  const value = parseFloat(match[1])
  const unit = match[2] || 's'

  switch (unit) {
    case 's':
      return value * 1000
    case 'm':
      return value * 60 * 1000
    case 'h':
      return value * 60 * 60 * 1000
    case 'd':
      return value * 24 * 60 * 60 * 1000
    default:
      return value * 1000
  }
}

/**
 * Simple sprintf implementation for seq format strings
 */
function sprintf(format: string, value: number): string {
  // Handle %g, %f, %e formats
  return format.replace(/%(\d+)?(?:\.(\d+))?(g|f|e)/, (_, width, precision, type) => {
    let result: string
    const prec = precision !== undefined ? parseInt(precision, 10) : undefined

    switch (type) {
      case 'f':
        result = prec !== undefined ? value.toFixed(prec) : String(value)
        break
      case 'e': {
        let expStr = prec !== undefined ? value.toExponential(prec) : value.toExponential()
        // Ensure exponent has at least 2 digits (e+03 not e+3)
        result = expStr.replace(/e([+-])(\d)$/, 'e$10$2')
        break
      }
      case 'g':
      default:
        if (prec !== undefined) {
          // For %g with precision, format as needed
          result = value.toPrecision(prec).replace(/\.?0+$/, '')
        } else {
          result = String(value)
        }
        // Pad with zeros if width specified
        if (width) {
          const w = parseInt(width, 10)
          result = result.padStart(w, '0')
        }
        break
    }

    return result
  }).replace(/%%/g, '%')
}

// ============================================================================
// BC - ARBITRARY PRECISION CALCULATOR
// ============================================================================

interface BcContext {
  scale: number
  ibase: number
  obase: number
  variables: Map<string, number>
  mathLib: boolean
}

/**
 * Execute bc expression
 *
 * @param expression - The bc expression to evaluate
 * @param options - Options including math library flag
 * @returns Result object with result string or error
 */
export function executeBc(
  expression: string,
  options: { mathLib?: boolean } = {}
): { result: string; exitCode: number; stderr: string } {
  const context: BcContext = {
    scale: options.mathLib ? 20 : 0,
    ibase: 10,
    obase: 10,
    variables: new Map(),
    mathLib: options.mathLib ?? false,
  }

  try {
    // Split by semicolons or newlines
    const lines = expression
      .split(/[;\n]/)
      .map(l => l.trim())
      .filter(l => l.length > 0)

    const results: string[] = []

    for (const line of lines) {
      // Handle scale setting
      if (line.startsWith('scale=')) {
        context.scale = parseInt(line.slice(6), 10)
        continue
      }

      // Handle ibase setting
      if (line.startsWith('ibase=')) {
        context.ibase = parseInt(line.slice(6), 10)
        continue
      }

      // Handle obase setting - must be parsed BEFORE ibase changes affect it
      if (line.startsWith('obase=')) {
        context.obase = parseInt(line.slice(6), 10)
        continue
      }

      // Handle variable assignment
      const assignMatch = line.match(/^([a-z_][a-z0-9_]*)=(.+)$/i)
      if (assignMatch) {
        const [, varName, expr] = assignMatch
        const value = evaluateBcExpression(expr, context)
        context.variables.set(varName, value)
        continue
      }

      // Evaluate expression and collect result
      const value = evaluateBcExpression(line, context)
      results.push(formatBcOutput(value, context))
    }

    return {
      result: results.join('\n'),
      exitCode: 0,
      stderr: '',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      result: '',
      exitCode: 1,
      stderr: `bc: ${message}`,
    }
  }
}

/**
 * Evaluate a bc expression
 */
function evaluateBcExpression(expr: string, context: BcContext): number {
  // Replace variable references
  let processedExpr = expr
  for (const [name, value] of context.variables) {
    processedExpr = processedExpr.replace(new RegExp(`\\b${name}\\b`, 'g'), String(value))
  }

  // Handle math library functions
  if (context.mathLib) {
    processedExpr = processedExpr
      .replace(/\bsqrt\(([^)]+)\)/g, (_, arg) => {
        const val = evaluateBcExpression(arg, context)
        if (val < 0) throw new Error('square root of negative number')
        return String(Math.sqrt(val))
      })
      .replace(/\bs\(([^)]+)\)/g, (_, arg) => {
        const val = evaluateBcExpression(arg, context)
        return String(Math.sin(val))
      })
      .replace(/\bc\(([^)]+)\)/g, (_, arg) => {
        const val = evaluateBcExpression(arg, context)
        return String(Math.cos(val))
      })
      .replace(/\ba\(([^)]+)\)/g, (_, arg) => {
        const val = evaluateBcExpression(arg, context)
        return String(Math.atan(val))
      })
      .replace(/\bl\(([^)]+)\)/g, (_, arg) => {
        const val = evaluateBcExpression(arg, context)
        return String(Math.log(val))
      })
      .replace(/\be\(([^)]+)\)/g, (_, arg) => {
        const val = evaluateBcExpression(arg, context)
        return String(Math.exp(val))
      })
  }

  // Handle non-math-lib sqrt
  processedExpr = processedExpr.replace(/\bsqrt\(([^)]+)\)/g, (_, arg) => {
    const val = evaluateBcExpression(arg, context)
    if (val < 0) throw new Error('square root of negative number')
    return String(Math.sqrt(val))
  })

  // Convert input from ibase
  if (context.ibase !== 10) {
    processedExpr = processedExpr.replace(/\b([0-9A-F]+)\b/g, (match) => {
      return String(parseInt(match, context.ibase))
    })
  }

  // Replace ^ with ** for exponentiation
  processedExpr = processedExpr.replace(/\^/g, '**')

  // Check for division by zero
  if (/\/\s*0(?![0-9])/.test(processedExpr)) {
    throw new Error('divide by zero')
  }

  // Check for syntax errors (double operators)
  if (/[+\-*/%]{2,}/.test(processedExpr.replace(/\*\*/g, 'POW'))) {
    throw new Error('syntax error')
  }

  // Evaluate expression safely
  try {
    // Use Function constructor for safe evaluation (only math operations)
    const fn = new Function(`return (${processedExpr})`)
    const result = fn()

    if (typeof result !== 'number' || !isFinite(result)) {
      throw new Error('invalid result')
    }

    return result
  } catch {
    throw new Error('syntax error')
  }
}

/**
 * Format bc output with proper scale and output base
 * bc uses truncation, not rounding
 */
function formatBcOutput(value: number, context: BcContext): string {
  // Handle negative exponents
  if (context.scale > 0 && !Number.isInteger(value)) {
    // Truncate to scale digits (bc truncates, doesn't round)
    const factor = Math.pow(10, context.scale)
    const truncated = Math.trunc(value * factor) / factor
    let formatted = truncated.toFixed(context.scale)

    // For bc compatibility, remove leading zero for values < 1 and >= 0
    if (Math.abs(truncated) < 1 && truncated !== 0) {
      formatted = formatted.replace(/^-?0\./, match => match.startsWith('-') ? '-.' : '.')
    }
    return formatted
  }

  // Integer result
  let intValue = Math.trunc(value)

  // Convert to output base
  if (context.obase !== 10) {
    return intValue.toString(context.obase).toUpperCase()
  }

  return String(intValue)
}

// ============================================================================
// EXPR - EXPRESSION EVALUATOR
// ============================================================================

/**
 * Execute expr command
 *
 * @param args - Arguments to expr (space-separated expression parts)
 * @returns Result with string output and exit code
 */
export function executeExpr(args: string[]): { result: string; exitCode: number; stderr: string } {
  if (args.length === 0) {
    return { result: '', exitCode: 2, stderr: 'expr: missing operand' }
  }

  try {
    const result = evaluateExprTokens(args)
    const exitCode = result === '0' || result === '' ? 1 : 0
    return { result, exitCode, stderr: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { result: '', exitCode: 2, stderr: `expr: ${message}` }
  }
}

/**
 * Evaluate expr tokens with proper precedence
 */
function evaluateExprTokens(tokens: string[]): string {
  // Handle parentheses first
  let i = 0
  while (i < tokens.length) {
    if (tokens[i] === '(' || tokens[i] === '\\(') {
      // Find matching closing paren
      let depth = 1
      let j = i + 1
      while (j < tokens.length && depth > 0) {
        if (tokens[j] === '(' || tokens[j] === '\\(') depth++
        if (tokens[j] === ')' || tokens[j] === '\\)') depth--
        j++
      }
      // Evaluate sub-expression
      const subResult = evaluateExprTokens(tokens.slice(i + 1, j - 1))
      tokens = [...tokens.slice(0, i), subResult, ...tokens.slice(j)]
    }
    i++
  }

  // Handle string operations: match, substr, index, length
  if (tokens[0] === 'match' && tokens.length >= 3) {
    const str = tokens[1]
    const pattern = tokens[2]
    return exprMatch(str, pattern)
  }

  if (tokens[0] === 'substr' && tokens.length >= 4) {
    const str = tokens[1]
    const pos = parseInt(tokens[2], 10)
    const len = parseInt(tokens[3], 10)
    return str.substring(pos - 1, pos - 1 + len)
  }

  if (tokens[0] === 'index' && tokens.length >= 3) {
    const str = tokens[1]
    const chars = tokens[2]
    for (let idx = 0; idx < str.length; idx++) {
      if (chars.includes(str[idx])) {
        return String(idx + 1)
      }
    }
    return '0'
  }

  if (tokens[0] === 'length' && tokens.length >= 2) {
    return String(tokens[1].length)
  }

  // Handle : operator (pattern matching, anchored at start)
  const colonIdx = tokens.indexOf(':')
  if (colonIdx > 0) {
    const str = tokens[colonIdx - 1]
    const pattern = tokens[colonIdx + 1]
    // Replace the three tokens with the result
    const result = exprMatch(str, pattern)
    tokens = [
      ...tokens.slice(0, colonIdx - 1),
      result,
      ...tokens.slice(colonIdx + 2)
    ]
    if (tokens.length === 1) return tokens[0]
  }

  // Handle | (OR) - lowest precedence
  const orIdx = findOperator(tokens, ['|', '\\|'])
  if (orIdx >= 0) {
    const left = evaluateExprTokens(tokens.slice(0, orIdx))
    if (left !== '0' && left !== '') return left
    return evaluateExprTokens(tokens.slice(orIdx + 1))
  }

  // Handle & (AND)
  const andIdx = findOperator(tokens, ['&', '\\&'])
  if (andIdx >= 0) {
    const left = evaluateExprTokens(tokens.slice(0, andIdx))
    if (left === '0' || left === '') return '0'
    const right = evaluateExprTokens(tokens.slice(andIdx + 1))
    if (right === '0' || right === '') return '0'
    return left
  }

  // Handle comparison operators
  const compOps = ['=', '!=', '<', '>', '<=', '>=', '\\<', '\\>', '\\<=', '\\>=']
  const compIdx = findOperator(tokens, compOps)
  if (compIdx >= 0) {
    const left = evaluateExprTokens(tokens.slice(0, compIdx))
    const op = tokens[compIdx].replace(/^\\/, '')
    const right = evaluateExprTokens(tokens.slice(compIdx + 1))

    // Try numeric comparison first
    const leftNum = parseFloat(left)
    const rightNum = parseFloat(right)
    const isNumeric = !isNaN(leftNum) && !isNaN(rightNum)

    let result: boolean
    switch (op) {
      case '=':
        result = isNumeric ? leftNum === rightNum : left === right
        break
      case '!=':
        result = isNumeric ? leftNum !== rightNum : left !== right
        break
      case '<':
        result = isNumeric ? leftNum < rightNum : left < right
        break
      case '>':
        result = isNumeric ? leftNum > rightNum : left > right
        break
      case '<=':
        result = isNumeric ? leftNum <= rightNum : left <= right
        break
      case '>=':
        result = isNumeric ? leftNum >= rightNum : left >= right
        break
      default:
        result = false
    }
    return result ? '1' : '0'
  }

  // Handle arithmetic operators
  const addSubIdx = findOperator(tokens, ['+', '-'], true)
  if (addSubIdx >= 0 && addSubIdx > 0) {
    const left = evaluateExprTokens(tokens.slice(0, addSubIdx))
    const op = tokens[addSubIdx]
    const right = evaluateExprTokens(tokens.slice(addSubIdx + 1))

    const leftNum = parseInt(left, 10)
    const rightNum = parseInt(right, 10)

    if (isNaN(leftNum) || isNaN(rightNum)) {
      throw new Error('non-numeric argument')
    }

    return String(op === '+' ? leftNum + rightNum : leftNum - rightNum)
  }

  // Handle multiplication, division, modulo (higher precedence)
  const mulDivIdx = findOperator(tokens, ['*', '\\*', '/', '%'])
  if (mulDivIdx >= 0) {
    const left = evaluateExprTokens(tokens.slice(0, mulDivIdx))
    const op = tokens[mulDivIdx].replace(/^\\/, '')
    const right = evaluateExprTokens(tokens.slice(mulDivIdx + 1))

    const leftNum = parseInt(left, 10)
    const rightNum = parseInt(right, 10)

    if (isNaN(leftNum) || isNaN(rightNum)) {
      throw new Error('non-numeric argument')
    }

    switch (op) {
      case '*':
        return String(leftNum * rightNum)
      case '/':
        if (rightNum === 0) throw new Error('division by zero')
        return String(Math.trunc(leftNum / rightNum))
      case '%':
        if (rightNum === 0) throw new Error('division by zero')
        return String(leftNum % rightNum)
    }
  }

  // Single value
  if (tokens.length === 1) {
    return tokens[0]
  }

  throw new Error('syntax error')
}

/**
 * Find operator in tokens array
 */
function findOperator(tokens: string[], ops: string[], fromRight = false): number {
  if (fromRight) {
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (ops.includes(tokens[i])) return i
    }
  } else {
    for (let i = 0; i < tokens.length; i++) {
      if (ops.includes(tokens[i])) return i
    }
  }
  return -1
}

/**
 * Pattern matching for expr (anchored at start)
 */
function exprMatch(str: string, pattern: string): string {
  // Check for capture group
  const captureMatch = pattern.match(/\\?\((.+?)\\?\)/)

  // Build regex (anchored at start)
  let regexPattern = pattern
    .replace(/\\?\(/g, '(')
    .replace(/\\?\)/g, ')')

  try {
    const regex = new RegExp('^' + regexPattern)
    const match = str.match(regex)

    if (!match) {
      return '0'
    }

    // If there's a capture group, return captured string
    if (captureMatch && match[1] !== undefined) {
      return match[1]
    }

    // Otherwise return match length
    return String(match[0].length)
  } catch {
    return '0'
  }
}

// ============================================================================
// SEQ - SEQUENCE GENERATOR
// ============================================================================

export interface SeqOptions {
  separator?: string
  equalWidth?: boolean
  format?: string
}

/**
 * Execute seq command
 *
 * @param args - Numeric arguments: [last], [first, last], or [first, increment, last]
 * @param options - Formatting options
 * @returns Sequence string
 */
export function executeSeq(
  args: number[],
  options: SeqOptions = {}
): { result: string; exitCode: number } {
  let first = 1
  let increment = 1
  let last: number

  if (args.length === 1) {
    last = args[0]
  } else if (args.length === 2) {
    first = args[0]
    last = args[1]
  } else if (args.length === 3) {
    first = args[0]
    increment = args[1]
    last = args[2]
  } else {
    return { result: '', exitCode: 1 }
  }

  // Handle impossible ranges (empty output)
  if ((increment > 0 && first > last) || (increment < 0 && first < last) || increment === 0) {
    return { result: '', exitCode: 0 }
  }

  const results: string[] = []
  const separator = options.separator ?? '\n'

  // Calculate width for equal-width option
  // When range includes negatives, positive numbers get extra padding
  // to match the total width (sign + digits) of negative numbers
  const firstStr = String(first)
  const lastStr = String(last)
  const totalWidth = Math.max(firstStr.length, lastStr.length)
  // For padding, we need the digit width (not counting sign)
  // -5 has totalWidth=2, so positive numbers need 2 digits (like 05)
  const maxWidth = first < 0 || last < 0
    ? totalWidth  // Include sign width for negatives
    : Math.max(String(first).length, String(last).length)

  // Determine if we're dealing with floats
  const isFloat = !Number.isInteger(first) || !Number.isInteger(increment) || !Number.isInteger(last)

  // Precision handling for floats
  const getPrecision = (n: number) => {
    const str = String(n)
    const dot = str.indexOf('.')
    return dot >= 0 ? str.length - dot - 1 : 0
  }

  const precision = Math.max(
    getPrecision(first),
    getPrecision(increment),
    getPrecision(last)
  )

  for (
    let i = first;
    increment > 0 ? i <= last + Number.EPSILON * 10 : i >= last - Number.EPSILON * 10;
    i += increment
  ) {
    // Avoid floating point errors
    const value = Math.round(i * Math.pow(10, precision + 2)) / Math.pow(10, precision + 2)

    // Stop if we've passed the last value
    if (increment > 0 && value > last + Number.EPSILON) break
    if (increment < 0 && value < last - Number.EPSILON) break

    let formatted: string

    if (options.format) {
      formatted = sprintf(options.format, value)
    } else if (options.equalWidth) {
      // For equal width:
      // - Negative numbers: natural representation (e.g., -5)
      // - Positive numbers: pad with zeros to match total width (e.g., 05)
      // This way -5 and 05 have the same total character width
      if (value < 0) {
        // Negative numbers don't get extra padding
        formatted = String(Math.round(value))
      } else {
        // Positive numbers pad to match total width
        const absStr = String(Math.abs(Math.round(value)))
        formatted = absStr.padStart(maxWidth, '0')
      }
    } else if (isFloat) {
      formatted = precision > 0 ? value.toFixed(precision) : String(value)
    } else {
      formatted = String(value)
    }

    results.push(formatted)
  }

  return {
    result: results.length > 0 ? results.join(separator) + (separator === '\n' ? '' : '') : '',
    exitCode: 0
  }
}

// ============================================================================
// SHUF - SHUFFLE/RANDOMIZE
// ============================================================================

export interface ShufOptions {
  count?: number
  replacement?: boolean
  inputRange?: { start: number; end: number }
  echoArgs?: string[]
  outputFile?: string
  randomSource?: string
}

/**
 * Execute shuf command
 *
 * @param lines - Input lines to shuffle (from stdin)
 * @param options - Shuffle options
 * @returns Shuffled output
 */
export function executeShuf(
  lines: string[],
  options: ShufOptions = {}
): { result: string; exitCode: number } {
  let items: string[]

  if (options.inputRange) {
    // Generate range
    const { start, end } = options.inputRange
    items = []
    for (let i = start; i <= end; i++) {
      items.push(String(i))
    }
  } else if (options.echoArgs && options.echoArgs.length > 0) {
    items = options.echoArgs
  } else {
    items = lines.filter(l => l.length > 0)
  }

  // Handle -n 0
  if (options.count === 0) {
    return { result: '', exitCode: 0 }
  }

  let result: string[]

  if (options.replacement) {
    // With replacement - can pick same item multiple times
    const count = options.count ?? items.length
    result = []
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * items.length)
      result.push(items[idx])
    }
  } else {
    // Fisher-Yates shuffle
    result = [...items]
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[result[i], result[j]] = [result[j], result[i]]
    }

    // Limit to count if specified
    if (options.count !== undefined) {
      result = result.slice(0, Math.min(options.count, result.length))
    }
  }

  return {
    result: result.join('\n'),
    exitCode: 0
  }
}

// ============================================================================
// SLEEP - DELAY EXECUTION
// ============================================================================

/**
 * Execute sleep command
 *
 * @param durations - One or more duration strings
 * @returns Promise that resolves after delay
 */
export async function executeSleep(
  durations: string[]
): Promise<{ exitCode: number; stderr: string }> {
  if (durations.length === 0) {
    return { exitCode: 1, stderr: 'sleep: missing operand' }
  }

  try {
    let totalMs = 0

    for (const duration of durations) {
      const ms = parseDuration(duration)

      if (ms < 0) {
        return { exitCode: 1, stderr: 'sleep: invalid time interval' }
      }

      if (!isFinite(ms)) {
        // Infinity - sleep forever (will be interrupted by timeout)
        await new Promise(() => {})
        return { exitCode: 0, stderr: '' }
      }

      totalMs += ms
    }

    await new Promise(resolve => setTimeout(resolve, totalMs))
    return { exitCode: 0, stderr: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { exitCode: 1, stderr: `sleep: ${message}` }
  }
}

// ============================================================================
// TIMEOUT - RUN WITH TIME LIMIT
// ============================================================================

export interface TimeoutOptions {
  duration: string
  killAfter?: string
  signal?: string | number
  preserveStatus?: boolean
  foreground?: boolean
  verbose?: boolean
}

/**
 * Execute timeout command
 *
 * @param options - Timeout options
 * @param command - Command to execute
 * @param commandExecutor - Function to execute the command
 * @returns Result with exit code
 */
export async function executeTimeout<T extends { exitCode: number; stdout: string; stderr: string }>(
  options: TimeoutOptions,
  command: string,
  commandExecutor: (cmd: string) => Promise<T>
): Promise<T & { timedOut: boolean }> {
  // Parse timeout duration
  let timeoutMs: number
  try {
    timeoutMs = parseDuration(options.duration)
  } catch {
    return {
      exitCode: 125,
      stdout: '',
      stderr: `timeout: invalid time interval '${options.duration}'`,
      timedOut: false,
    } as T & { timedOut: boolean }
  }

  // Determine signal to use
  let signalNum = 15 // SIGTERM default
  if (options.signal) {
    if (typeof options.signal === 'number') {
      signalNum = options.signal
    } else {
      const sigMap: Record<string, number> = {
        'TERM': 15,
        'SIGTERM': 15,
        'KILL': 9,
        'SIGKILL': 9,
        'INT': 2,
        'SIGINT': 2,
        'HUP': 1,
        'SIGHUP': 1,
      }
      signalNum = sigMap[options.signal.toUpperCase()] ?? parseInt(options.signal, 10)
    }
  }

  // Create abort controller for timeout
  const controller = new AbortController()
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    // Execute command
    const result = await Promise.race([
      commandExecutor(command),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error('TIMEOUT'))
        })
      })
    ])

    clearTimeout(timer)
    return { ...result, timedOut: false }
  } catch (error) {
    clearTimeout(timer)

    if (timedOut) {
      const exitCode = options.preserveStatus ? 128 + signalNum : 124
      let stderr = ''
      if (options.verbose) {
        stderr = `timeout: sending signal ${signalNum === 9 ? 'KILL' : 'TERM'} to command '${command}'`
      }

      // If kill-after is specified and signal was TERM, we'd send KILL after grace period
      // For simulation, we just return appropriate exit code
      const finalExitCode = signalNum === 9 ? 137 : exitCode

      return {
        exitCode: finalExitCode,
        stdout: '',
        stderr,
        timedOut: true,
      } as T & { timedOut: boolean }
    }

    // Re-throw non-timeout errors
    throw error
  }
}

// ============================================================================
// COMMAND NOT FOUND HANDLING
// ============================================================================

/**
 * Handle command not found error for timeout
 */
export function timeoutCommandNotFound(command: string): { exitCode: number; stderr: string } {
  return {
    exitCode: 126,
    stderr: `timeout: failed to run command '${command}': No such file or directory`
  }
}

// ============================================================================
// EXPORTS FOR INTEGRATION
// ============================================================================

export const mathControlCommands = {
  bc: executeBc,
  expr: executeExpr,
  seq: executeSeq,
  shuf: executeShuf,
  sleep: executeSleep,
  timeout: executeTimeout,
}
