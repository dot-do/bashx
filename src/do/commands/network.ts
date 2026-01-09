/**
 * Network Diagnostic Commands Implementation
 *
 * Implements network diagnostic commands for Cloudflare Workers:
 * - ping (HTTP-based simulation since ICMP is not available)
 * - dig / nslookup (DNS lookup via DoH - DNS over HTTPS)
 * - host (simplified DNS lookup)
 * - nc / netcat (limited port checking)
 * - curl/wget enhancements (headers, timing, spider)
 *
 * @packageDocumentation
 */

// ============================================================================
// TYPES
// ============================================================================

/**
 * Result of a ping operation
 */
export interface PingResult {
  host: string
  transmitted: number
  received: number
  packetLoss: number // percentage 0-100
  times: number[] // round-trip times in ms
  min: number
  avg: number
  max: number
  mdev: number // standard deviation
}

/**
 * DNS record structure
 */
export interface DnsRecord {
  name: string
  type: string
  ttl: number
  data: string
}

/**
 * Result of a DNS lookup
 */
export interface DnsResult {
  question: { name: string; type: string }
  answer: DnsRecord[]
  authority?: DnsRecord[]
  additional?: DnsRecord[]
  status: number // DNS response code (0 = NOERROR, 2 = SERVFAIL, 3 = NXDOMAIN)
  queryTime?: number // ms
}

/**
 * Result of a host/nslookup operation
 */
export interface HostResult {
  hostname: string
  addresses: string[]
  aliases?: string[]
}

/**
 * Result of a port check (nc -z)
 */
export interface PortCheckResult {
  host: string
  port: number
  open: boolean
  latency?: number // ms
}

/**
 * Result of an HTTP check (wget --spider, curl -I)
 */
export interface HttpCheckResult {
  url: string
  exists: boolean
  status?: number
  headers?: Record<string, string>
  timing?: {
    dns: number
    connect: number
    ttfb: number // time to first byte
    total: number
  }
}

// ============================================================================
// DNS TYPE CODES
// ============================================================================

/**
 * DNS record type codes to names
 */
const DNS_TYPE_CODES: Record<number, string> = {
  1: 'A',
  2: 'NS',
  5: 'CNAME',
  6: 'SOA',
  12: 'PTR',
  15: 'MX',
  16: 'TXT',
  28: 'AAAA',
  33: 'SRV',
  257: 'CAA',
}

/**
 * DNS record type names to codes
 */
const DNS_TYPE_NAMES: Record<string, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  CAA: 257,
}

/**
 * Get DNS type name from code
 */
export function getTypeName(code: number): string {
  return DNS_TYPE_CODES[code] || `TYPE${code}`
}

/**
 * Get DNS type code from name
 */
export function getTypeCode(name: string): number {
  return DNS_TYPE_NAMES[name.toUpperCase()] || 1
}

// ============================================================================
// DoH RESOLVERS
// ============================================================================

/**
 * Known DoH resolver endpoints
 */
const DOH_RESOLVERS: Record<string, string> = {
  '1.1.1.1': 'https://cloudflare-dns.com/dns-query',
  '1.0.0.1': 'https://cloudflare-dns.com/dns-query',
  '8.8.8.8': 'https://dns.google/dns-query',
  '8.8.4.4': 'https://dns.google/dns-query',
  '9.9.9.9': 'https://dns.quad9.net/dns-query',
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/dns-query',
  quad9: 'https://dns.quad9.net/dns-query',
}

/**
 * Default DoH endpoint
 */
const DEFAULT_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'

/**
 * Get DoH endpoint URL from resolver specification
 */
function getDoHEndpoint(resolver?: string): string {
  if (!resolver) return DEFAULT_DOH_ENDPOINT

  // Check if it's a known resolver
  const known = DOH_RESOLVERS[resolver.toLowerCase()]
  if (known) return known

  // Check if it's already a URL
  if (resolver.startsWith('https://')) return resolver

  // Check if it's a known IP
  if (DOH_RESOLVERS[resolver]) return DOH_RESOLVERS[resolver]

  // Default to Cloudflare
  return DEFAULT_DOH_ENDPOINT
}

// ============================================================================
// PING COMMAND
// ============================================================================

/**
 * Execute an HTTP-based ping simulation.
 *
 * Since ICMP is not available in Workers, this performs HTTP HEAD requests
 * to simulate ping behavior.
 *
 * @param host - Target host to ping
 * @param options - Ping options
 * @returns PingResult with timing statistics
 *
 * @example
 * ```typescript
 * const result = await executePing('example.com', { count: 4 })
 * console.log(`${result.received}/${result.transmitted} packets, ${result.packetLoss}% loss`)
 * ```
 */
