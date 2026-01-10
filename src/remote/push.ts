/**
 * Git Push Operation
 *
 * Push refs and objects to a remote repository.
 *
 * @module bashx/remote/push
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

export interface PushOptions {
  remote: string
  refspecs?: string[]
  force?: boolean
  setUpstream?: boolean
  tags?: boolean
  http: MockHttpClient
  localRepo: MockRepo
}

export interface PushResult {
  exitCode: number
  stdout: string
  stderr: string
  pushedRefs?: string[]
  createdRefs?: string[]
  deletedRefs?: string[]
  forcePushed?: string[]
  objectsSent: number
}

/**
 * Check if we can fast-forward from remoteSha to localSha
 * In a real implementation, we'd walk the commit graph
 * For mock, we check if we know about the remote commit through refs or objects
 */
function canFastForward(
  localSha: string,
  remoteSha: string,
  objects: Map<string, { type: string; data: Uint8Array }>,
  refs: Map<string, string>
): boolean {
  // Check if we have the remote SHA in our objects (we fetched it)
  if (objects.has(remoteSha)) {
    return true
  }

  // Check if any of our refs point to the remote SHA (we know about it)
  for (const sha of refs.values()) {
    if (sha === remoteSha) {
      return true
    }
  }

  return false
}

/**
 * Push to a remote repository
 *
 * @param options - Push configuration options
 * @returns Push result with exit code and output
 */
