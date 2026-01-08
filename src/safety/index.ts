/**
 * bashx Safety Module
 *
 * Provides command classification and safety analysis before execution.
 */

import type {
  CommandClassification,
  CommandType,
  CommandScope,
  ImpactLevel,
  SafetyRequirement,
  SafetyReport,
  SafetyContext,
  Risk,
  AlternativeCommand,
} from '../types.js'

/**
 * Patterns for detecting dangerous commands
 */
export const DANGEROUS_PATTERNS = {
  // Recursive delete patterns
  recursiveDelete: [
    /rm\s+(-[a-z]*r[a-z]*\s+|--recursive\s+)/i,
    /rm\s+-[a-z]*f[a-z]*\s+/i,
  ],

  // Root/system paths
  systemPaths: [
    /^\s*\/\s*$/,
    /\/etc\//,
    /\/usr\//,
    /\/bin\//,
    /\/sbin\//,
    /\/boot\//,
    /\/var\//,
    /\/root\//,
    /\/System\//,
    /\/Library\//,
  ],

  // Permission changes
  permissionChanges: [
    /chmod\s+(-[a-z]*R[a-z]*\s+|--recursive\s+)/i,
    /chmod\s+777/,
    /chown\s+(-[a-z]*R[a-z]*\s+|--recursive\s+)/i,
  ],

  // Disk/partition operations
  diskOperations: [
    /mkfs\./,
    /fdisk/,
    /parted/,
    /dd\s+/,
  ],

  // Network operations
  networkOperations: [
    /curl\s+/,
    /wget\s+/,
    /nc\s+/,
    /netcat\s+/,
    /ssh\s+/,
    /scp\s+/,
  ],

  // Process killing
  processKilling: [
    /kill\s+-9/,
    /killall\s+/,
    /pkill\s+/,
  ],

  // Sudo/elevation
  elevation: [
    /sudo\s+/,
    /su\s+/,
    /doas\s+/,
  ],

  // Environment manipulation
  environmentManip: [
    /export\s+PATH=/,
    /source\s+/,
    /\.\s+\//,
    /eval\s+/,
  ],
} as const

/**
 * Read-only commands that are generally safe
 */
export const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'awk', 'sed',
  'find', 'which', 'whereis', 'type', 'file', 'stat', 'wc', 'sort',
  'uniq', 'diff', 'tree', 'pwd', 'echo', 'printf', 'date', 'cal',
  'whoami', 'id', 'groups', 'hostname', 'uname', 'uptime', 'free',
  'df', 'du', 'ps', 'top', 'htop', 'env', 'printenv', 'man', 'help',
])

/**
 * Commands that modify files/system
 */
export const WRITE_COMMANDS = new Set([
  'touch', 'mkdir', 'cp', 'mv', 'ln', 'install',
])

/**
 * Commands that delete files
 */
export const DELETE_COMMANDS = new Set([
  'rm', 'rmdir', 'unlink', 'shred',
])

/**
 * Classify a command's type, scope, and impact
 */
export function classifyCommand(cmd: string): CommandClassification {
  // This is a stub - actual implementation uses AI classification
  throw new Error('Not implemented: classifyCommand requires AI service')
}

/**
 * Analyze a command for safety
 */
export function analyzeCommandSafety(
  cmd: string,
  context?: SafetyContext
): SafetyReport {
  // This is a stub - actual implementation uses AI analysis
  throw new Error('Not implemented: analyzeCommandSafety requires AI service')
}

/**
 * Check if a command matches any dangerous patterns
 */
export function matchesDangerousPattern(cmd: string): {
  matches: boolean
  patterns: string[]
} {
  const matchedPatterns: string[] = []

  for (const [category, patterns] of Object.entries(DANGEROUS_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(cmd)) {
        matchedPatterns.push(category)
        break
      }
    }
  }

  return {
    matches: matchedPatterns.length > 0,
    patterns: matchedPatterns,
  }
}

/**
 * Extract the base command from a command string
 */
export function extractBaseCommand(cmd: string): string {
  // Remove leading whitespace and sudo/doas
  const cleaned = cmd.trim().replace(/^(sudo|doas)\s+/, '')

  // Split on whitespace and pipes
  const parts = cleaned.split(/[\s|;&]+/)

  // Return first non-empty part
  return parts.find((p) => p.length > 0) || ''
}

/**
 * Check if a command is read-only
 */
export function isReadOnlyCommand(cmd: string): boolean {
  const base = extractBaseCommand(cmd)
  return READ_ONLY_COMMANDS.has(base)
}

/**
 * Check if a command requires elevation
 */
export function requiresElevation(cmd: string): boolean {
  return DANGEROUS_PATTERNS.elevation.some((p) => p.test(cmd))
}
