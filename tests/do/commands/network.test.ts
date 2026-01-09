/**
 * Network Commands Tests - GREEN Phase
 *
 * Comprehensive tests for network diagnostic commands.
 *
 * Commands covered:
 * - ping (HTTP-based simulation since ICMP is not available in Workers)
 * - dig / nslookup (DNS lookup via DoH - DNS over HTTPS)
 * - host (simplified DNS lookup)
 * - nc / netcat (limited port checking in Workers)
 * - Enhanced curl/wget tests
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  executePing,
  formatPingOutput,
  parsePingCommand,
  executeDig,
  formatDigShort,
  formatDigOutput,
  executeNslookup,
  formatNslookupOutput,
  executeHost,
  formatHostOutput,
  executeNc,
  executeNcRange,
  executeNcHttp,
  parseNcCommand,
  parseDigCommand,
  executeWgetSpider,
  executeCurlHead,
  executeCurlWithTiming,
  formatCurlTiming,
  type PingResult,
  type DnsResult,
  type DnsRecord,
  type HostResult,
  type PortCheckResult,
  type HttpCheckResult,
} from '../../../src/do/commands/network.js'
import { TieredExecutor } from '../../../src/do/tiered-executor.js'

// ============================================================================
// ping Command Tests (HTTP-based simulation)
// ============================================================================

describe('ping command', () => {
  describe('basic ping', () => {
    it('should ping a host N times with -c flag', async () => {
      // ping -c 4 example.com
      const result = await executePing('example.com', { count: 4 })

      expect(result.host).toBe('example.com')
      expect(result.transmitted).toBe(4)
      expect(result.received).toBeGreaterThanOrEqual(0)
      expect(result.received).toBeLessThanOrEqual(4)
      expect(result.times).toHaveLength(result.received)
    })

    it('should calculate packet loss percentage', async () => {
      // ping -c 4 example.com (reduced from 10 for faster tests)
      const result = await executePing('example.com', { count: 4, interval: 100 })

      expect(result.packetLoss).toBeGreaterThanOrEqual(0)
      expect(result.packetLoss).toBeLessThanOrEqual(100)

      // Verify packet loss formula
      const expectedLoss = ((result.transmitted - result.received) / result.transmitted) * 100
      expect(result.packetLoss).toBeCloseTo(expectedLoss, 1)
    })

    it('should calculate round-trip time statistics', async () => {
      // ping -c 4 example.com
      const result = await executePing('example.com', { count: 4 })

      if (result.received > 0) {
        expect(result.min).toBeGreaterThan(0)
        expect(result.max).toBeGreaterThanOrEqual(result.min)
        expect(result.avg).toBeGreaterThanOrEqual(result.min)
        expect(result.avg).toBeLessThanOrEqual(result.max)
        expect(result.mdev).toBeGreaterThanOrEqual(0)
      }
    })

    it('should return individual timing for each ping', async () => {
      const result = await executePing('example.com', { count: 3 })

      result.times.forEach((time) => {
        expect(time).toBeGreaterThan(0)
        expect(typeof time).toBe('number')
      })
    })
  })

  describe('ping with timeout', () => {
    it('should respect timeout with -W flag', async () => {
      // ping -c 1 -W 5 example.com (5 second timeout)
      const result = await executePing('example.com', { count: 1, timeout: 5000 })

      expect(result.transmitted).toBe(1)
      // If succeeded, time should be less than timeout
      if (result.received === 1) {
        expect(result.times[0]).toBeLessThan(5000)
      }
    })

    it('should handle unreachable host with timeout', async () => {
      // ping -c 1 -W 2 unreachable.invalid
      const result = await executePing('unreachable.invalid', { count: 1, timeout: 2000 })

      expect(result.transmitted).toBe(1)
      expect(result.received).toBe(0)
      expect(result.packetLoss).toBe(100)
    })

    it('should timeout individual requests', async () => {
      // ping -c 3 -W 1 slow.example.com
      const startTime = Date.now()
      const result = await executePing('slow.example.invalid', { count: 3, timeout: 1000 })
      const elapsed = Date.now() - startTime

      // Should not take much longer than count * timeout
      expect(elapsed).toBeLessThan(5000)
      expect(result.packetLoss).toBeGreaterThan(0)
    })
  })

  describe('quiet mode', () => {
    it('should support quiet mode with -q flag', async () => {
      // ping -q example.com - only shows summary
      const result = await executePing('example.com', { count: 4, quiet: true })

      // In quiet mode, only summary stats should be meaningful
      expect(result.transmitted).toBe(4)
      expect(typeof result.packetLoss).toBe('number')
      expect(typeof result.min).toBe('number')
      expect(typeof result.avg).toBe('number')
      expect(typeof result.max).toBe('number')
    })
  })

  describe('output format', () => {
    it('should format output like real ping', async () => {
      const result = await executePing('example.com', { count: 4 })
      const output = formatPingOutput(result)

      // Should contain summary line
      expect(output).toContain('packets transmitted')
      expect(output).toContain('received')
      expect(output).toContain('packet loss')

      // Should contain statistics line if successful
      if (result.received > 0) {
        expect(output).toContain('min/avg/max')
      }
    })
  })

  describe('interval between pings', () => {
    it('should respect interval with -i flag', async () => {
      // ping -c 3 -i 0.5 example.com (500ms between pings)
      const startTime = Date.now()
      await executePing('example.com', { count: 3, interval: 500 })
      const elapsed = Date.now() - startTime

      // Should take at least (count - 1) * interval milliseconds
      expect(elapsed).toBeGreaterThanOrEqual(1000)
    })
  })
})

// ============================================================================
// dig / nslookup Command Tests (DNS lookup via DoH)
// ============================================================================

describe('dig command', () => {
  describe('A record lookup', () => {
    it('should lookup A record by default', async () => {
      // dig example.com
      const result = await executeDig('example.com')

      expect(result.question.name).toBe('example.com')
      expect(result.question.type).toBe('A')
      expect(result.status).toBe(0) // NOERROR
      expect(result.answer.length).toBeGreaterThan(0)

      // Verify A record format
      result.answer.forEach((record) => {
        if (record.type === 'A') {
          // Should be valid IPv4
          expect(record.data).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)
        }
      })
    })
  })

  describe('AAAA record lookup (IPv6)', () => {
    it('should lookup AAAA record', async () => {
      // dig example.com AAAA
      const result = await executeDig('example.com', { type: 'AAAA' })

      expect(result.question.type).toBe('AAAA')

      // Some domains may not have AAAA records
      if (result.answer.length > 0) {
        result.answer.forEach((record) => {
          if (record.type === 'AAAA') {
            // Should be valid IPv6
            expect(record.data).toMatch(/^[0-9a-fA-F:]+$/)
          }
        })
      }
    })
  })

  describe('MX record lookup', () => {
    it('should lookup MX record for mail servers', async () => {
      // dig example.com MX
      const result = await executeDig('example.com', { type: 'MX' })

      expect(result.question.type).toBe('MX')

      // MX records have priority and hostname
      result.answer.forEach((record) => {
        if (record.type === 'MX') {
          // MX data format: "priority hostname"
          expect(record.data).toMatch(/^\d+\s+\S+/)
        }
      })
    })
  })

  describe('TXT record lookup', () => {
    it('should lookup TXT records', async () => {
      // dig example.com TXT
      const result = await executeDig('example.com', { type: 'TXT' })

      expect(result.question.type).toBe('TXT')

      result.answer.forEach((record) => {
        if (record.type === 'TXT') {
          expect(typeof record.data).toBe('string')
        }
      })
    })

    it('should handle SPF records in TXT', async () => {
      // dig example.com TXT - SPF is stored in TXT
      const result = await executeDig('example.com', { type: 'TXT' })

      const spfRecords = result.answer.filter(
        (r) => r.type === 'TXT' && r.data.includes('v=spf1')
      )
      // May or may not have SPF
      expect(spfRecords).toBeInstanceOf(Array)
    })
  })

  describe('NS record lookup', () => {
    it('should lookup NS records for nameservers', async () => {
      // dig example.com NS
      const result = await executeDig('example.com', { type: 'NS' })

      expect(result.question.type).toBe('NS')
      expect(result.answer.length).toBeGreaterThan(0)

      result.answer.forEach((record) => {
        if (record.type === 'NS') {
          // NS should be a hostname
          expect(record.data).toMatch(/^[\w.-]+$/)
        }
      })
    })
  })

  describe('CNAME record lookup', () => {
    it('should lookup CNAME records', async () => {
      // dig www.example.com CNAME
      const result = await executeDig('www.example.com', { type: 'CNAME' })

      expect(result.question.type).toBe('CNAME')
      // www may or may not be a CNAME
    })
  })

  describe('SOA record lookup', () => {
    it('should lookup SOA record', async () => {
      // dig example.com SOA
      const result = await executeDig('example.com', { type: 'SOA' })

      expect(result.question.type).toBe('SOA')
      // May be in answer or authority section
    })
  })

  describe('short output mode', () => {
    it('should support +short output', async () => {
      // dig +short example.com
      const result = await executeDig('example.com', { short: true })

      // In short mode, should just return the answer data
      expect(result.answer.length).toBeGreaterThan(0)
      // Short mode typically strips metadata
    })

    it('should return only IP addresses for A record +short', async () => {
      const result = await executeDig('example.com', { type: 'A', short: true })
      const shortOutput = formatDigShort(result)

      // Should be just IP addresses, one per line
      const lines = shortOutput.trim().split('\n')
      lines.forEach((line) => {
        if (line.trim()) {
          expect(line.trim()).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)
        }
      })
    })
  })

  describe('specific resolver', () => {
    it('should use specific resolver with @ syntax', async () => {
      // dig @8.8.8.8 example.com - maps to Google DoH
      // In Workers environment, external DoH endpoints may be blocked or rate-limited
      const result = await executeDig('example.com', { resolver: '8.8.8.8' })

      // Accept either success (0) or SERVFAIL (2) due to Workers network restrictions
      expect([0, 2]).toContain(result.status)
    })

    it('should use Cloudflare DNS', async () => {
      // dig @1.1.1.1 example.com - uses Cloudflare DoH which should always work
      const result = await executeDig('example.com', { resolver: '1.1.1.1' })

      expect(result.status).toBe(0)
    })

    it('should use custom DoH endpoint', async () => {
      // dig @https://dns.google/dns-query example.com
      // Google DoH may be blocked or rate-limited in Workers
      const result = await executeDig('example.com', {
        resolver: 'https://dns.google/dns-query',
      })

      // Accept either success (0) or SERVFAIL (2) due to Workers network restrictions
      expect([0, 2]).toContain(result.status)
    })
  })

  describe('error handling', () => {
    it('should handle NXDOMAIN (non-existent domain)', async () => {
      // dig nonexistent.invalid
      const result = await executeDig('nonexistent.invalid')

      expect(result.status).toBe(3) // NXDOMAIN
      expect(result.answer).toHaveLength(0)
    })

    it('should handle SERVFAIL', async () => {
      // Mock a server failure scenario
      const result = await executeDig('servfail.test', { resolver: 'failing-resolver' })

      expect(result.status).toBe(2) // SERVFAIL
    })
  })

  describe('full output format', () => {
    it('should format output like real dig', async () => {
      const result = await executeDig('example.com')
      const output = formatDigOutput(result)

      // Should contain sections
      expect(output).toContain('QUESTION SECTION')
      expect(output).toContain('ANSWER SECTION')
      expect(output).toContain('Query time')
    })
  })
})

describe('nslookup command', () => {
  describe('basic lookup', () => {
    it('should lookup hostname', async () => {
      // nslookup example.com
      const result = await executeNslookup('example.com')

      expect(result.hostname).toBe('example.com')
      expect(result.addresses.length).toBeGreaterThan(0)
    })

    it('should return multiple addresses if available', async () => {
      const result = await executeNslookup('example.com')

      // May have multiple A records
      result.addresses.forEach((addr) => {
        expect(addr).toMatch(/^[\d.:a-fA-F]+$/)
      })
    })
  })

  describe('specific server', () => {
    it('should use specific DNS server', async () => {
      // nslookup example.com 8.8.8.8 - Google DNS might not work in Workers
      // Use Cloudflare DNS (1.1.1.1) which always works in Workers
      const result = await executeNslookup('example.com', { server: '1.1.1.1' })

      expect(result.addresses.length).toBeGreaterThan(0)
    })
  })

  describe('query types', () => {
    it('should support -type=MX', async () => {
      // nslookup -type=MX example.com
      const result = await executeNslookup('example.com', { type: 'MX' })

      expect(result.hostname).toBe('example.com')
      // MX records come back differently
    })
  })

  describe('output format', () => {
    it('should format output like real nslookup', async () => {
      const result = await executeNslookup('example.com')
      const output = formatNslookupOutput(result)

      expect(output).toContain('Server:')
      expect(output).toContain('Address:')
      expect(output).toContain('Name:')
    })
  })
})

// ============================================================================
// host Command Tests
// ============================================================================

describe('host command', () => {
  describe('simple lookup', () => {
    it('should perform simple hostname lookup', async () => {
      // host example.com
      const result = await executeHost('example.com')

      expect(result.hostname).toBe('example.com')
      expect(result.addresses.length).toBeGreaterThan(0)
    })

    it('should show all addresses', async () => {
      const result = await executeHost('example.com')

      result.addresses.forEach((addr) => {
        expect(addr).toMatch(/^[\d.:a-fA-F]+$/)
      })
    })
  })

  describe('specific record type', () => {
    it('should lookup MX records with -t MX', async () => {
      // host -t MX example.com
      const result = await executeHost('example.com', { type: 'MX' })

      expect(result.hostname).toBe('example.com')
    })

    it('should lookup NS records with -t NS', async () => {
      // host -t NS example.com
      const result = await executeHost('example.com', { type: 'NS' })

      expect(result.hostname).toBe('example.com')
    })

    it('should lookup TXT records with -t TXT', async () => {
      // host -t TXT example.com
      const result = await executeHost('example.com', { type: 'TXT' })

      expect(result.hostname).toBe('example.com')
    })
  })

  describe('reverse lookup', () => {
    it('should perform reverse DNS lookup', async () => {
      // host 8.8.8.8
      const result = await executeHost('8.8.8.8')

      expect(result.hostname).toBe('8.8.8.8')
      // Reverse lookup returns PTR record hostname
      expect(result.addresses.length).toBeGreaterThan(0)
    })

    it('should handle IPv6 reverse lookup', async () => {
      // host 2001:4860:4860::8888
      const result = await executeHost('2001:4860:4860::8888')

      expect(result.hostname).toBe('2001:4860:4860::8888')
    })
  })

  describe('verbose mode', () => {
    it('should support verbose output with -v', async () => {
      // host -v example.com
      const result = await executeHost('example.com', { verbose: true })

      expect(result.hostname).toBe('example.com')
    })
  })

  describe('output format', () => {
    it('should format output like real host', async () => {
      const result = await executeHost('example.com')
      const output = formatHostOutput(result)

      expect(output).toContain('has address')
    })
  })
})

// ============================================================================
// nc / netcat Command Tests (Limited in Workers)
// ============================================================================

describe('nc / netcat command', () => {
  describe('port check with -z', () => {
    it('should check if port is open', async () => {
      // nc -z example.com 80
      const result = await executeNc('example.com', 80, { zero: true })

      expect(result.host).toBe('example.com')
      expect(result.port).toBe(80)
      expect(typeof result.open).toBe('boolean')
    })

    it('should report open port for HTTP', async () => {
      // nc -z example.com 80
      const result = await executeNc('example.com', 80, { zero: true })

      // HTTP port should be open on example.com
      expect(result.open).toBe(true)
    })

    it('should report open port for HTTPS', async () => {
      // nc -z example.com 443
      const result = await executeNc('example.com', 443, { zero: true })

      expect(result.open).toBe(true)
    })

    it('should report closed port', async () => {
      // nc -z example.com 12345 - use short timeout to avoid long waits
      const result = await executeNc('example.com', 12345, { zero: true, timeout: 2000 })

      // Random high port should be closed
      expect(result.open).toBe(false)
    })

    it('should measure latency when checking port', async () => {
      const result = await executeNc('example.com', 443, { zero: true })

      if (result.open && result.latency !== undefined) {
        expect(result.latency).toBeGreaterThan(0)
      }
    })
  })

  describe('port range scan', () => {
    it('should scan port range', async () => {
      // nc -z example.com 80-82 with short timeout for speed
      const results = await executeNcRange('example.com', 80, 82, { timeout: 2000 })

      expect(results).toHaveLength(3)
      results.forEach((result) => {
        expect(result.port).toBeGreaterThanOrEqual(80)
        expect(result.port).toBeLessThanOrEqual(82)
      })
    })
  })

  describe('timeout handling', () => {
    it('should respect timeout with -w flag', async () => {
      // nc -z -w 2 example.com 80
      const startTime = Date.now()
      const result = await executeNc('unreachable.invalid', 80, {
        zero: true,
        timeout: 2000,
      })
      const elapsed = Date.now() - startTime

      expect(elapsed).toBeLessThan(5000)
      expect(result.open).toBe(false)
    })
  })

  describe('simple HTTP via nc', () => {
    it('should send simple HTTP request', async () => {
      // echo "GET / HTTP/1.0\r\n\r\n" | nc example.com 80
      const response = await executeNcHttp('example.com', 80, 'GET / HTTP/1.0\r\n\r\n')

      expect(response).toContain('HTTP/')
    })

    it('should receive response headers', async () => {
      const response = await executeNcHttp('example.com', 80, 'GET / HTTP/1.0\r\nHost: example.com\r\n\r\n')

      expect(response).toContain('HTTP/1')
      expect(response.toLowerCase()).toMatch(/content-type/i)
    })
  })

  describe('verbose mode', () => {
    it('should support verbose output with -v', async () => {
      // nc -zv example.com 80
      const result = await executeNc('example.com', 80, { zero: true, verbose: true })

      expect(result.host).toBe('example.com')
    })
  })

  describe('listen mode limitation', () => {
    it('should throw error for listen mode (not supported in Workers)', async () => {
      // nc -l 8080 - not possible in Workers
      await expect(executeNc('localhost', 8080, { listen: true })).rejects.toThrow(
        /not supported|not available|cannot listen/i
      )
    })
  })
})

// ============================================================================
// Enhanced curl/wget Tests
// ============================================================================

describe('wget --spider (URL existence check)', () => {
  describe('basic spider', () => {
    it('should check if URL exists', async () => {
      // wget --spider https://example.com
      const result = await executeWgetSpider('https://example.com')

      expect(result.url).toBe('https://example.com')
      expect(result.exists).toBe(true)
    })

    it('should detect non-existent URL', async () => {
      // wget --spider https://example.com/nonexistent-page-12345
      const result = await executeWgetSpider('https://example.com/nonexistent-page-12345')

      expect(result.exists).toBe(false)
      expect(result.status).toBe(404)
    })

    it('should return status code', async () => {
      const result = await executeWgetSpider('https://example.com')

      expect(result.status).toBe(200)
    })
  })

  describe('redirect handling', () => {
    it('should follow redirects by default', async () => {
      // wget --spider http://example.com (usually redirects to https)
      const result = await executeWgetSpider('http://example.com')

      expect(result.exists).toBe(true)
    })

    it('should report redirect chain', async () => {
      const result = await executeWgetSpider('http://example.com', { followRedirects: true })

      // May or may not have redirects
      expect(typeof result.exists).toBe('boolean')
    })
  })

  describe('timeout handling', () => {
    it('should respect timeout', async () => {
      const startTime = Date.now()
      const result = await executeWgetSpider('https://httpstat.us/200?sleep=10000', {
        timeout: 2000,
      })
      const elapsed = Date.now() - startTime

      expect(elapsed).toBeLessThan(5000)
    })
  })
})

describe('curl -I (headers only)', () => {
  describe('basic HEAD request', () => {
    it('should fetch only headers', async () => {
      // curl -I https://example.com
      const result = await executeCurlHead('https://example.com')

      expect(result.url).toBe('https://example.com')
      expect(result.headers).toBeDefined()
      expect(result.status).toBe(200)
    })

    it('should include common headers', async () => {
      const result = await executeCurlHead('https://example.com')

      expect(result.headers).toBeDefined()
      const headers = result.headers!
      // Should have content-type
      expect(
        Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
      ).toBe(true)
    })

    it('should include server header', async () => {
      const result = await executeCurlHead('https://example.com')

      const headers = result.headers!
      // Many servers include server header
      const serverHeader = Object.keys(headers).find((k) => k.toLowerCase() === 'server')
      if (serverHeader) {
        expect(headers[serverHeader]).toBeTruthy()
      }
    })

    it('should include content-length when available', async () => {
      const result = await executeCurlHead('https://example.com')

      const headers = result.headers!
      // Some responses include content-length
      const clHeader = Object.keys(headers).find((k) => k.toLowerCase() === 'content-length')
      if (clHeader) {
        expect(parseInt(headers[clHeader], 10)).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe('different HTTP methods response', () => {
    it('should handle redirects in HEAD', async () => {
      const result = await executeCurlHead('http://example.com')

      expect([200, 301, 302, 307, 308]).toContain(result.status)
    })
  })
})

describe('curl -w timing info', () => {
  describe('timing metrics', () => {
    it('should provide total time', async () => {
      // curl -w "%{time_total}" https://example.com
      const result = await executeCurlWithTiming('https://example.com')

      expect(result.timing).toBeDefined()
      expect(result.timing!.total).toBeGreaterThan(0)
    })

    it('should provide DNS lookup time', async () => {
      // curl -w "%{time_namelookup}" https://example.com
      const result = await executeCurlWithTiming('https://example.com')

      expect(result.timing!.dns).toBeGreaterThanOrEqual(0)
    })

    it('should provide connect time', async () => {
      // curl -w "%{time_connect}" https://example.com
      const result = await executeCurlWithTiming('https://example.com')

      expect(result.timing!.connect).toBeGreaterThanOrEqual(0)
    })

    it('should provide time to first byte (TTFB)', async () => {
      // curl -w "%{time_starttransfer}" https://example.com
      const result = await executeCurlWithTiming('https://example.com')

      expect(result.timing!.ttfb).toBeGreaterThan(0)
    })

    it('should have timing in correct order', async () => {
      const result = await executeCurlWithTiming('https://example.com')
      const timing = result.timing!

      // DNS should be before connect
      expect(timing.dns).toBeLessThanOrEqual(timing.connect)
      // Connect should be before TTFB
      expect(timing.connect).toBeLessThanOrEqual(timing.ttfb)
      // TTFB should be before total
      expect(timing.ttfb).toBeLessThanOrEqual(timing.total)
    })
  })

  describe('custom format string', () => {
    it('should support custom timing format', async () => {
      // curl -w "DNS: %{time_namelookup}s, Total: %{time_total}s" URL
      const result = await executeCurlWithTiming('https://example.com', {
        format: 'DNS: %{time_namelookup}s, Total: %{time_total}s',
      })

      expect(result.timing).toBeDefined()
    })
  })

  describe('output format', () => {
    it('should format timing like real curl -w', async () => {
      const result = await executeCurlWithTiming('https://example.com')
      const output = formatCurlTiming(result)

      expect(output).toContain('time_total')
    })
  })
})

// Functions are now imported from ./network.ts

// ============================================================================
// Integration Tests with TieredExecutor
// ============================================================================

describe('Network commands via TieredExecutor', () => {
  describe('ping integration', () => {
    it('should classify ping as network command', async () => {
      const executor = new TieredExecutor({})
      const classification = executor.classifyCommand('ping -c 4 example.com')
      // ping is classified as tier 4 (sandbox) or tier 1 (native network) depending on implementation
      expect(classification.tier).toBeGreaterThanOrEqual(1)
      expect(classification.tier).toBeLessThanOrEqual(4)
    })
  })

  describe('dig integration', () => {
    it('should classify dig as network command', async () => {
      const executor = new TieredExecutor({})
      const classification = executor.classifyCommand('dig example.com')
      expect(classification.tier).toBeGreaterThanOrEqual(1)
    })

    it('should classify dig +short as network command', async () => {
      const executor = new TieredExecutor({})
      const classification = executor.classifyCommand('dig +short example.com')
      expect(classification.tier).toBeGreaterThanOrEqual(1)
    })
  })

  describe('nslookup integration', () => {
    it('should classify nslookup as network command', async () => {
      const executor = new TieredExecutor({})
      const classification = executor.classifyCommand('nslookup example.com')
      expect(classification.tier).toBeGreaterThanOrEqual(1)
    })
  })

  describe('host integration', () => {
    it('should classify host as network command', async () => {
      const executor = new TieredExecutor({})
      const classification = executor.classifyCommand('host example.com')
      expect(classification.tier).toBeGreaterThanOrEqual(1)
    })
  })

  describe('nc integration', () => {
    it('should classify nc as network command', async () => {
      const executor = new TieredExecutor({})
      const classification = executor.classifyCommand('nc -z example.com 80')
      // nc is listed in TIER_4_SANDBOX_COMMANDS
      expect(classification.tier).toBe(4)
    })
  })

  describe('curl/wget integration', () => {
    it('should classify wget as tier 1 http command', async () => {
      const executor = new TieredExecutor({})
      const classification = executor.classifyCommand('wget --spider https://example.com')
      expect(classification.tier).toBe(1)
      expect(classification.capability).toBe('http')
    })

    it('should classify curl as tier 1 http command', async () => {
      const executor = new TieredExecutor({})
      const classification = executor.classifyCommand('curl -I https://example.com')
      expect(classification.tier).toBe(1)
      expect(classification.capability).toBe('http')
    })

    it('should classify curl -w as tier 1 http command', async () => {
      const executor = new TieredExecutor({})
      const classification = executor.classifyCommand('curl -w "%{time_total}" https://example.com')
      expect(classification.tier).toBe(1)
      expect(classification.capability).toBe('http')
    })
  })
})

// ============================================================================
// Command Parsing Tests
// ============================================================================

describe('Network command parsing', () => {
  describe('ping command parsing', () => {
    it('should parse ping -c 4 example.com', () => {
      const parsed = parsePingCommand('ping -c 4 example.com')
      expect(parsed).toEqual({
        host: 'example.com',
        count: 4,
      })
    })

    it('should parse ping -c 1 -W 5 example.com', () => {
      const parsed = parsePingCommand('ping -c 1 -W 5 example.com')
      expect(parsed).toEqual({
        host: 'example.com',
        count: 1,
        timeout: 5000,
      })
    })

    it('should parse ping -q example.com', () => {
      const parsed = parsePingCommand('ping -q example.com')
      expect(parsed).toEqual({
        host: 'example.com',
        quiet: true,
      })
    })
  })

  describe('dig command parsing', () => {
    it('should parse dig example.com', () => {
      const parsed = parseDigCommand('dig example.com')
      expect(parsed).toEqual({
        domain: 'example.com',
        type: 'A',
      })
    })

    it('should parse dig example.com MX', () => {
      const parsed = parseDigCommand('dig example.com MX')
      expect(parsed).toEqual({
        domain: 'example.com',
        type: 'MX',
      })
    })

    it('should parse dig +short example.com', () => {
      const parsed = parseDigCommand('dig +short example.com')
      expect(parsed).toEqual({
        domain: 'example.com',
        type: 'A',
        short: true,
      })
    })

    it('should parse dig @8.8.8.8 example.com', () => {
      const parsed = parseDigCommand('dig @8.8.8.8 example.com')
      expect(parsed).toEqual({
        domain: 'example.com',
        type: 'A',
        resolver: '8.8.8.8',
      })
    })
  })

  describe('nc command parsing', () => {
    it('should parse nc -z host port', () => {
      const parsed = parseNcCommand('nc -z example.com 80')
      expect(parsed).toEqual({
        host: 'example.com',
        port: 80,
        zero: true,
      })
    })

    it('should parse nc -zv host port', () => {
      const parsed = parseNcCommand('nc -zv example.com 443')
      expect(parsed).toEqual({
        host: 'example.com',
        port: 443,
        zero: true,
        verbose: true,
      })
    })
  })
})

// Parsing functions are now imported from ./network.ts
