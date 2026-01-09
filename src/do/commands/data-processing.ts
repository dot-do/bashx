/**
 * Data Processing Commands
 *
 * Native implementations of data processing commands:
 * - jq: JSON processor
 * - yq: YAML processor
 * - base64: Encoding/decoding
 * - envsubst: Environment variable substitution
 *
 * These run as Tier 1 native commands in the Worker.
 *
 * @module bashx/do/commands/data-processing
 */

// ============================================================================
// JQ - JSON PROCESSOR
// ============================================================================

/**
 * Options for jq execution
 */
export interface JqOptions {
  /** Output raw strings without quotes */
  raw?: boolean
  /** Compact output (no pretty printing) */
  compact?: boolean
  /** Slurp mode - read all inputs into array */
  slurp?: boolean
  /** Tab-separated output */
  tab?: boolean
  /** Variables from --arg */
  args?: Record<string, string>
  /** JSON variables from --argjson */
  argjson?: Record<string, unknown>
}

/**
 * Execute a jq query on JSON input
 *
 * @param query - The jq query expression
 * @param input - JSON input string
 * @param options - Execution options
 * @returns Query result as string
 */
export function executeJq(query: string, input: string, options: JqOptions = {}): string {
  // Handle slurp mode - parse multiple JSON documents into array
  let data: unknown
  if (options.slurp) {
    const docs: unknown[] = []
    const lines = input.trim().split('\n')
    let currentDoc = ''
    let braceCount = 0
    let bracketCount = 0

    for (const line of lines) {
      currentDoc += line
      for (const char of line) {
        if (char === '{') braceCount++
        else if (char === '}') braceCount--
        else if (char === '[') bracketCount++
        else if (char === ']') bracketCount--
      }

      if (braceCount === 0 && bracketCount === 0 && currentDoc.trim()) {
        try {
          docs.push(JSON.parse(currentDoc.trim()))
          currentDoc = ''
        } catch {
          // Continue accumulating
        }
      }
    }

    // Try to parse any remaining content
    if (currentDoc.trim()) {
      try {
        docs.push(JSON.parse(currentDoc.trim()))
      } catch {
        // Ignore
      }
    }

    data = docs
  } else {
    try {
      data = JSON.parse(input)
    } catch (e) {
      throw new JqError('parse error: Invalid JSON input', 5)
    }
  }

  // Create context with variables
  const context: JqContext = {
    vars: { ...options.args },
    argjson: { ...options.argjson },
  }

  // Execute query
  const result = evaluateJqWithMeta(query, data, context)

  // Format output
  return formatJqOutput(result.value, options, result.isIterator)
}

/**
 * JQ execution context
 */
interface JqContext {
  vars: Record<string, string>
  argjson: Record<string, unknown>
}

/**
 * Custom error for jq parsing/execution errors
 */
export class JqError extends Error {
  constructor(
    message: string,
    public exitCode: number = 1
  ) {
    super(message)
    this.name = 'JqError'
  }
}

/**
 * Result from jq evaluation with iterator metadata
 */
interface JqResult {
  value: unknown
  isIterator: boolean
}

/**
 * Evaluate a jq expression (internal use, returns raw value)
 */
function evaluateJq(query: string, data: unknown, context: JqContext): unknown {
  const trimmedQuery = query.trim()

  // Handle empty/identity query
  if (trimmedQuery === '.' || trimmedQuery === '') {
    return data
  }

  // Parse and execute the query
  const tokens = tokenizeJq(trimmedQuery)
  return executeJqTokens(tokens, data, context).value
}

/**
 * Evaluate a jq expression with iterator metadata (for top-level formatting)
 */
function evaluateJqWithMeta(query: string, data: unknown, context: JqContext): JqResult {
  const trimmedQuery = query.trim()

  // Handle empty/identity query
  if (trimmedQuery === '.' || trimmedQuery === '') {
    return { value: data, isIterator: false }
  }

  // Parse and execute the query
  const tokens = tokenizeJq(trimmedQuery)
  return executeJqTokens(tokens, data, context)
}

/**
 * Tokenize a jq query into components
 */
function tokenizeJq(query: string): string[] {
  const tokens: string[] = []
  let current = ''
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let inString = false
  let stringChar = ''

  for (let i = 0; i < query.length; i++) {
    const char = query[i]
    const prevChar = i > 0 ? query[i - 1] : ''

    // Handle strings
    if ((char === '"' || char === "'") && prevChar !== '\\') {
      if (!inString) {
        inString = true
        stringChar = char
      } else if (char === stringChar) {
        inString = false
      }
      current += char
      continue
    }

    if (inString) {
      current += char
      continue
    }

    // Track nesting
    if (char === '(') parenDepth++
    else if (char === ')') parenDepth--
    else if (char === '[') bracketDepth++
    else if (char === ']') bracketDepth--
    else if (char === '{') braceDepth++
    else if (char === '}') braceDepth--

    // Pipe separator at top level
    if (char === '|' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (current.trim()) {
        tokens.push(current.trim())
      }
      current = ''
      continue
    }

    current += char
  }

  if (current.trim()) {
    tokens.push(current.trim())
  }

  return tokens
}

/**
 * Execute tokenized jq query
 * Handles iterator semantics: when a filter produces multiple outputs,
 * subsequent filters are applied to each output independently.
 */