export async function push(options: PushOptions): Promise<PushResult> {
  const { remote, refspecs, force, setUpstream, tags, http, localRepo } = options

  // Get remote configuration
  const remoteConfig = localRepo.remotes.get(remote)
  if (!remoteConfig) {
    return {
      exitCode: 128,
      stdout: '',
      stderr: `fatal: Remote '${remote}' not found`,
      objectsSent: 0,
    }
  }

  const remoteUrl = remoteConfig.url

  // Record the info/refs request
  http.requests.push({
    url: `${remoteUrl}/info/refs?service=git-receive-pack`,
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
      objectsSent: 0,
    }
  }

  const remoteRefs = remoteInfo.refs

  // Determine what to push
  const refsToPush: Array<{
    src: string | null  // null for delete
    dst: string
    localSha: string | null
    remoteSha: string | null
  }> = []

  if (refspecs && refspecs.length > 0) {
    // Parse explicit refspecs
    for (const refspec of refspecs) {
      if (refspec.startsWith(':')) {
        // Delete refspec
        const dst = refspec.slice(1)
        refsToPush.push({
          src: null,
          dst,
          localSha: null,
          remoteSha: remoteRefs.get(dst) || null,
        })
      } else {
        const [src, dst] = refspec.split(':')
        const localSha = localRepo.refs.get(src)

        if (!localSha) {
          return {
            exitCode: 128,
            stdout: '',
            stderr: `error: src refspec ${src} does not match any`,
            objectsSent: 0,
          }
        }

        refsToPush.push({
          src,
          dst: dst || src,
          localSha,
          remoteSha: remoteRefs.get(dst || src) || null,
        })
      }
    }
  } else if (!tags) {
    // Push current branch (only if not doing tags-only push)
    if (!localRepo.head.symbolic) {
      return {
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: You are not currently on a branch.',
        objectsSent: 0,
      }
    }

    const currentBranch = localRepo.head.target
    const localSha = localRepo.refs.get(currentBranch)

    if (!localSha) {
      return {
        exitCode: 128,
        stdout: '',
        stderr: `error: src refspec ${currentBranch} does not match any`,
        objectsSent: 0,
      }
    }

    refsToPush.push({
      src: currentBranch,
      dst: currentBranch,
      localSha,
      remoteSha: remoteRefs.get(currentBranch) || null,
    })
  }

  // Add tags if requested
  if (tags) {
    for (const [ref, sha] of localRepo.refs.entries()) {
      if (ref.startsWith('refs/tags/')) {
        const remoteSha = remoteRefs.get(ref)
        if (remoteSha !== sha) {
          refsToPush.push({
            src: ref,
            dst: ref,
            localSha: sha,
            remoteSha: remoteSha || null,
          })
        }
      }
    }
  }

  // Check for protected branches first (server-side rejection)
  const protectedBranches = http.protectedBranches.get(remoteUrl) || new Set()
  const receivePackResult = http.receivePack.get(remoteUrl)

  // Check if any ref we're pushing is protected and server rejects
  for (const ref of refsToPush) {
    if (ref.localSha !== null && ref.dst) {
      if (protectedBranches.has(ref.dst) || (receivePackResult && !receivePackResult.ok)) {
        if (receivePackResult && !receivePackResult.ok) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: `error: failed to push to '${remoteUrl}'\n` +
              `remote: error: GH006: Protected branch update failed for ${ref.dst}.\n` +
              `remote: error: ${receivePackResult.error || 'protected branch hook declined'}\n` +
              `To ${remoteUrl}\n` +
              ` ! [remote rejected] ${ref.dst} -> ${ref.dst} (protected)`,
            objectsSent: 0,
          }
        }
      }
    }
  }

  // Check for non-fast-forward pushes
  const pushedRefs: string[] = []
  const createdRefs: string[] = []
  const deletedRefs: string[] = []
  const forcePushed: string[] = []
  const rejectedRefs: string[] = []

  for (const ref of refsToPush) {
    if (ref.localSha === null) {
      // Delete operation
      deletedRefs.push(ref.dst)
      continue
    }

    if (ref.remoteSha === null) {
      // New ref
      createdRefs.push(ref.dst)
      pushedRefs.push(ref.dst)
      continue
    }

    // Check if fast-forward is possible
    const isFastForward = canFastForward(ref.localSha, ref.remoteSha, localRepo.objects, localRepo.refs)

    if (!isFastForward && !force) {
      rejectedRefs.push(ref.dst)
    } else if (!isFastForward && force) {
      forcePushed.push(ref.dst)
      pushedRefs.push(ref.dst)
    } else {
      pushedRefs.push(ref.dst)
    }
  }

  // Check for rejections
  if (rejectedRefs.length > 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `error: failed to push some refs to '${remoteUrl}'\n` +
        `hint: Updates were rejected because the tip of your current branch is behind\n` +
        `hint: its remote counterpart. Merge the remote changes before pushing again.\n` +
        `To ${remoteUrl}\n` +
        ` ! [rejected]        ${rejectedRefs.join(', ')} -> ${rejectedRefs.join(', ')} (non-fast-forward)`,
      objectsSent: 0,
    }
  }

  // Record the receive-pack request
  http.requests.push({
    url: `${remoteUrl}/git-receive-pack`,
    method: 'POST',
    headers: {
      'User-Agent': 'git/bashx',
      'Content-Type': 'application/x-git-receive-pack-request',
    },
  })

  // Count objects to send (only new objects not on remote)
  let objectsSent = 0
  for (const ref of refsToPush) {
    if (ref.localSha && !ref.remoteSha) {
      // New ref - count as 1 object (simplified)
      objectsSent++
    } else if (ref.localSha && ref.remoteSha && ref.localSha !== ref.remoteSha) {
      // Updated ref - count as 1 object (simplified)
      objectsSent++
    }
  }

  // Update remote-tracking refs
  for (const ref of refsToPush) {
    if (ref.localSha && ref.dst.startsWith('refs/heads/')) {
      const branchName = ref.dst.replace('refs/heads/', '')
      localRepo.refs.set(`refs/remotes/${remote}/${branchName}`, ref.localSha)
    }
  }

  // Set upstream if requested
  if (setUpstream) {
    for (const ref of refsToPush) {
      if (ref.src && ref.localSha) {
        const branchName = ref.src.replace('refs/heads/', '')
        localRepo.config.set(`branch.${branchName}.remote`, remote)
        localRepo.config.set(`branch.${branchName}.merge`, ref.dst)
      }
    }
  }

  // Build output
  let stdout = `To ${remoteUrl}\n`
  for (const ref of createdRefs) {
    stdout += ` * [new branch]      ${ref}\n`
  }
  for (const ref of pushedRefs) {
    if (!createdRefs.includes(ref)) {
      stdout += `   ${ref}\n`
    }
  }
  for (const ref of deletedRefs) {
    stdout += ` - [deleted]         ${ref}\n`
  }

  return {
    exitCode: 0,
    stdout,
    stderr: '',
    pushedRefs: pushedRefs.length > 0 ? pushedRefs : undefined,
    createdRefs: createdRefs.length > 0 ? createdRefs : undefined,
    deletedRefs: deletedRefs.length > 0 ? deletedRefs : undefined,
    forcePushed: forcePushed.length > 0 ? forcePushed : undefined,
    objectsSent,
  }
}
