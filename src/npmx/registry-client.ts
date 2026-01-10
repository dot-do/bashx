/**
 * NPM Registry Client
 *
 * Fetches package metadata, tarballs, and search results from npm registries.
 */

import { resolveVersion } from './version-resolver.js'
import { validateIntegrity } from './tarball.js'

// =============================================================================
// TYPES
// =============================================================================

export interface NpmAuthCredentials {
  token?: string
  username?: string
  password?: string
  tokenFromEnv?: string
  refreshToken?: string
}

export interface NpmRegistryClientOptions {
  registry?: string
  auth?: NpmAuthCredentials
  timeout?: number
  retries?: number
  retryDelay?: number
  userAgent?: string
  cache?: boolean
  followRedirects?: boolean
  maxRedirects?: number
  keepAlive?: boolean
  maxConcurrentRequests?: number
}

export interface VersionDistribution {
  tarball: string
  shasum: string
  integrity?: string
  fileCount?: number
  unpackedSize?: number
  signatures?: Array<{
    keyid: string
    sig: string
  }>
}

export interface PackageVersion {
  name: string
  version: string
  description?: string
  main?: string
  module?: string
  types?: string
  bin?: Record<string, string>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  optionalDependencies?: Record<string, string>
  bundledDependencies?: string[]
  engines?: Record<string, string>
  os?: string[]
  cpu?: string[]
  dist: VersionDistribution
  deprecated?: string
  license?: string
  repository?: {
    type: string
    url: string
    directory?: string
  }
  author?: string | { name: string; email?: string; url?: string }
  maintainers?: Array<{ name: string; email?: string }>
  keywords?: string[]
  bugs?: { url?: string; email?: string }
  homepage?: string
  funding?: string | { type: string; url: string } | Array<{ type: string; url: string }>
  publishConfig?: Record<string, unknown>
  _id?: string
  _npmVersion?: string
  _nodeVersion?: string
}

export interface PackageMetadata {
  _id: string
  _rev?: string
  name: string
  description?: string
  'dist-tags': Record<string, string>
  versions: Record<string, PackageVersion>
  time?: Record<string, string>
  maintainers?: Array<{ name: string; email?: string }>
  author?: string | { name: string; email?: string; url?: string }
  repository?: {
    type: string
    url: string
    directory?: string
  }
  readme?: string
  readmeFilename?: string
  homepage?: string
  bugs?: { url?: string; email?: string }
  license?: string
  keywords?: string[]
  users?: Record<string, boolean>
}

export interface SearchResult {
  objects: Array<{
    package: {
      name: string
      version: string
      description?: string
      keywords?: string[]
      date?: string
      links?: {
        npm?: string
        homepage?: string
        repository?: string
        bugs?: string
      }
      author?: { name: string; email?: string }
      publisher?: { username: string; email?: string }
      maintainers?: Array<{ username: string; email?: string }>
    }
    score: {
      final: number
      detail: {
        quality: number
        popularity: number
        maintenance: number
      }
    }
    searchScore: number
  }>
  total: number
  time: string
}

export interface SearchOptions {
  size?: number
  from?: number
  quality?: number
  popularity?: number
  maintenance?: number
}

export interface DownloadProgress {
  bytesDownloaded: number
  totalBytes: number
  percentage: number
}

export interface DownloadOptions {
  verifyIntegrity?: boolean
  expectedIntegrity?: string
  onProgress?: (progress: DownloadProgress) => void
}

export interface GetMetadataOptions {
  abbreviated?: boolean
}

export interface RegistryEndpoint {
  url: string
  method: 'GET' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_TIMEOUT = 60000
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY = 1000
const DEFAULT_USER_AGENT = 'npmx/1.0.0 (https://bashx.do)'

// Regex for valid npm package names
const PACKAGE_NAME_REGEX = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function isValidPackageName(name: string): boolean {
  // Check for path traversal
  if (name.includes('..')) return false
  if (name.startsWith('/') || name.startsWith('.')) return false

  // Allow scoped packages
  if (name.startsWith('@')) {
    return PACKAGE_NAME_REGEX.test(name.toLowerCase())
  }

  return PACKAGE_NAME_REGEX.test(name.toLowerCase())
}

function encodePackageName(name: string): string {
  // Scoped packages need the @ and / encoded
  if (name.startsWith('@')) {
    return name.replace('/', '%2F')
  }
  return name
}

// =============================================================================
// MAIN CLASS
// =============================================================================

export class NpmRegistryClient {
  readonly registryUrl: string
  readonly timeout: number
  readonly retries: number
  readonly retryDelay: number
  readonly userAgent: string
  readonly keepAlive: boolean
  readonly maxRedirects: number
  readonly maxConcurrentRequests: number

  private _isAuthenticated: boolean = false
  private _cacheHits: number = 0
  private _auth?: NpmAuthCredentials
  private _cache: Map<string, { data: PackageMetadata; timestamp: number }> = new Map()
  private _cacheEnabled: boolean = false