function executeJqTokens(tokens: string[], data: unknown, context: JqContext): JqResult {
  let result: unknown = data
  let isIterator = false

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]

    // Check if previous result was from an iterator (.[] operation)
    // If so, apply this filter to each element
    if (isIterator && Array.isArray(result)) {
      const filtered: unknown[] = []
      for (const item of result) {
        const itemResult = executeJqExpressionRaw(token, item, context)
        // select returns undefined for non-matches
        if (itemResult !== undefined) {
          filtered.push(itemResult)
        }
      }
      result = filtered
      // Keep iterator mode for subsequent filters
      isIterator = true
    } else {
      result = executeJqExpressionRaw(token, result, context)
      // Check if this is an iterator expression
      isIterator = token === '.[]' || /^\.[a-zA-Z_]\w*\[\]$/.test(token)
    }
  }

  return { value: result, isIterator }
}

/**
 * Execute a single jq expression (raw, returns value directly)
 */
function executeJqExpressionRaw(expr: string, data: unknown, context: JqContext): unknown {
  const trimmed = expr.trim()

  // Identity
  if (trimmed === '.') {
    return data
  }

  // Iterator: .[]
  if (trimmed === '.[]') {
    if (Array.isArray(data)) {
      return data
    }
    if (data && typeof data === 'object') {
      return Object.values(data)
    }
    throw new JqError(`Cannot iterate over ${typeof data}`)
  }

  // Key access with iterator: .key[]
  const keyIterMatch = trimmed.match(/^\.([a-zA-Z_][a-zA-Z0-9_]*)\[\]$/)
  if (keyIterMatch) {
    const key = keyIterMatch[1]
    const obj = data as Record<string, unknown>
    const value = obj?.[key]
    if (Array.isArray(value)) {
      return value
    }
    if (value && typeof value === 'object') {
      return Object.values(value)
    }
    throw new JqError(`Cannot iterate over ${typeof value}`)
  }

  // Path with iterator: .items[].name
  const pathIterMatch = trimmed.match(/^\.([\w.]+)\[\]\.(\w+)$/)
  if (pathIterMatch) {
    const basePath = pathIterMatch[1]
    const finalKey = pathIterMatch[2]
    let current: unknown = data

    // Navigate to base
    for (const key of basePath.split('.')) {
      if (current && typeof current === 'object') {
        current = (current as Record<string, unknown>)[key]
      } else {
        return null
      }
    }

    // Iterate and extract final key
    if (Array.isArray(current)) {
      return current.map((item) => (item as Record<string, unknown>)?.[finalKey])
    }
    throw new JqError(`Cannot iterate: not an array`)
  }

  // Simple key access: .key or .key.nested
  if (trimmed.startsWith('.') && /^\.[\w.]+$/.test(trimmed)) {
    const path = trimmed.slice(1)
    return getPath(data, path)
  }

  // Array index: .[n] or .[n:m]
  const indexMatch = trimmed.match(/^\.\[(-?\d+)(?::(-?\d+))?\]$/)
  if (indexMatch) {
    if (!Array.isArray(data)) {
      throw new JqError('Cannot index non-array')
    }
    const start = parseInt(indexMatch[1], 10)
    if (indexMatch[2] !== undefined) {
      const end = parseInt(indexMatch[2], 10)
      return data.slice(start < 0 ? data.length + start : start, end < 0 ? data.length + end : end)
    }
    const idx = start < 0 ? data.length + start : start
    return data[idx]
  }

  // Key with array index: .key[n] or .key[n:m]
  const keyIndexMatch = trimmed.match(/^\.(\w+)\[(-?\d+)(?::(-?\d+))?\]$/)
  if (keyIndexMatch) {
    const key = keyIndexMatch[1]
    const arr = (data as Record<string, unknown>)?.[key]
    if (!Array.isArray(arr)) {
      throw new JqError(`Cannot index: .${key} is not an array`)
    }
    const start = parseInt(keyIndexMatch[2], 10)
    if (keyIndexMatch[3] !== undefined) {
      const end = parseInt(keyIndexMatch[3], 10)
      return arr.slice(start < 0 ? arr.length + start : start, end < 0 ? arr.length + end : end)
    }
    const idx = start < 0 ? arr.length + start : start
    return arr[idx]
  }

  // Nested path with array index: .items[0].name
  const nestedIndexMatch = trimmed.match(/^\.(\w+)\[(-?\d+)\]\.(\w+)$/)
  if (nestedIndexMatch) {
    const key = nestedIndexMatch[1]
    const idx = parseInt(nestedIndexMatch[2], 10)
    const finalKey = nestedIndexMatch[3]
    const arr = (data as Record<string, unknown>)?.[key]
    if (!Array.isArray(arr)) {
      throw new JqError(`Cannot index: .${key} is not an array`)
    }
    const realIdx = idx < 0 ? arr.length + idx : idx
    const item = arr[realIdx]
    // Accessing property on null/undefined should throw in try-catch context
    if (item === undefined || item === null) {
      throw new JqError(`Cannot get .${finalKey} of null`)
    }
    return (item as Record<string, unknown>)?.[finalKey]
  }

  // Variable access: $var
  if (trimmed.startsWith('$')) {
    const varName = trimmed.slice(1)
    if (varName in context.argjson) {
      return context.argjson[varName]
    }
    if (varName in context.vars) {
      return context.vars[varName]
    }
    throw new JqError(`Variable ${trimmed} is not defined`)
  }

  // Dynamic key access with variable: .[$key]
  const dynKeyMatch = trimmed.match(/^\.\[\$(\w+)\]$/)
  if (dynKeyMatch) {
    const varName = dynKeyMatch[1]
    let key: string
    if (varName in context.argjson) {
      key = String(context.argjson[varName])
    } else if (varName in context.vars) {
      key = context.vars[varName]
    } else {
      throw new JqError(`Variable $${varName} is not defined`)
    }
    return (data as Record<string, unknown>)?.[key]
  }

  // Built-in functions
  if (trimmed === 'length') {
    if (Array.isArray(data)) return data.length
    if (typeof data === 'string') return data.length
    if (data && typeof data === 'object') return Object.keys(data).length
    return 0
  }

  if (trimmed === 'keys') {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.keys(data).sort()
    }
    if (Array.isArray(data)) {
      return data.map((_, i) => i)
    }
    throw new JqError('keys requires an object or array')
  }

  if (trimmed === 'values') {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.values(data)
    }
    if (Array.isArray(data)) {
      return data
    }
    throw new JqError('values requires an object or array')
  }

  if (trimmed === 'type') {
    if (data === null) return 'null'
    if (Array.isArray(data)) return 'array'
    return typeof data
  }

  if (trimmed === 'tonumber') {
    const num = Number(data)
    if (isNaN(num)) throw new JqError('Cannot convert to number')
    return num
  }

  if (trimmed === 'tostring') {
    if (typeof data === 'string') return data
    return JSON.stringify(data)
  }

  if (trimmed === 'sort') {
    if (!Array.isArray(data)) throw new JqError('sort requires an array')
    return [...data].sort((a, b) => {
      if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b)
      if (typeof a === 'number' && typeof b === 'number') return a - b
      return String(a).localeCompare(String(b))
    })
  }

  if (trimmed === 'reverse') {
    if (!Array.isArray(data)) throw new JqError('reverse requires an array')
    return [...data].reverse()
  }

  if (trimmed === 'unique') {
    if (!Array.isArray(data)) throw new JqError('unique requires an array')
    const seen = new Set<string>()
    return data.filter((item) => {
      const key = JSON.stringify(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  if (trimmed === 'flatten') {
    if (!Array.isArray(data)) throw new JqError('flatten requires an array')
    return data.flat(Infinity)
  }

  if (trimmed === 'add') {
    if (!Array.isArray(data)) throw new JqError('add requires an array')
    if (data.length === 0) return null
    if (typeof data[0] === 'number') {
      return data.reduce((a, b) => (a as number) + (b as number), 0)
    }
    if (typeof data[0] === 'string') {
      return data.join('')
    }
    if (Array.isArray(data[0])) {
      return data.flat(1)
    }
    return data.reduce((a, b) => ({ ...(a as object), ...(b as object) }), {})
  }

  if (trimmed === 'ascii_upcase') {
    if (typeof data !== 'string') throw new JqError('ascii_upcase requires a string')
    return data.toUpperCase()
  }

  if (trimmed === 'ascii_downcase') {
    if (typeof data !== 'string') throw new JqError('ascii_downcase requires a string')
    return data.toLowerCase()
  }

  // sort_by(.key)
  const sortByMatch = trimmed.match(/^sort_by\(\.(\w+)\)$/)
  if (sortByMatch) {
    if (!Array.isArray(data)) throw new JqError('sort_by requires an array')
    const key = sortByMatch[1]
    return [...data].sort((a, b) => {
      const aVal = (a as Record<string, unknown>)?.[key]
      const bVal = (b as Record<string, unknown>)?.[key]
      if (typeof aVal === 'number' && typeof bVal === 'number') return aVal - bVal
      return String(aVal ?? '').localeCompare(String(bVal ?? ''))
    })
  }

  // map(expr)
  const mapMatch = trimmed.match(/^map\((.+)\)$/)
  if (mapMatch) {
    if (!Array.isArray(data)) throw new JqError('map requires an array')
    const innerExpr = mapMatch[1]
    return data.map((item) => evaluateJq(innerExpr, item, context))
  }

  // select(condition)
  const selectMatch = trimmed.match(/^select\((.+)\)$/)
  if (selectMatch) {
    const condition = selectMatch[1]
    if (evaluateCondition(condition, data, context)) {
      return data
    }
    return undefined // Filter out
  }

  // has("key")
  const hasMatch = trimmed.match(/^has\("([^"]+)"\)$/) || trimmed.match(/^has\(\\"([^"]+)\\"\)$/)
  if (hasMatch) {
    const key = hasMatch[1]
    if (data && typeof data === 'object') {
      return key in (data as Record<string, unknown>)
    }
    return false
  }

  // split("delimiter")
  const splitMatch = trimmed.match(/^split\("([^"]*)"\)$/) || trimmed.match(/^split\(\\"([^"]*)\\"\)$/)
  if (splitMatch) {
    if (typeof data !== 'string') throw new JqError('split requires a string')
    return data.split(splitMatch[1])
  }

  // join("delimiter")
  const joinMatch = trimmed.match(/^join\("([^"]*)"\)$/) || trimmed.match(/^join\(\\"([^"]*)\\"\)$/)
  if (joinMatch) {
    if (!Array.isArray(data)) throw new JqError('join requires an array')
    return data.join(joinMatch[1])
  }

  // test("pattern")
  const testMatch = trimmed.match(/^test\("([^"]+)"\)$/) || trimmed.match(/^test\(\\"([^"]+)\\"\)$/)
  if (testMatch) {
    if (typeof data !== 'string') throw new JqError('test requires a string')
    return new RegExp(testMatch[1]).test(data)
  }

  // Object construction: {key, key2} or {newKey: .key}
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return constructObject(trimmed, data, context)
  }

  // Object addition: . + {key: value}
  const addMatch = trimmed.match(/^\.\s*\+\s*(\{.+\})$/)
  if (addMatch) {
    const newObj = constructObject(addMatch[1], data, context)
    return { ...(data as object), ...newObj }
  }

  // Alternative operator: expr // default
  if (trimmed.includes(' // ')) {
    const [primary, fallback] = trimmed.split(' // ')
    try {
      const result = evaluateJq(primary.trim(), data, context)
      if (result === null || result === undefined) {
        return evaluateJq(fallback.trim(), data, context)
      }
      return result
    } catch {
      return evaluateJq(fallback.trim(), data, context)
    }
  }

  // if-then-else
  const ifMatch = trimmed.match(/^if\s+(.+)\s+then\s+(.+)\s+else\s+(.+)\s+end$/)
  if (ifMatch) {
    const condition = ifMatch[1]
    const thenExpr = ifMatch[2]
    const elseExpr = ifMatch[3]
    if (evaluateCondition(condition, data, context)) {
      return evaluateJq(thenExpr, data, context)
    }
    return evaluateJq(elseExpr, data, context)
  }

  // try-catch
  const tryMatch = trimmed.match(/^try\s+(.+)\s+catch\s+(.+)$/)
  if (tryMatch) {
    try {
      return evaluateJq(tryMatch[1], data, context)
    } catch {
      // Parse the catch value
      const catchExpr = tryMatch[2].trim()
      if (catchExpr.startsWith('"') && catchExpr.endsWith('"')) {
        return catchExpr.slice(1, -1)
      }
      if (catchExpr.startsWith('\\"') && catchExpr.endsWith('\\"')) {
        return catchExpr.slice(2, -2)
      }
      return evaluateJq(catchExpr, data, context)
    }
  }

  // String literal
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\\"') && trimmed.endsWith('\\"'))) {
    const inner = trimmed.startsWith('\\"') ? trimmed.slice(2, -2) : trimmed.slice(1, -1)
    return inner
  }

  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return parseFloat(trimmed)
  }

  // Boolean literals
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null

  throw new JqError(`Unknown expression: ${trimmed}`)
}

