/**
 * Mock FSX Service for Testing
 *
 * Provides an in-memory filesystem implementation that mimics the FSX service
 * binding interface (Fetcher) for testing purposes. This allows tests to verify
 * FSX integration without requiring the actual FSX service.
 *
 * The mock implements the RPC protocol expected by FsxServiceAdapter:
 * - POST to https://fsx.do/rpc with JSON body { method, params }
 * - Returns JSON responses with appropriate data or error codes
 */

/**
 * In-memory file entry
 */
interface MockFileEntry {
  type: 'file' | 'directory'
  content?: Uint8Array
  mode: number
  mtime: number
  ctime: number
  birthtime: number
}

/**
 * Creates an in-memory filesystem store
 */
function createMemoryFS(): Map<string, MockFileEntry> {
  const fs = new Map<string, MockFileEntry>()

  // Initialize root directory
  const now = Date.now()
  fs.set('/', {
    type: 'directory',
    mode: 0o755 | 0o40000, // directory mode
    mtime: now,
    ctime: now,
    birthtime: now,
  })

  // Add a test file for initial tests
  fs.set('/test.txt', {
    type: 'file',
    content: new TextEncoder().encode('test content'),
    mode: 0o644,
    mtime: now,
    ctime: now,
    birthtime: now,
  })

  return fs
}

/**
 * Normalize path to ensure consistent handling
 */
function normalizePath(path: string): string {
  // Remove trailing slashes except for root
  if (path !== '/' && path.endsWith('/')) {
    return path.slice(0, -1)
  }
  return path
}

/**
 * Get parent directory path
 */
function getParentPath(path: string): string {
  const normalized = normalizePath(path)
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === 0) return '/'
  return normalized.slice(0, lastSlash)
}

/**
 * Mock FSX RPC handler
 */