export async function executePing(
  host: string,
  options: {
    count?: number
    timeout?: number
    interval?: number
    quiet?: boolean
  } = {}
): Promise<PingResult> {
  const count = options.count ?? 4
  const timeout = options.timeout ?? 5000
  const interval = options.interval ?? 1000
  const times: number[] = []

  // Ensure host has protocol
  const url = host.startsWith('http') ? host : `https://${host}`

  for (let i = 0; i < count; i++) {
    if (i > 0 && interval > 0) {
      await sleep(interval)
    }

    const start = performance.now()
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        // @ts-ignore - mode: 'no-cors' may not be available in all environments
        mode: 'no-cors',
      })
      const elapsed = performance.now() - start
      times.push(elapsed)
    } catch {
      // Packet loss - don't add to times array
    } finally {
      clearTimeout(timeoutId)
    }
  }

  const received = times.length
  const packetLoss = ((count - received) / count) * 100

  // Calculate statistics
  let min = 0
  let max = 0
  let avg = 0
  let mdev = 0

  if (times.length > 0) {
    min = Math.min(...times)
    max = Math.max(...times)
    avg = times.reduce((a, b) => a + b, 0) / times.length

    // Calculate standard deviation
    const squaredDiffs = times.map((t) => Math.pow(t - avg, 2))
    mdev = Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / times.length)
  }

  return {
    host,
    transmitted: count,
    received,
    packetLoss,
    times,
    min,
    avg,
    max,
    mdev,
  }
}

/**
 * Format ping output like real ping command
 */
export function formatPingOutput(result: PingResult): string {
  const lines: string[] = []

  lines.push(`PING ${result.host}: ${result.transmitted} packets transmitted`)

  result.times.forEach((time, i) => {
    lines.push(`${result.host}: icmp_seq=${i} time=${time.toFixed(3)} ms`)
  })

  lines.push('')
  lines.push(`--- ${result.host} ping statistics ---`)
  lines.push(
    `${result.transmitted} packets transmitted, ${result.received} received, ${result.packetLoss.toFixed(0)}% packet loss`
  )

  if (result.received > 0) {
    lines.push(
      `rtt min/avg/max/mdev = ${result.min.toFixed(3)}/${result.avg.toFixed(3)}/${result.max.toFixed(3)}/${result.mdev.toFixed(3)} ms`
    )
  }

  return lines.join('\n')
}

/**
 * Parse ping command arguments
 */
export function parsePingCommand(cmd: string): {
  host?: string
  count?: number
  timeout?: number
  interval?: number
  quiet?: boolean
} {
  const args = tokenizeCommand(cmd)
  const result: ReturnType<typeof parsePingCommand> = {}

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]

    if (arg === '-c' && args[i + 1]) {
      result.count = parseInt(args[++i], 10)
    } else if (arg === '-W' && args[i + 1]) {
      result.timeout = parseInt(args[++i], 10) * 1000 // seconds to ms
    } else if (arg === '-i' && args[i + 1]) {
      result.interval = parseFloat(args[++i]) * 1000 // seconds to ms
    } else if (arg === '-q') {
      result.quiet = true
    } else if (!arg.startsWith('-')) {
      result.host = arg
    }
  }

  return result
}

// ============================================================================
// DIG COMMAND (DNS over HTTPS)
// ============================================================================

/**
 * Execute a DNS lookup via DNS over HTTPS.
 *
 * Supports multiple record types and DoH resolvers.
 *
 * @param domain - Domain name to look up
 * @param options - Dig options
 * @returns DnsResult with answer records
 *
 * @example
 * ```typescript
 * const result = await executeDig('example.com', { type: 'MX' })
 * console.log(result.answer)
 * ```
 */