/**
 * Evaluate a condition expression
 */
function evaluateCondition(condition: string, data: unknown, context: JqContext): boolean {
  const trimmed = condition.trim()

  // Handle compound conditions first (and/or) - split on first instance
  // This must be done before comparison to handle: .name == $name and .age > $minAge
  if (trimmed.includes(' and ')) {
    const parts = trimmed.split(' and ')
    return parts.every((part) => evaluateCondition(part.trim(), data, context))
  }

  if (trimmed.includes(' or ')) {
    const parts = trimmed.split(' or ')
    return parts.some((part) => evaluateCondition(part.trim(), data, context))
  }

  // .key > value, .key >= value, etc.
  const compMatch = trimmed.match(/^(.+?)\s*(>=|<=|>|<|==|!=)\s*(.+)$/)
  if (compMatch) {
    const left = evaluateJq(compMatch[1].trim(), data, context)
    const op = compMatch[2]
    let right: unknown = compMatch[3].trim()

    // Parse right side
    if (/^-?\d+(\.\d+)?$/.test(right as string)) {
      right = parseFloat(right as string)
    } else if ((right as string).startsWith('$')) {
      const varName = (right as string).slice(1)
      right = context.argjson[varName] ?? context.vars[varName]
    } else if ((right as string).startsWith('.')) {
      right = evaluateJq(right as string, data, context)
    } else if ((right as string).startsWith('"') && (right as string).endsWith('"')) {
      // Handle quoted strings
      right = (right as string).slice(1, -1)
    }

    switch (op) {
      case '>':
        return (left as number) > (right as number)
      case '<':
        return (left as number) < (right as number)
      case '>=':
        return (left as number) >= (right as number)
      case '<=':
        return (left as number) <= (right as number)
      case '==':
        return left === right
      case '!=':
        return left !== right
    }
  }

  // .key (truthy check)
  if (trimmed.startsWith('.')) {
    const value = evaluateJq(trimmed, data, context)
    return Boolean(value)
  }

  // has("key")
  const hasCondMatch = trimmed.match(/^has\("([^"]+)"\)$/) || trimmed.match(/^has\(\\"([^"]+)\\"\)$/)
  if (hasCondMatch) {
    const key = hasCondMatch[1]
    return data && typeof data === 'object' && key in (data as Record<string, unknown>)
  }

  return false
}