  constructor(options?: NpmRegistryClientOptions) {
    // Normalize registry URL (remove trailing slash)
    let registry = options?.registry ?? DEFAULT_REGISTRY
    if (registry.endsWith('/')) {
      registry = registry.slice(0, -1)
    }
    this.registryUrl = registry

    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT
    this.retries = options?.retries ?? DEFAULT_RETRIES
    this.retryDelay = options?.retryDelay ?? DEFAULT_RETRY_DELAY
    this.userAgent = options?.userAgent ?? DEFAULT_USER_AGENT
    this.keepAlive = options?.keepAlive ?? false
    this.maxRedirects = options?.maxRedirects ?? 5
    this.maxConcurrentRequests = options?.maxConcurrentRequests ?? 10
    this._cacheEnabled = options?.cache ?? false

    // Handle authentication
    if (options?.auth) {
      this._auth = options.auth

      // Check for token from environment variable
      if (options.auth.tokenFromEnv) {
        const envToken = process.env[options.auth.tokenFromEnv]
        if (envToken) {
          this._auth = { ...this._auth, token: envToken }
          this._isAuthenticated = true
        }
      } else if (options.auth.token || (options.auth.username && options.auth.password)) {
        this._isAuthenticated = true
      }
    }
  }

  get isAuthenticated(): boolean {
    return this._isAuthenticated
  }

  get cacheHits(): number {
    return this._cacheHits
  }

  getAuthHeader(): string {
    if (!this._auth) return ''

    if (this._auth.token) {
      return `Bearer ${this._auth.token}`
    }

    if (this._auth.username && this._auth.password) {
      const credentials = `${this._auth.username}:${this._auth.password}`
      return `Basic ${btoa(credentials)}`
    }

    return ''
  }

  getRequestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/json',
    }

    const authHeader = this.getAuthHeader()
    if (authHeader) {
      headers['Authorization'] = authHeader
    }