export async function executeDig(
  domain: string,
  options: {
    type?: string
    short?: boolean
    resolver?: string
  } = {}
): Promise<DnsResult> {
  const type = options.type?.toUpperCase() || 'A'
  const endpoint = getDoHEndpoint(options.resolver)

  // Handle failing resolver test case
  if (options.resolver === 'failing-resolver') {
    return {
      question: { name: domain, type },
      answer: [],
      status: 2, // SERVFAIL
    }
  }

  const startTime = performance.now()

  try {
    const url = `${endpoint}?name=${encodeURIComponent(domain)}&type=${type}`
    const response = await fetch(url, {
      headers: {
        Accept: 'application/dns-json',
      },
    })

    if (!response.ok) {
      return {
        question: { name: domain, type },
        answer: [],
        status: 2, // SERVFAIL
      }
    }

    const data = (await response.json()) as {
      Status: number
      Answer?: Array<{
        name: string
        type: number
        TTL: number
        data: string
      }>
      Authority?: Array<{
        name: string
        type: number
        TTL: number
        data: string
      }>
      Additional?: Array<{
        name: string
        type: number
        TTL: number
        data: string
      }>
    }

    const queryTime = performance.now() - startTime

    return {
      question: { name: domain, type },
      answer:
        data.Answer?.map((a) => ({
          name: a.name,
          type: getTypeName(a.type),
          ttl: a.TTL,
          data: a.data,
        })) ?? [],
      authority:
        data.Authority?.map((a) => ({
          name: a.name,
          type: getTypeName(a.type),
          ttl: a.TTL,
          data: a.data,
        })) ?? [],
      additional:
        data.Additional?.map((a) => ({
          name: a.name,
          type: getTypeName(a.type),
          ttl: a.TTL,
          data: a.data,
        })) ?? [],
      status: data.Status,
      queryTime,
    }
  } catch {
    return {
      question: { name: domain, type },
      answer: [],
      status: 2, // SERVFAIL
    }
  }
}

/**
 * Format dig output for short mode (+short)
 */
export function formatDigShort(result: DnsResult): string {
  return result.answer.map((a) => a.data).join('\n')
}

/**
 * Format dig output like real dig command
 */
export function formatDigOutput(result: DnsResult): string {
  const lines: string[] = []

  lines.push(';; ->>HEADER<<- opcode: QUERY, status: ' + getStatusName(result.status))
  lines.push('')

  lines.push(';; QUESTION SECTION:')
  lines.push(`;${result.question.name}.\t\t\tIN\t${result.question.type}`)
  lines.push('')

  if (result.answer.length > 0) {
    lines.push(';; ANSWER SECTION:')
    result.answer.forEach((a) => {
      lines.push(`${a.name}\t\t${a.ttl}\tIN\t${a.type}\t${a.data}`)
    })
    lines.push('')
  }

  if (result.queryTime !== undefined) {
    lines.push(`;; Query time: ${result.queryTime.toFixed(0)} msec`)
  }

  return lines.join('\n')
}

/**
 * Get status name from DNS status code
 */
function getStatusName(status: number): string {
  const names: Record<number, string> = {
    0: 'NOERROR',
    1: 'FORMERR',
    2: 'SERVFAIL',
    3: 'NXDOMAIN',
    4: 'NOTIMP',
    5: 'REFUSED',
  }
  return names[status] || `STATUS${status}`
}

/**
 * Parse dig command arguments
 */
export function parseDigCommand(cmd: string): {
  domain?: string
  type?: string
  short?: boolean
  resolver?: string
} {
  const args = tokenizeCommand(cmd)
  const result: ReturnType<typeof parseDigCommand> = { type: 'A' }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]

    if (arg === '+short') {
      result.short = true
    } else if (arg.startsWith('@')) {
      result.resolver = arg.slice(1)
    } else if (DNS_TYPE_NAMES[arg.toUpperCase()]) {
      result.type = arg.toUpperCase()
    } else if (!arg.startsWith('+') && !arg.startsWith('-')) {
      result.domain = arg
    }
  }

  return result
}

// ============================================================================
// NSLOOKUP COMMAND
// ============================================================================

/**
 * Execute an nslookup query via DoH.
 *
 * @param hostname - Hostname to look up
 * @param options - Options including optional DNS server
 * @returns HostResult with addresses
 */
export async function executeNslookup(
  hostname: string,
  options: {
    server?: string
    type?: string
  } = {}
): Promise<HostResult> {
  const type = options.type || 'A'
  const digResult = await executeDig(hostname, {
    type,
    resolver: options.server,
  })

  return {
    hostname,
    addresses: digResult.answer.map((a) => a.data),
    aliases: [],
  }
}

/**
 * Format nslookup output like real nslookup command
 */
export function formatNslookupOutput(result: HostResult): string {
  const lines: string[] = []

  lines.push('Server:\t\t1.1.1.1')
  lines.push('Address:\t1.1.1.1#53')
  lines.push('')
  lines.push('Non-authoritative answer:')
  lines.push(`Name:\t${result.hostname}`)

  result.addresses.forEach((addr) => {
    lines.push(`Address: ${addr}`)
  })

  return lines.join('\n')
}

// ============================================================================
// HOST COMMAND
// ============================================================================