/**
 * Construct an object from jq object syntax
 */
function constructObject(expr: string, data: unknown, context: JqContext): Record<string, unknown> {
  const inner = expr.slice(1, -1).trim()
  const result: Record<string, unknown> = {}

  // Parse key-value pairs
  const pairs: string[] = []
  let current = ''
  let depth = 0
  let inString = false

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]
    if (char === '"' && inner[i - 1] !== '\\') {
      inString = !inString
    }
    if (!inString) {
      if (char === '{' || char === '[') depth++
      else if (char === '}' || char === ']') depth--
      else if (char === ',' && depth === 0) {
        pairs.push(current.trim())
        current = ''
        continue
      }
    }
    current += char
  }
  if (current.trim()) {
    pairs.push(current.trim())
  }

  for (const pair of pairs) {
    // Shorthand: key (same as key: .key)
    if (/^\w+$/.test(pair)) {
      const val = (data as Record<string, unknown>)?.[pair]
      result[pair] = val
      continue
    }

    // Full syntax: newKey: .expr or newKey: "value"
    const colonIdx = pair.indexOf(':')
    if (colonIdx > 0) {
      const key = pair.slice(0, colonIdx).trim()
      const valueExpr = pair.slice(colonIdx + 1).trim()

      if (valueExpr.startsWith('\\"') && valueExpr.endsWith('\\"')) {
        result[key] = valueExpr.slice(2, -2)
      } else if (valueExpr.startsWith('"') && valueExpr.endsWith('"')) {
        result[key] = valueExpr.slice(1, -1)
      } else {
        result[key] = evaluateJq(valueExpr, data, context)
      }
    }
  }

  return result
}

