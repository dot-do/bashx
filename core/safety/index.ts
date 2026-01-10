/**
 * Safety Module for @dotdo/bashx
 *
 * Provides safety analysis, classification, and intent extraction
 * for bash commands. Platform-agnostic with zero Cloudflare dependencies.
 *
 * @packageDocumentation
 */

export type {
  SafetyClassification,
  CommandClassification,
  SafetyAnalysis,
  DangerCheck,
  Intent,
  OperationType,
  ImpactLevel,
} from '../types.js'

export {
  analyze,
  isDangerous,
  classifyCommand,
  extractIntent,
  extractIntentFromAST,
  describeIntent,
} from './analyze.js'

export type { ExtendedIntent } from './analyze.js'
