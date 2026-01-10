/**
 * NPM Version Resolver (Stub)
 *
 * This file is a stub for TDD RED phase.
 * Implementation will be added in GREEN phase.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface PackageSpec {
  name: string
  scope?: string
  version?: string
  range?: string
  normalizedRange?: string
  tag?: string
  protocol?: string
  alias?: string
}

export interface SemverRange {
  raw: string
  normalized: string
  comparators: SemverComparator[][]
}

export interface SemverComparator {
  operator: '' | '=' | '<' | '>' | '<=' | '>=' | '~' | '^'
  major: number
  minor: number
  patch: number
  prerelease?: (string | number)[]
  build?: string[]
}

export interface ResolveOptions {
  includePrerelease?: boolean
}

export interface LatestVersionOptions {
  includePrerelease?: boolean
}

// =============================================================================
// FUNCTIONS
// =============================================================================

export function parsePackageSpec(spec: string): PackageSpec {
  throw new Error('Not implemented')
}

export function resolveVersion(
  versions: string[],
  range: string,
  options?: ResolveOptions
): string | null {
  throw new Error('Not implemented')
}

export function matchesRange(version: string, range: string): boolean {
  throw new Error('Not implemented')
}

export function sortVersions(
  versions: string[],
  order?: 'asc' | 'desc'
): string[] {
  throw new Error('Not implemented')
}

export function getLatestVersion(
  versions: string[],
  options?: LatestVersionOptions
): string {
  throw new Error('Not implemented')
}

export function parseRange(range: string): SemverRange {
  throw new Error('Not implemented')
}

export function compareSemver(a: string, b: string): number {
  throw new Error('Not implemented')
}

export function isPrerelease(version: string): boolean {
  throw new Error('Not implemented')
}

export function isValidVersion(version: string): boolean {
  throw new Error('Not implemented')
}

export function isValidRange(range: string): boolean {
  throw new Error('Not implemented')
}