/**
 * Get value at a dot-separated path
 */
function getPath(data: unknown, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = data

  for (const part of parts) {
    if (current === null || current === undefined) {
      return null
    }
    if (typeof current !== 'object') {
      return null
    }
    current = (current as Record<string, unknown>)[part]
  }

  // Return null for undefined values (missing keys)
  return current === undefined ? null : current
}

/**
 * Format jq output based on options
 */
function formatJqOutput(result: unknown, options: JqOptions, isIteratorResult: boolean = false): string {
  // Handle array of results from iterator operations
  if (Array.isArray(result) && result.some((r) => r === undefined)) {
    // Filter out undefined (from select that didn't match)
    result = result.filter((r) => r !== undefined)
  }

  // Handle undefined (select didn't match)
  if (result === undefined) {
    return ''
  }

  // Handle empty array result from iterator that filtered everything out
  if (isIteratorResult && Array.isArray(result) && result.length === 0) {
    return ''
  }

  // Handle iterator output - each result on its own line (not wrapped in array)
  // jq outputs multiple results as newline-separated JSON values, not as an array
  if (isIteratorResult && Array.isArray(result)) {
    if (options.tab) {
      // Tab-separated mode
      return result
        .map((item) => {
          if (typeof item === 'string') return options.raw ? item : JSON.stringify(item)
          return JSON.stringify(item)
        })
        .join('\n') + '\n'
    }
    // Normal iterator output - each item on its own line
    return result
      .map((item) => {
        if (options.raw && typeof item === 'string') return item
        return options.compact ? JSON.stringify(item) : JSON.stringify(item, null, 2)
      })
      .join('\n') + '\n'
  }

  // Raw output for strings
  if (options.raw && typeof result === 'string') {
    return result + '\n'
  }

  // Normal JSON output
  const formatted = options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)
  return formatted + '\n'
}

// ============================================================================
// YQ - YAML PROCESSOR
// ============================================================================

/**
 * Options for yq execution
 */
export interface YqOptions {
  /** Output format */
  output?: 'yaml' | 'json' | 'props' | 'csv'
  /** Compact JSON output */
  compact?: boolean
  /** In-place edit */
  inPlace?: boolean
}

/**
 * Simple YAML parser (subset of YAML spec)
 */
export function parseYaml(input: string): unknown {
  const lines = input.split('\n')
  const docs: unknown[] = []
  let currentDocLines: string[] = []

  for (const line of lines) {
    if (line === '---') {
      if (currentDocLines.length > 0) {
        docs.push(parseYamlDocument(currentDocLines))
        currentDocLines = []
      }
    } else {
      currentDocLines.push(line)
    }
  }

  if (currentDocLines.length > 0 || docs.length === 0) {
    docs.push(parseYamlDocument(currentDocLines))
  }

  return docs.length === 1 ? docs[0] : docs
}

/**
 * Parse a single YAML document
 */
function parseYamlDocument(lines: string[]): unknown {
  const anchors: Record<string, unknown> = {}
  return parseYamlLines(lines, 0, anchors).value
}

interface ParseResult {
  value: unknown
  consumed: number
}

/**
 * Parse YAML lines at a given indentation level
 */
function parseYamlLines(lines: string[], startIndent: number, anchors: Record<string, unknown>): ParseResult {
  const result: Record<string, unknown> = {}
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      i++
      continue
    }

    const indent = line.search(/\S/)
    if (indent < startIndent) {
      break
    }

    const content = line.trim()

    // Handle list item
    if (content.startsWith('- ')) {
      const arr: unknown[] = []
      while (i < lines.length) {
        const listLine = lines[i]
        if (!listLine.trim() || listLine.trim().startsWith('#')) {
          i++
          continue
        }
        const listIndent = listLine.search(/\S/)
        if (listIndent < startIndent || !listLine.trim().startsWith('-')) {
          break
        }
        const itemContent = listLine.trim().slice(2).trim()
        arr.push(parseYamlValue(itemContent, anchors))
        i++
      }
      return { value: arr, consumed: i }
    }

    // Handle key: value
    const colonIdx = content.indexOf(':')
    if (colonIdx > 0) {
      const key = content.slice(0, colonIdx).trim()
      let valueStr = content.slice(colonIdx + 1).trim()

      // Handle anchor definition: &anchorName
      let anchorName: string | null = null
      const anchorMatch = valueStr.match(/^&(\w+)\s*/)
      if (anchorMatch) {
        anchorName = anchorMatch[1]
        valueStr = valueStr.slice(anchorMatch[0].length)
      }

      // Handle alias: *anchorName
      const aliasMatch = valueStr.match(/^\*(\w+)$/)
      if (aliasMatch) {
        result[key] = anchors[aliasMatch[1]]
        i++
        continue
      }

      // Handle merge: <<: *anchorName
      if (key === '<<') {
        const mergeAliasMatch = valueStr.match(/^\*(\w+)$/)
        if (mergeAliasMatch) {
          const merged = anchors[mergeAliasMatch[1]]
          if (merged && typeof merged === 'object') {
            Object.assign(result, merged)
          }
        }
        i++
        continue
      }

      if (valueStr) {
        // Inline value
        const value = parseYamlValue(valueStr, anchors)
        if (anchorName) {
          anchors[anchorName] = value
        }
        result[key] = value
        i++
      } else {
        // Nested structure
        i++
        const nextIndent = i < lines.length ? lines[i].search(/\S/) : 0
        if (nextIndent > indent) {
          const nested = parseYamlLines(lines.slice(i), nextIndent, anchors)
          if (anchorName) {
            anchors[anchorName] = nested.value
          }
          result[key] = nested.value
          i += nested.consumed
        } else {
          result[key] = null
        }
      }
    } else {
      i++
    }
  }

  return { value: result, consumed: i }
}