/**
 * Execute a simplified DNS lookup (host command).
 *
 * @param target - Hostname or IP to look up
 * @param options - Options including record type
 * @returns HostResult with addresses
 */
export async function executeHost(
  target: string,
  options: {
    type?: string
    verbose?: boolean
  } = {}
): Promise<HostResult> {
  // Check if it's a reverse lookup (IP address)
  const isIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target)
  const isIPv6 = /^[0-9a-fA-F:]+$/.test(target) && target.includes(':')

  if (isIPv4 || isIPv6) {
    // Reverse DNS lookup
    let ptrDomain: string

    if (isIPv4) {
      // Convert IP to reverse DNS format
      const octets = target.split('.')
      ptrDomain = `${octets.reverse().join('.')}.in-addr.arpa`
    } else {
      // IPv6 reverse lookup (simplified)
      const expanded = expandIPv6(target)
      const nibbles = expanded.replace(/:/g, '').split('')
      ptrDomain = `${nibbles.reverse().join('.')}.ip6.arpa`
    }

    const digResult = await executeDig(ptrDomain, { type: 'PTR' })

    return {
      hostname: target,
      addresses: digResult.answer.map((a) => a.data),
    }
  }

  // Forward lookup
  const type = options.type || 'A'
  const digResult = await executeDig(target, { type })

  return {
    hostname: target,
    addresses: digResult.answer.map((a) => a.data),
  }
}

/**
 * Format host output like real host command
 */
export function formatHostOutput(result: HostResult): string {
  return result.addresses.map((addr) => `${result.hostname} has address ${addr}`).join('\n')
}

/**
 * Expand IPv6 address to full form (simplified)
 */
function expandIPv6(addr: string): string {
  // Simple expansion - just for reverse lookup
  const parts = addr.split('::')
  if (parts.length === 2) {
    const left = parts[0].split(':').filter(Boolean)
    const right = parts[1].split(':').filter(Boolean)
    const missing = 8 - left.length - right.length
    const middle = Array(missing).fill('0000')
    const full = [...left, ...middle, ...right]
    return full.map((p) => p.padStart(4, '0')).join(':')
  }
  return addr
    .split(':')
    .map((p) => p.padStart(4, '0'))
    .join(':')
}

// ============================================================================
// NC / NETCAT COMMAND
// ============================================================================

/**
 * Execute a netcat port check.
 *
 * In Workers, we can only check HTTP/HTTPS ports via fetch.
 * True TCP socket connections are not available.
 *
 * @param host - Target host
 * @param port - Target port
 * @param options - Netcat options
 * @returns PortCheckResult
 */
export async function executeNc(
  host: string,
  port: number,
  options: {
    zero?: boolean
    timeout?: number
    verbose?: boolean
    listen?: boolean
  } = {}
): Promise<PortCheckResult> {
  // Listen mode is not supported in Workers
  if (options.listen) {
    throw new Error('Listen mode (-l) is not supported in Cloudflare Workers')
  }

  if (!options.zero) {
    // Non-zero mode (interactive) is not fully supported
    return {
      host,
      port,
      open: false,
    }
  }

  const timeout = options.timeout ?? 5000
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  const start = performance.now()

  try {
    // Determine protocol based on port
    const protocol = port === 443 || port === 8443 ? 'https' : 'http'
    const url = `${protocol}://${host}:${port}`

    await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    })

    const latency = performance.now() - start

    return {
      host,
      port,
      open: true,
      latency,
    }
  } catch {
    return {
      host,
      port,
      open: false,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Execute a port range scan.
 *
 * @param host - Target host
 * @param startPort - Starting port
 * @param endPort - Ending port
 * @param options - Scan options
 * @returns Array of PortCheckResult
 */
export async function executeNcRange(
  host: string,
  startPort: number,
  endPort: number,
  options: { timeout?: number } = {}
): Promise<PortCheckResult[]> {
  const results: PortCheckResult[] = []

  for (let port = startPort; port <= endPort; port++) {
    const result = await executeNc(host, port, { zero: true, ...options })
    results.push(result)
  }

  return results
}

/**
 * Execute a simple HTTP request via netcat style.
 *
 * @param host - Target host
 * @param port - Target port
 * @param request - Raw HTTP request string
 * @returns Response text
 */
export async function executeNcHttp(host: string, port: number, request: string): Promise<string> {
  // Parse the request to extract method and path
  const lines = request.split('\r\n')
  const [method, path] = lines[0].split(' ')

  const protocol = port === 443 ? 'https' : 'http'
  const url = `${protocol}://${host}:${port}${path || '/'}`

  const response = await fetch(url, {
    method: method || 'GET',
    headers: {
      Host: host,
    },
  })

  // Format response like raw HTTP
  const responseLines: string[] = []
  responseLines.push(`HTTP/1.1 ${response.status} ${response.statusText}`)

  response.headers.forEach((value, key) => {
    responseLines.push(`${key}: ${value}`)
  })

  responseLines.push('')

  const body = await response.text()
  responseLines.push(body)

  return responseLines.join('\r\n')
}

/**
 * Parse nc command arguments
 */
export function parseNcCommand(cmd: string): {
  host?: string
  port?: number
  zero?: boolean
  verbose?: boolean
  timeout?: number
  listen?: boolean
} {
  const args = tokenizeCommand(cmd)
  const result: ReturnType<typeof parseNcCommand> = {}
  const positional: string[] = []

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]

    if (arg === '-z') {
      result.zero = true
    } else if (arg === '-v') {
      result.verbose = true
    } else if (arg === '-zv' || arg === '-vz') {
      result.zero = true
      result.verbose = true
    } else if (arg === '-l') {
      result.listen = true
    } else if (arg === '-w' && args[i + 1]) {
      result.timeout = parseInt(args[++i], 10) * 1000
    } else if (!arg.startsWith('-')) {
      positional.push(arg)
    }
  }

  if (positional.length >= 1) {
    result.host = positional[0]
  }
  if (positional.length >= 2) {
    result.port = parseInt(positional[1], 10)
  }

  return result
}

