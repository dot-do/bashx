/**
 * Git Fetch Operation
 *
 * Fetch refs and objects from a remote repository.
 *
 * @module bashx/remote/fetch
 */

/**
 * Mock HTTP client interface for simulating Git smart protocol
 */
interface MockHttpClient {
  infoRefs: Map<string, { refs: Map<string, string>; capabilities: string[] }>
  packData: Map<string, Uint8Array>
  receivePack: Map<string, { ok: boolean; error?: string }>
  requests: Array<{ url: string; method: string; headers: Record<string, string>; body?: Uint8Array }>
  authRequired: Set<string>
  protectedBranches: Map<string, Set<string>>
}

/**
 * Mock Git repository state
 */
interface MockRepo {
  objects: Map<string, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Uint8Array }>
  refs: Map<string, string>
  head: { symbolic: boolean; target: string }
  remotes: Map<string, { url: string; fetch: string }>
  config: Map<string, string>
  workingTree: Map<string, Uint8Array>
  index: Map<string, { sha: string; mode: number }>
}

export interface FetchOptions {
  remote: string
  refspecs?: string[]
  prune?: boolean
  tags?: boolean
  http: MockHttpClient
  localRepo: MockRepo
}

export interface FetchResult {
  exitCode: number
  stdout: string
  stderr: string
  updatedRefs?: string[]
  prunedRefs?: string[]
  objectsFetched: number
}

/**
 * Parse pack data and extract objects
 */
function parsePackData(
  packData: Uint8Array,
  knownShas: Set<string>
): Array<{ sha: string; type: string; data: Uint8Array }> {
  const objects: Array<{ sha: string; type: string; data: Uint8Array }> = []

  if (packData.length < 12) {
    return objects
  }

  const count = (packData[8] << 24) | (packData[9] << 16) | (packData[10] << 8) | packData[11]

  if (count === 0) {
    return objects
  }

  const shaLookup = new Map<string, string>()
  for (const sha of knownShas) {
    shaLookup.set(sha.slice(0, 20), sha)
  }

  const validTypes = new Set(['comm', 'tree', 'blob', 'tag '])
  const isShaLike = (s: string) => s.length === 20 && /^[0-9a-z]+$/i.test(s)

  const rawObjects: Array<{ prefix: string; type: string; data: Uint8Array }> = []
  let scanOffset = 12

  for (let i = 0; i < count && scanOffset + 24 <= packData.length; i++) {
    const shaPrefix = new TextDecoder().decode(packData.slice(scanOffset, scanOffset + 20))
    const typeStr = new TextDecoder().decode(packData.slice(scanOffset + 20, scanOffset + 24))
    const type = typeStr.trim()

    scanOffset += 24

    let dataEnd = scanOffset
    while (dataEnd < packData.length - 20) {
      const nextPrefix = new TextDecoder().decode(packData.slice(dataEnd, dataEnd + 20))
      const nextType = new TextDecoder().decode(packData.slice(dataEnd + 20, dataEnd + 24))
      if (isShaLike(nextPrefix) && validTypes.has(nextType)) {
        break
      }
      dataEnd++
    }

    const data = packData.slice(scanOffset, dataEnd)
    rawObjects.push({ prefix: shaPrefix, type, data })
    scanOffset = dataEnd
  }

  for (const raw of rawObjects) {
    const fullSha = shaLookup.get(raw.prefix) || raw.prefix
    objects.push({ sha: fullSha, type: raw.type, data: raw.data })
  }

  return objects
}

/**
 * Fetch from a remote repository
 *
 * @param options - Fetch configuration options
 * @returns Fetch result with exit code and output
 */