function createMockFSXHandler() {
  const fs = createMemoryFS()

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const body = (await request.json()) as {
      method: string
      params: Record<string, unknown>
    }

    const { method, params } = body
    const path = normalizePath((params.path as string) || '/')

    try {
      switch (method) {
        case 'stat': {
          const entry = fs.get(path)
          if (!entry) {
            return new Response(
              JSON.stringify({ code: 'ENOENT', message: `ENOENT: no such file or directory, stat '${path}'` }),
              { status: 404, headers: { 'Content-Type': 'application/json' } }
            )
          }
          return new Response(
            JSON.stringify({
              size: entry.content?.length ?? 0,
              mtime: entry.mtime,
              ctime: entry.ctime,
              birthtime: entry.birthtime,
              mode: entry.mode,
              type: entry.type,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }

        case 'readFile': {
          const entry = fs.get(path)
          if (!entry) {
            return new Response(
              JSON.stringify({ code: 'ENOENT', message: `ENOENT: no such file or directory, open '${path}'` }),
              { status: 404, headers: { 'Content-Type': 'application/json' } }
            )
          }
          if (entry.type === 'directory') {
            return new Response(
              JSON.stringify({ code: 'EISDIR', message: `EISDIR: illegal operation on a directory, read '${path}'` }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            )
          }
          const encoding = params.encoding as string | undefined
          if (encoding === 'utf-8' || encoding === 'utf8') {
            const text = new TextDecoder().decode(entry.content)
            return new Response(JSON.stringify({ data: text }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          // Return as array of bytes for binary
          return new Response(JSON.stringify({ data: Array.from(entry.content || new Uint8Array()) }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        case 'writeFile': {
          const parentPath = getParentPath(path)
          const parentEntry = fs.get(parentPath)
          if (!parentEntry) {
            return new Response(
              JSON.stringify({ code: 'ENOENT', message: `ENOENT: no such file or directory, open '${path}'` }),
              { status: 404, headers: { 'Content-Type': 'application/json' } }
            )
          }
          if (parentEntry.type !== 'directory') {
            return new Response(
              JSON.stringify({ code: 'ENOTDIR', message: `ENOTDIR: not a directory, open '${path}'` }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            )
          }

          const data = params.data as string | number[]
          let content: Uint8Array
          if (typeof data === 'string') {
            content = new TextEncoder().encode(data)
          } else if (Array.isArray(data)) {
            content = new Uint8Array(data)
          } else {
            content = new Uint8Array()
          }

          const now = Date.now()
          const existing = fs.get(path)
          fs.set(path, {
            type: 'file',
            content,
            mode: (params.mode as number) ?? existing?.mode ?? 0o644,
            mtime: now,
            ctime: now,
            birthtime: existing?.birthtime ?? now,
          })

          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        case 'unlink': {
          const entry = fs.get(path)
          if (!entry) {
            return new Response(
              JSON.stringify({ code: 'ENOENT', message: `ENOENT: no such file or directory, unlink '${path}'` }),
              { status: 404, headers: { 'Content-Type': 'application/json' } }
            )
          }
          if (entry.type === 'directory') {
            return new Response(
              JSON.stringify({ code: 'EISDIR', message: `EISDIR: illegal operation on a directory, unlink '${path}'` }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            )
          }
          fs.delete(path)
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        case 'mkdir': {
          const existing = fs.get(path)
          if (existing) {
            return new Response(
              JSON.stringify({ code: 'EEXIST', message: `EEXIST: file already exists, mkdir '${path}'` }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            )
          }

          const recursive = params.recursive as boolean
          const parentPath = getParentPath(path)

          // Check parent exists (or create recursively)
          if (!fs.has(parentPath)) {
            if (recursive) {
              // Create parent directories recursively
              const parts = path.split('/').filter(Boolean)
              let currentPath = ''
              for (const part of parts.slice(0, -1)) {
                currentPath += '/' + part
                if (!fs.has(currentPath)) {
                  const now = Date.now()
                  fs.set(currentPath, {
                    type: 'directory',
                    mode: 0o755 | 0o40000,
                    mtime: now,
                    ctime: now,
                    birthtime: now,
                  })
                }
              }
            } else {
              return new Response(
                JSON.stringify({ code: 'ENOENT', message: `ENOENT: no such file or directory, mkdir '${path}'` }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
              )
            }
          }

          const now = Date.now()
          fs.set(path, {
            type: 'directory',
            mode: 0o755 | 0o40000,
            mtime: now,
            ctime: now,
            birthtime: now,
          })

          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        case 'rmdir': {
          const entry = fs.get(path)
          if (!entry) {
            return new Response(
              JSON.stringify({ code: 'ENOENT', message: `ENOENT: no such file or directory, rmdir '${path}'` }),
              { status: 404, headers: { 'Content-Type': 'application/json' } }
            )
          }
          if (entry.type !== 'directory') {
            return new Response(
              JSON.stringify({ code: 'ENOTDIR', message: `ENOTDIR: not a directory, rmdir '${path}'` }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            )
          }

          const recursive = params.recursive as boolean

          // Check if directory has children
          const children = Array.from(fs.keys()).filter(
            (p) => p !== path && p.startsWith(path + '/')
          )

          if (children.length > 0 && !recursive) {
            return new Response(
              JSON.stringify({ code: 'ENOTEMPTY', message: `ENOTEMPTY: directory not empty, rmdir '${path}'` }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            )
          }

          // Delete all children if recursive
          if (recursive) {
            for (const childPath of children) {
              fs.delete(childPath)
            }
          }

          fs.delete(path)
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        case 'readdir': {
          const entry = fs.get(path)
          if (!entry) {
            return new Response(
              JSON.stringify({ code: 'ENOENT', message: `ENOENT: no such file or directory, scandir '${path}'` }),
              { status: 404, headers: { 'Content-Type': 'application/json' } }
            )
          }
          if (entry.type !== 'directory') {
            return new Response(
              JSON.stringify({ code: 'ENOTDIR', message: `ENOTDIR: not a directory, scandir '${path}'` }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            )
          }

          const withFileTypes = params.withFileTypes as boolean
          const prefix = path === '/' ? '/' : path + '/'

          // Get immediate children only
          const children = Array.from(fs.entries())
            .filter(([p]) => {
              if (!p.startsWith(prefix)) return false
              const relativePath = p.slice(prefix.length)
              return relativePath && !relativePath.includes('/')
            })
            .map(([p, e]) => {
              const name = p.slice(prefix.length)
              if (withFileTypes) {
                return { name, type: e.type }
              }
              return name
            })

          return new Response(JSON.stringify({ entries: children }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        default:
          return new Response(
            JSON.stringify({ error: `Unknown method: ${method}` }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          )
      }
    } catch (error) {
      return new Response(
        JSON.stringify({
          code: 'UNKNOWN',
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }
  }
}

/**
 * Create a mock Fetcher that implements the FSX service interface
 */
export function createMockFSX(): { fetch: typeof fetch } {
  const handler = createMockFSXHandler()

  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      return handler(request)
    },
  }
}

/**
 * Setup the mock FSX service in the global environment
 */
export function setupMockFSX(): void {
  const mockFSX = createMockFSX()

  // Inject into globalThis.env
  ;(globalThis as unknown as { env: { FSX: { fetch: typeof fetch } } }).env = {
    FSX: mockFSX,
  }
}

/**
 * Cleanup the mock FSX service from the global environment
 */
export function cleanupMockFSX(): void {
  delete (globalThis as unknown as { env?: { FSX?: { fetch: typeof fetch } } }).env
}