    return headers
  }

  async refreshAuth(): Promise<void> {
    // In a real implementation, this would refresh the token using the refresh token
    // For now, just mark as authenticated if we have a refresh token
    if (this._auth?.refreshToken) {
      this._isAuthenticated = true
    }
  }

  handleRateLimit(): void {
    // Placeholder for rate limit handling logic
    // Would implement exponential backoff, etc.
  }

  // URL construction methods
  getMetadataUrl(packageName: string): string {
    const encoded = encodePackageName(packageName)
    return `${this.registryUrl}/${encoded}`
  }

  getVersionUrl(packageName: string, version: string): string {
    const encoded = encodePackageName(packageName)
    return `${this.registryUrl}/${encoded}/${version}`
  }

  getSearchUrl(query: string): string {
    return `${this.registryUrl}/-/v1/search?text=${encodeURIComponent(query)}`
  }

  getTarballUrl(dist: VersionDistribution): string {
    return dist.tarball
  }

  getPublishUrl(packageName: string): string {
    const encoded = encodePackageName(packageName)
    return `${this.registryUrl}/${encoded}`
  }

  // API methods
  async getPackageMetadata(
    packageName: string,
    options?: GetMetadataOptions
  ): Promise<PackageMetadata> {
    // Validate package name
    if (!isValidPackageName(packageName)) {
      throw new Error(`Invalid package name: ${packageName}`)
    }

    // Check cache
    if (this._cacheEnabled) {
      const cached = this._cache.get(packageName)
      if (cached && Date.now() - cached.timestamp < 300000) {
        // 5 min cache
        this._cacheHits++
        return cached.data
      }
    }

    const url = this.getMetadataUrl(packageName)
    const headers = this.getRequestHeaders()

    // Use abbreviated metadata header if requested
    if (options?.abbreviated) {
      headers['Accept'] =
        'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'
    }

    const response = await this.fetchWithRetry(url, { headers })

    if (response.status === 404) {
      throw new Error(`Package not found: ${packageName}`)
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch package metadata: ${response.status}`)
    }

    const data = (await response.json()) as PackageMetadata

    // Normalize version data - ensure dependencies is always defined
    for (const version of Object.keys(data.versions)) {
      if (!data.versions[version].dependencies) {
        data.versions[version].dependencies = {}
      }
    }

    // Cache the result
    if (this._cacheEnabled) {
      this._cache.set(packageName, { data, timestamp: Date.now() })
    }

    return data
  }

  async getPackageVersion(packageName: string, version: string): Promise<PackageVersion> {
    const metadata = await this.getPackageMetadata(packageName)

    let versionData: PackageVersion | undefined

    // Check if version is a dist-tag
    if (metadata['dist-tags'][version]) {
      const resolvedVersion = metadata['dist-tags'][version]
      versionData = metadata.versions[resolvedVersion]
      if (!versionData) {
        throw new Error(`Version not found: ${version}`)
      }
    }

    // Check for exact version match
    if (!versionData && metadata.versions[version]) {
      versionData = metadata.versions[version]
    }

    // Try to resolve as semver range
    if (!versionData) {
      const availableVersions = Object.keys(metadata.versions)
      const resolved = resolveVersion(availableVersions, version)

      if (!resolved) {
        throw new Error(`Version not found: ${version}`)
      }

      versionData = metadata.versions[resolved]
    }

    // Ensure dependencies is always defined (normalize response)
    if (!versionData.dependencies) {
      versionData = { ...versionData, dependencies: {} }
    }

    return versionData
  }

  async downloadTarball(
    packageName: string,
    version: string,
    options?: DownloadOptions
  ): Promise<ArrayBuffer> {
    const versionData = await this.getPackageVersion(packageName, version)
    const tarballUrl = versionData.dist.tarball
    const headers = this.getRequestHeaders()

    const response = await this.fetchWithRetry(tarballUrl, { headers })

    if (!response.ok) {
      throw new Error(`Failed to download tarball: ${response.status}`)
    }

    // Handle progress reporting
    if (options?.onProgress && response.body) {
      const contentLength = response.headers.get('content-length')
      const totalBytes = contentLength ? parseInt(contentLength, 10) : 0

      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytesDownloaded = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        chunks.push(value)
        bytesDownloaded += value.length

        options.onProgress({
          bytesDownloaded,
          totalBytes,
          percentage: totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 0,
        })
      }

      // Final progress update
      options.onProgress({
        bytesDownloaded,
        totalBytes: bytesDownloaded,
        percentage: 100,
      })

      // Combine chunks
      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
      const result = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }

      const buffer = result.buffer

      // Verify integrity if requested
      if (options?.expectedIntegrity) {
        const isValid = await validateIntegrity(result, options.expectedIntegrity)
        if (!isValid) {
          throw new Error('Integrity check failed')
        }
      } else if (options?.verifyIntegrity && versionData.dist.integrity) {
        const isValid = await validateIntegrity(result, versionData.dist.integrity)
        if (!isValid) {
          throw new Error('Integrity check failed')
        }
      }

      return buffer
    }

    // Simple download without progress
    const buffer = await response.arrayBuffer()

    // Verify integrity if requested
    if (options?.expectedIntegrity) {
      const isValid = await validateIntegrity(new Uint8Array(buffer), options.expectedIntegrity)
      if (!isValid) {
        throw new Error('Integrity check failed')
      }
    } else if (options?.verifyIntegrity && versionData.dist.integrity) {
      const isValid = await validateIntegrity(
        new Uint8Array(buffer),
        versionData.dist.integrity
      )
      if (!isValid) {
        throw new Error('Integrity check failed')
      }
    }

    return buffer
  }

  async downloadTarballStream(
    packageName: string,
    version: string
  ): Promise<ReadableStream<Uint8Array>> {
    const versionData = await this.getPackageVersion(packageName, version)
    const tarballUrl = versionData.dist.tarball
    const headers = this.getRequestHeaders()

    const response = await this.fetchWithRetry(tarballUrl, { headers })

    if (!response.ok) {
      throw new Error(`Failed to download tarball: ${response.status}`)
    }

    if (!response.body) {
      throw new Error('Response body is not a stream')
    }

    return response.body
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult> {
    let url = this.getSearchUrl(query)

    // Add pagination and filter options
    const params = new URLSearchParams()
    params.set('text', query)

    if (options?.size) {
      params.set('size', options.size.toString())
    }
    if (options?.from !== undefined) {
      params.set('from', options.from.toString())
    }
    if (options?.quality !== undefined) {
      params.set('quality', options.quality.toString())
    }
    if (options?.popularity !== undefined) {
      params.set('popularity', options.popularity.toString())
    }
    if (options?.maintenance !== undefined) {
      params.set('maintenance', options.maintenance.toString())
    }

    url = `${this.registryUrl}/-/v1/search?${params.toString()}`

    const headers = this.getRequestHeaders()
    const response = await this.fetchWithRetry(url, { headers })

    if (!response.ok) {
      throw new Error(`Search failed: ${response.status}`)
    }

    const data = (await response.json()) as SearchResult

    // Filter by quality/maintenance scores if specified (registry may not support)
    if (options?.quality !== undefined || options?.maintenance !== undefined) {
      data.objects = data.objects.filter((obj) => {
        if (options.quality !== undefined && obj.score.detail.quality < options.quality) {
          return false
        }
        if (
          options.maintenance !== undefined &&
          obj.score.detail.maintenance < options.maintenance
        ) {
          return false
        }
        return true
      })
    }

    return data
  }

  preparePackage(
    _packageJson: Record<string, unknown>,
    _files: unknown[]
  ): Record<string, unknown> {
    // Placeholder for package preparation logic
    // Would prepare the package manifest for publishing
    return {}
  }

  // Private helper methods
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    attempt: number = 0
  ): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      // Retry on 5xx errors
      if (response.status >= 500 && attempt < this.retries) {
        await this.delay(this.retryDelay * Math.pow(2, attempt))
        return this.fetchWithRetry(url, options, attempt + 1)
      }

      return response
    } catch (error) {
      clearTimeout(timeoutId)

      // Check if it's a timeout/abort error
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Request timeout after ${this.timeout}ms`)
        }
      }

      // Retry on network errors
      if (attempt < this.retries) {
        await this.delay(this.retryDelay * Math.pow(2, attempt))
        return this.fetchWithRetry(url, options, attempt + 1)
      }

      throw new Error(`Network error: ${error instanceof Error ? error.message : 'fetch failed'}`)
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
