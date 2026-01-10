/**
 * Git Protocol Capabilities
 *
 * Parsing and handling of Git protocol capabilities.
 * See: https://git-scm.com/docs/protocol-capabilities
 *
 * STUB: This file exports types and functions that throw "not implemented"
 * for TDD RED phase.
 */

/** Parsed capabilities structure */
export interface Capabilities {
  /** Simple capabilities without values */
  list: string[]
  /** Key-value capabilities */
  values: Record<string, string>
  /** Multi-value capabilities (like symref) */
  multiValues?: Record<string, string[]>
}

/**
 * Parse space-separated capabilities string
 */
export function parseCapabilities(_capString: string): Capabilities {
  throw new Error('not implemented: parseCapabilities')
}

/**
 * Check if a capability is present
 */
export function hasCapability(_caps: Capabilities, _name: string): boolean {
  throw new Error('not implemented: hasCapability')
}

/**
 * Get the value of a key=value capability
 */
export function getCapabilityValue(
  _caps: Capabilities,
  _name: string
): string | undefined {
  throw new Error('not implemented: getCapabilityValue')
}