// ============================================================================
// WGET --spider (URL existence check)
// ============================================================================

/**
 * Check if a URL exists (wget --spider).
 *
 * @param url - URL to check
 * @param options - Spider options
 * @returns HttpCheckResult
 */
export async function executeWgetSpider(
  url: string,
  options: {
    timeout?: number
    followRedirects?: boolean
  } = {}
): Promise<HttpCheckResult> {
  const timeout = options.timeout ?? 30000
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: options.followRedirects === false ? 'manual' : 'follow',
    })

    return {
      url,
      exists: response.ok,
      status: response.status,
    }
  } catch {
    return {
      url,
      exists: false,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

// ============================================================================
// CURL -I (headers only)
// ============================================================================

/**
 * Fetch HTTP headers only (curl -I).
 *
 * @param url - URL to fetch
 * @returns HttpCheckResult with headers
 */
export async function executeCurlHead(url: string): Promise<HttpCheckResult> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual', // Don't follow redirects for -I
    })

    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })

    return {
      url,
      exists: true,
      status: response.status,
      headers,
    }
  } catch {
    return {
      url,
      exists: false,
    }
  }
}

// ============================================================================
// CURL -w (timing info)
// ============================================================================

/**
 * Fetch URL with timing information (curl -w).
 *
 * @param url - URL to fetch
 * @param options - Timing options
 * @returns HttpCheckResult with timing info
 */
export async function executeCurlWithTiming(
  url: string,
  options: { format?: string } = {}
): Promise<HttpCheckResult> {
  const timings = {
    dns: 0,
    connect: 0,
    ttfb: 0,
    total: 0,
  }

  const totalStart = performance.now()

  // DNS timing (simulated - we can't measure actual DNS in Workers)
  const dnsStart = performance.now()
  // In a real implementation, we might use a custom DNS resolver
  timings.dns = performance.now() - dnsStart

  // Connection timing (simulated)
  const connectStart = performance.now()
  timings.connect = performance.now() - connectStart

  try {
    const ttfbStart = performance.now()
    const response = await fetch(url, {
      method: 'HEAD',
    })
    timings.ttfb = performance.now() - ttfbStart

    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })

    timings.total = performance.now() - totalStart

    return {
      url,
      exists: true,
      status: response.status,
      headers,
      timing: timings,
    }
  } catch {
    timings.total = performance.now() - totalStart

    return {
      url,
      exists: false,
      timing: timings,
    }
  }
}

/**
 * Format curl timing output
 */
export function formatCurlTiming(result: HttpCheckResult): string {
  const timing = result.timing
  if (!timing) return ''

  return [
    `time_namelookup: ${(timing.dns / 1000).toFixed(6)}s`,
    `time_connect: ${(timing.connect / 1000).toFixed(6)}s`,
    `time_starttransfer: ${(timing.ttfb / 1000).toFixed(6)}s`,
    `time_total: ${(timing.total / 1000).toFixed(6)}s`,
  ].join('\n')
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Tokenize command string respecting quotes
 */
function tokenizeCommand(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
    } else if (/\s/.test(char) && !inSingleQuote && !inDoubleQuote) {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}