/**
 * Parse a YAML value
 */
function parseYamlValue(str: string, anchors: Record<string, unknown>): unknown {
  const trimmed = str.trim()

  // Handle anchor reference
  if (trimmed.startsWith('*')) {
    const anchorName = trimmed.slice(1)
    return anchors[anchorName]
  }

  // Handle quoted strings
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }

  // Handle inline array
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1)
    if (!inner.trim()) return []
    return inner.split(',').map((s) => parseYamlValue(s.trim(), anchors))
  }

  // Handle inline object
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1)
    if (!inner.trim()) return {}
    const obj: Record<string, unknown> = {}
    const pairs = inner.split(',')
    for (const pair of pairs) {
      const [k, v] = pair.split(':').map((s) => s.trim())
      if (k && v !== undefined) {
        obj[k] = parseYamlValue(v, anchors)
      }
    }
    return obj
  }

  // Handle numbers
  if (/^-?\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10)
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return parseFloat(trimmed)
  }

  // Handle booleans
  if (trimmed === 'true' || trimmed === 'yes' || trimmed === 'on') {
    return true
  }
  if (trimmed === 'false' || trimmed === 'no' || trimmed === 'off') {
    return false
  }

  // Handle null
  if (trimmed === 'null' || trimmed === '~' || trimmed === '') {
    return null
  }

  // Plain string
  return trimmed
}

/**
 * Stringify to YAML format
 */
export function stringifyYaml(data: unknown, indent: number = 0): string {
  const prefix = '  '.repeat(indent)

  if (data === null || data === undefined) {
    return 'null'
  }

  if (typeof data === 'string') {
    // Quote if contains special characters
    if (/[:\[\]{}"'#|>&*!?]/.test(data) || /^\s|\s$/.test(data)) {
      return JSON.stringify(data)
    }
    return data
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return String(data)
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return '[]'
    return data.map((item) => `${prefix}- ${stringifyYaml(item, indent + 1).trimStart()}`).join('\n')
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data)
    if (entries.length === 0) return '{}'

    return entries
      .map(([key, value]) => {
        if (value && typeof value === 'object') {
          return `${prefix}${key}:\n${stringifyYaml(value, indent + 1)}`
        }
        return `${prefix}${key}: ${stringifyYaml(value, indent)}`
      })
      .join('\n')
  }

  return String(data)
}

/**
 * Execute yq command
 */