export async function fetch(options: FetchOptions): Promise<FetchResult> {
  const { remote, refspecs, prune, tags, http, localRepo } = options

  // Get remote configuration
  const remoteConfig = localRepo.remotes.get(remote)
  if (!remoteConfig) {
    return {
      exitCode: 128,
      stdout: '',
      stderr: `fatal: Remote '${remote}' not found`,
      objectsFetched: 0,
    }
  }

  const remoteUrl = remoteConfig.url

  // Record the info/refs request
  http.requests.push({
    url: `${remoteUrl}/info/refs?service=git-upload-pack`,
    method: 'GET',
    headers: { 'User-Agent': 'git/bashx' },
  })

  // Get remote refs
  const remoteInfo = http.infoRefs.get(remoteUrl)
  if (!remoteInfo) {
    return {
      exitCode: 128,
      stdout: '',
      stderr: `fatal: Could not connect to ${remoteUrl}`,
      objectsFetched: 0,
    }
  }

  const remoteRefs = remoteInfo.refs

  // Determine which refs to fetch based on refspecs or default fetch spec
  const fetchSpec = remoteConfig.fetch // e.g., '+refs/heads/*:refs/remotes/origin/*'
  const updatedRefs: string[] = []
  const refsToFetch = new Map<string, string>()

  if (refspecs && refspecs.length > 0) {
    // Parse explicit refspecs
    for (const refspec of refspecs) {
      const [src, dst] = refspec.split(':')
      if (src && dst) {
        const remoteSha = remoteRefs.get(src)
        if (remoteSha) {
          refsToFetch.set(dst, remoteSha)
        }
      }
    }
  } else {
    // Use default fetch spec to map remote refs to local tracking refs
    // fetchSpec is like '+refs/heads/*:refs/remotes/origin/*'
    const [srcPattern, dstPattern] = fetchSpec.replace(/^\+/, '').split(':')

    for (const [ref, sha] of remoteRefs.entries()) {
      if (ref === 'HEAD') continue

      if (ref.startsWith('refs/heads/')) {
        // Map to tracking ref
        const branchName = ref.replace('refs/heads/', '')
        const trackingRef = `refs/remotes/${remote}/${branchName}`
        refsToFetch.set(trackingRef, sha)
      }
    }
  }

  // Also fetch tags if requested
  if (tags) {
    for (const [ref, sha] of remoteRefs.entries()) {
      if (ref.startsWith('refs/tags/')) {
        refsToFetch.set(ref, sha)
      }
    }
  }

  // Check if we need to fetch any new objects
  const objectsNeeded = new Set<string>()
  for (const [ref, sha] of refsToFetch.entries()) {
    const currentSha = localRepo.refs.get(ref)
    if (currentSha !== sha && !localRepo.objects.has(sha)) {
      objectsNeeded.add(sha)
    }
  }

  // Record the upload-pack request if we need objects
  if (objectsNeeded.size > 0) {
    http.requests.push({
      url: `${remoteUrl}/git-upload-pack`,
      method: 'POST',
      headers: {
        'User-Agent': 'git/bashx',
        'Content-Type': 'application/x-git-upload-pack-request',
      },
    })
  }

  // Get and parse pack data
  let objectsFetched = 0
  const packData = http.packData.get(remoteUrl)
  if (packData && packData.length > 12) {
    const knownShas = new Set<string>(refsToFetch.values())
    const objects = parsePackData(packData, knownShas)

    for (const obj of objects) {
      if (!localRepo.objects.has(obj.sha)) {
        localRepo.objects.set(obj.sha, {
          type: obj.type as 'blob' | 'tree' | 'commit' | 'tag',
          data: obj.data,
        })
        objectsFetched++
      }
    }
  }

  // Update refs
  for (const [ref, sha] of refsToFetch.entries()) {
    const currentSha = localRepo.refs.get(ref)
    if (currentSha !== sha) {
      localRepo.refs.set(ref, sha)
      updatedRefs.push(ref)
    }
  }

  // Handle pruning
  const prunedRefs: string[] = []
  if (prune) {
    // Find tracking refs that no longer exist on remote
    const remoteTrackingPrefix = `refs/remotes/${remote}/`
    for (const [ref] of localRepo.refs.entries()) {
      if (ref.startsWith(remoteTrackingPrefix)) {
        const branchName = ref.replace(remoteTrackingPrefix, '')
        const remoteBranchRef = `refs/heads/${branchName}`
        if (!remoteRefs.has(remoteBranchRef)) {
          localRepo.refs.delete(ref)
          prunedRefs.push(ref)
        }
      }
    }
  }

  // Build output
  let stdout = ''
  if (objectsFetched === 0 && updatedRefs.length === 0) {
    stdout = 'Already up to date.'
  } else {
    stdout = `From ${remoteUrl}\n`
    for (const ref of updatedRefs) {
      const branchName = ref.split('/').pop()
      stdout += `   ${ref.includes('tags') ? '[new tag]' : ''} ${branchName}\n`
    }
  }

  return {
    exitCode: 0,
    stdout,
    stderr: '',
    updatedRefs: updatedRefs.length > 0 ? updatedRefs : undefined,
    prunedRefs: prunedRefs.length > 0 ? prunedRefs : undefined,
    objectsFetched,
  }
}