export function executeYq(query: string, input: string, options: YqOptions = {}): string {
  // Parse YAML
  let data: unknown
  try {
    data = parseYaml(input)
  } catch (e) {
    throw new Error(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Handle multi-document queries
  const docs = Array.isArray(data) && input.includes('---') ? (data as unknown[]) : [data]

  // Process query
  let result: unknown

  // Handle eval-all
  if (query.startsWith('eval-all ')) {
    query = query.slice(9).trim()
  }

  // Handle document_index selection
  const docIndexMatch = query.match(/select\(document_index\s*==\s*(\d+)\)/)
  if (docIndexMatch) {
    const idx = parseInt(docIndexMatch[1], 10)
    result = docs[idx]
  } else if (query === '.') {
    result = docs.length === 1 ? docs[0] : docs
  } else if (query.startsWith('.') && query.includes(' = ')) {
    // Assignment
    const [path, valueExpr] = query.split(' = ')
    const pathParts = path.slice(1).split('.')
    const value = parseYamlValue(valueExpr.replace(/^\\?"/, '').replace(/\\?"$/, ''), {})
    result = setPath(docs[0], pathParts, value)
  } else if (query.startsWith('del(')) {
    // Deletion
    const pathMatch = query.match(/del\(\.(\w+)\)/)
    if (pathMatch) {
      const obj = { ...(docs[0] as Record<string, unknown>) }
      delete obj[pathMatch[1]]
      result = obj
    } else {
      result = docs[0]
    }
  } else if (query.startsWith('explode(')) {
    // Explode anchors (already expanded during parse)
    result = docs[0]
  } else if (query.includes(' += ')) {
    // Append to array
    const [path, valueExpr] = query.split(' += ')
    const pathParts = path.slice(1).split('.')
    const arr = getPath(docs[0], path.slice(1)) as unknown[]
    const newItems = JSON.parse(valueExpr.replace(/\\"/g, '"'))
    result = setPath(docs[0], pathParts, [...arr, ...newItems])
  } else {
    // Use jq-style evaluation
    result = evaluateJq(query, docs[0], { vars: {}, argjson: {} })
  }

  // Format output
  if (options.output === 'json') {
    return options.compact ? JSON.stringify(result) + '\n' : JSON.stringify(result, null, 2) + '\n'
  }

  if (options.output === 'props') {
    return formatAsProps(result)
  }

  if (options.output === 'csv') {
    return formatAsCsv(result)
  }

  // Default YAML output
  if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
    return String(result) + '\n'
  }

  return stringifyYaml(result) + '\n'
}

/**
 * Set value at path in object
 */
function setPath(obj: unknown, path: string[], value: unknown): unknown {
  if (path.length === 0) return value

  const result = { ...(obj as Record<string, unknown>) }
  const [head, ...rest] = path

  if (rest.length === 0) {
    result[head] = value
  } else {
    result[head] = setPath(result[head], rest, value)
  }

  return result
}

/**
 * Format as properties
 */
function formatAsProps(data: unknown, prefix: string = ''): string {
  const lines: string[] = []

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (value && typeof value === 'object') {
        lines.push(formatAsProps(value, path))
      } else {
        lines.push(`${path} = ${value}`)
      }
    }
  }

  return lines.join('\n') + '\n'
}

/**
 * Format as CSV
 */
function formatAsCsv(data: unknown): string {
  if (Array.isArray(data)) {
    return data.map((item) => (Array.isArray(item) ? item.join(',') : String(item))).join('\n') + '\n'
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    const keys = Object.keys(obj)
    const values = Object.values(obj)
    return keys.join(',') + '\n' + values.join(',') + '\n'
  }
  return String(data) + '\n'
}

// ============================================================================
// BASE64 - ENCODING/DECODING
// ============================================================================

/**
 * Options for base64 execution
 */
export interface Base64Options {
  /** Decode mode */
  decode?: boolean
  /** Line wrap width (0 = no wrap) */
  wrap?: number
  /** Ignore garbage characters when decoding */
  ignoreGarbage?: boolean
  /** URL-safe mode */
  urlSafe?: boolean
}

/**
 * Execute base64 encoding/decoding
 */
export function executeBase64(input: string, options: Base64Options = {}): string {
  if (options.decode) {
    return decodeBase64(input, options)
  }
  return encodeBase64(input, options)
}

/**
 * Encode string to base64
 */
function encodeBase64(input: string, options: Base64Options): string {
  let encoded: string

  if (options.urlSafe) {
    // URL-safe base64
    encoded = btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  } else {
    encoded = btoa(input)
  }

  // Apply line wrapping
  const wrap = options.wrap ?? 76
  if (wrap > 0 && encoded.length > wrap) {
    const lines: string[] = []
    for (let i = 0; i < encoded.length; i += wrap) {
      lines.push(encoded.slice(i, i + wrap))
    }
    return lines.join('\n') + '\n'
  }

  return encoded + '\n'
}

/**
 * Decode base64 string
 */
function decodeBase64(input: string, options: Base64Options): string {
  let cleaned = input

  // Remove whitespace and newlines
  cleaned = cleaned.replace(/\s/g, '')

  if (options.ignoreGarbage) {
    // Keep only valid base64 characters
    if (options.urlSafe) {
      cleaned = cleaned.replace(/[^A-Za-z0-9\-_=]/g, '')
    } else {
      cleaned = cleaned.replace(/[^A-Za-z0-9+/=]/g, '')
    }
    // For standard base64, truncate at padding (= marks end of data)
    if (!options.urlSafe) {
      const paddingMatch = cleaned.match(/^[A-Za-z0-9+/]*(={0,2})/)
      if (paddingMatch) {
        cleaned = paddingMatch[0]
      }
    }
  }

  if (options.urlSafe) {
    // Convert URL-safe back to standard
    cleaned = cleaned.replace(/-/g, '+').replace(/_/g, '/')
    // Add padding if needed
    while (cleaned.length % 4 !== 0) {
      cleaned += '='
    }
  }

  // Validate base64
  if (!options.ignoreGarbage && !options.urlSafe && !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new Base64Error('invalid base64 input')
  }

  try {
    return atob(cleaned)
  } catch (e) {
    // For URL-safe mode with invalid/short input, return empty or input as-is
    if (options.urlSafe) {
      return ''
    }
    throw new Base64Error('invalid base64 input')
  }
}

/**
 * Custom error for base64 errors
 */
export class Base64Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Base64Error'
  }
}

// ============================================================================
// ENVSUBST - ENVIRONMENT VARIABLE SUBSTITUTION
// ============================================================================

/**
 * Options for envsubst execution
 */
export interface EnvsubstOptions {
  /** Environment variables */
  env: Record<string, string>
  /** Only substitute these variables (if specified) */
  variables?: string[]
  /** List variables mode */
  listVariables?: boolean
}

/**
 * Execute environment variable substitution
 */
export function executeEnvsubst(template: string, options: EnvsubstOptions): string {
  const { env, variables, listVariables } = options

  // List variables mode
  if (listVariables) {
    const vars = extractVariables(template)
    return vars.join('\n') + '\n'
  }

  // Replace variables
  return substituteVariables(template, env, variables)
}

/**
 * Extract variable names from template
 */
function extractVariables(template: string): string[] {
  const vars = new Set<string>()

  // Match ${VAR} and $VAR patterns
  const bracedPattern = /\$\{([A-Z_][A-Z0-9_]*)(:[^}]+)?\}/gi
  const simplePattern = /\$([A-Z_][A-Z0-9_]*)/gi

  let match
  while ((match = bracedPattern.exec(template)) !== null) {
    vars.add(match[1])
  }
  while ((match = simplePattern.exec(template)) !== null) {
    vars.add(match[1])
  }

  return Array.from(vars)
}

/**
 * Substitute variables in template
 */
function substituteVariables(template: string, env: Record<string, string>, onlyVars?: string[]): string {
  let result = template

  // Handle escaped dollar signs first: $$ -> $
  result = result.replace(/\$\$/g, '\x00ESCAPED_DOLLAR\x00')

  // Handle ${VAR:modifier} patterns
  result = result.replace(/\$\{([A-Z_][A-Z0-9_]*)(:[^}]+)?\}/gi, (match, varName, modifier) => {
    // Check if we should only substitute specific variables
    if (onlyVars && !onlyVars.includes(varName)) {
      return match
    }

    const value = env[varName]
    const isEmpty = value === undefined || value === ''

    if (modifier) {
      // Parse modifier
      const modType = modifier.slice(1, 2) // First char after :
      const modValue = modifier.slice(2) // Rest

      switch (modType) {
        case '-':
          // ${VAR:-default} - use default if unset or empty
          return isEmpty ? modValue : value
        case '+':
          // ${VAR:+alternate} - use alternate if set and non-empty
          return isEmpty ? '' : modValue
        case '?':
          // ${VAR:?error} - error if unset or empty
          if (isEmpty) {
            throw new EnvsubstError(`${varName}: ${modValue}`)
          }
          return value
        case '=':
          // ${VAR:=default} - use default if unset or empty (assignment)
          return isEmpty ? modValue : value
        default:
          return value ?? ''
      }
    }

    return value ?? ''
  })

  // Handle simple $VAR patterns
  result = result.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (match, varName) => {
    // Check if we should only substitute specific variables
    if (onlyVars && !onlyVars.includes(varName)) {
      return match
    }
    return env[varName] ?? ''
  })

  // Restore escaped dollar signs
  result = result.replace(/\x00ESCAPED_DOLLAR\x00/g, '$')

  return result
}

/**
 * Custom error for envsubst errors
 */
export class EnvsubstError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvsubstError'
  }
}

// ============================================================================
// COMMAND PARSING HELPERS
// ============================================================================

/**
 * Parse jq command line arguments
 */
export function parseJqArgs(
  args: string[]
): { query: string; file?: string; options: JqOptions } {
  const options: JqOptions = {
    args: {},
    argjson: {},
  }
  let query = ''
  let file: string | undefined
  let i = 0

  while (i < args.length) {
    const arg = args[i]

    if (arg === '-r' || arg === '--raw-output') {
      options.raw = true
    } else if (arg === '-c' || arg === '--compact-output') {
      options.compact = true
    } else if (arg === '-s' || arg === '--slurp') {
      options.slurp = true
    } else if (arg === '-t' || arg === '--tab') {
      options.tab = true
    } else if (arg === '--arg' && i + 2 < args.length) {
      const name = args[++i]
      const value = args[++i]
      options.args![name] = value
    } else if (arg === '--argjson' && i + 2 < args.length) {
      const name = args[++i]
      const value = args[++i]
      options.argjson![name] = JSON.parse(value)
    } else if (!arg.startsWith('-') && !query) {
      query = arg
    } else if (!arg.startsWith('-')) {
      file = arg
    }

    i++
  }

  return { query, file, options }
}

/**
 * Parse yq command line arguments
 */
export function parseYqArgs(
  args: string[]
): { query: string; file?: string; options: YqOptions } {
  const options: YqOptions = {}
  let query = ''
  let file: string | undefined
  let i = 0

  while (i < args.length) {
    const arg = args[i]

    if (arg === '-o' && i + 1 < args.length) {
      const format = args[++i]
      if (format === 'json' || format === 'yaml' || format === 'props' || format === 'csv') {
        options.output = format
      }
    } else if (arg === '-c' || arg === '--compact-output') {
      options.compact = true
    } else if (arg === '-i' || arg === '--inplace') {
      options.inPlace = true
    } else if (arg === 'eval-all') {
      // Handled in query processing
      query = 'eval-all ' + (args[i + 1] || '.')
      i++
    } else if (!arg.startsWith('-') && !query) {
      query = arg
    } else if (!arg.startsWith('-')) {
      file = arg
    }

    i++
  }

  return { query: query || '.', file, options }
}

/**
 * Parse base64 command line arguments
 */
export function parseBase64Args(args: string[]): { file?: string; options: Base64Options } {
  const options: Base64Options = {}
  let file: string | undefined
  let i = 0

  while (i < args.length) {
    const arg = args[i]

    if (arg === '-d' || arg === '--decode' || arg === '-D') {
      options.decode = true
    } else if (arg === '-w' && i + 1 < args.length) {
      options.wrap = parseInt(args[++i], 10)
    } else if (arg.startsWith('-w')) {
      options.wrap = parseInt(arg.slice(2), 10)
    } else if (arg === '-i' || arg === '--ignore-garbage') {
      options.ignoreGarbage = true
    } else if (arg === '--url') {
      options.urlSafe = true
    } else if (!arg.startsWith('-')) {
      file = arg
    }

    i++
  }

  return { file, options }
}

/**
 * Parse envsubst command line arguments
 */
export function parseEnvsubstArgs(
  args: string[],
  env: Record<string, string>
): { options: EnvsubstOptions; inputRedirect?: string } {
  const options: EnvsubstOptions = { env }
  let inputRedirect: string | undefined
  let i = 0

  while (i < args.length) {
    const arg = args[i]

    if (arg === '--variables' || arg === '-v') {
      options.listVariables = true
    } else if (arg === '<' && i + 1 < args.length) {
      inputRedirect = args[++i]
    } else if (arg.startsWith('$')) {
      // Variable specification: envsubst '$VAR1 $VAR2'
      options.variables = arg
        .split(/\s+/)
        .filter((v) => v.startsWith('$'))
        .map((v) => v.slice(1))
    } else if (!arg.startsWith('-')) {
      // Could be variable spec or file
      if (arg.includes('$')) {
        options.variables = arg
          .split(/\s+/)
          .filter((v) => v.startsWith('$'))
          .map((v) => v.slice(1))
      }
    }

    i++
  }

  return { options, inputRedirect }
}
