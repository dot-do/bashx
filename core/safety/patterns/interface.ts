/**
 * Language Safety Pattern Interface
 *
 * Generic interface for language-specific safety pattern analyzers.
 * This enables extensible multi-language safety analysis by providing
 * a common contract that all language analyzers must implement.
 *
 * Usage:
 * 1. Create an analyzer implementing LanguageSafetyAnalyzer
 * 2. Register it with registerAnalyzer()
 * 3. Use analyzeForLanguage() to analyze code
 *
 * @packageDocumentation
 */

import type { ImpactLevel as SharedImpactLevel } from './shared.js'
import type { SupportedLanguage } from '../../types.js'

/**
 * Impact level with 'none' for safe patterns.
 * Extends the shared ImpactLevel to include a 'none' option.
 */
export type ImpactLevel = SharedImpactLevel | 'none'

/**
 * Pattern analysis result from a language safety analyzer.
 * Represents the outcome of analyzing code for dangerous patterns.
 */
export interface PatternAnalysisResult {
  /** Overall impact level of the analyzed code */
  impact: ImpactLevel
  /** List of detected pattern names */
  patterns: string[]
  /** Optional suggestions for safer alternatives */
  suggestions?: string[]
}

/**
 * A safety pattern definition with metadata.
 * Defines what to look for in code and its impact level.
 */
export interface SafetyPattern {
  /** Unique name for the pattern (e.g., 'eval', 'system') */
  name: string
  /** Regex pattern to match in source code */
  pattern: RegExp
  /** Impact level when matched */
  impact: ImpactLevel
  /** Human-readable description of the pattern */
  description: string
}

/**
 * Language-specific safety analyzer interface.
 * Implement this interface to add safety analysis for a new language.
 *
 * @example
 * ```typescript
 * export const pythonAnalyzer: LanguageSafetyAnalyzer = {
 *   language: 'python',
 *   patterns: PYTHON_PATTERNS,
 *   analyze: analyzePython
 * }
 *
 * registerAnalyzer(pythonAnalyzer)
 * ```
 */
export interface LanguageSafetyAnalyzer {
  /** The language this analyzer handles */
  language: SupportedLanguage
  /** List of safety patterns this analyzer checks */
  patterns: SafetyPattern[]
  /** Analyze code and return safety classification */
  analyze(code: string): LanguageAnalysisResult
}

/**
 * Result of language-specific safety analysis.
 * Provides detailed information about detected patterns.
 */
export interface LanguageAnalysisResult {
  /** The language that was analyzed */
  language: SupportedLanguage
  /** Overall impact level */
  impact: ImpactLevel
  /** List of matched pattern names */
  matchedPatterns: string[]
  /** Human-readable description of findings */
  description: string
}

// =============================================================================
// Analyzer Registry
// =============================================================================

/** Internal registry of language analyzers */
const analyzers = new Map<SupportedLanguage, LanguageSafetyAnalyzer>()

/**
 * Registers a language safety analyzer.
 * Call this to make an analyzer available for use.
 *
 * @param analyzer - The analyzer to register
 *
 * @example
 * ```typescript
 * registerAnalyzer(pythonAnalyzer)
 * registerAnalyzer(rubyAnalyzer)
 * registerAnalyzer(nodeAnalyzer)
 * ```
 */
export function registerAnalyzer(analyzer: LanguageSafetyAnalyzer): void {
  analyzers.set(analyzer.language, analyzer)
}

/**
 * Gets a registered analyzer for a specific language.
 *
 * @param language - The language to get the analyzer for
 * @returns The analyzer or undefined if not registered
 */
export function getAnalyzer(
  language: SupportedLanguage
): LanguageSafetyAnalyzer | undefined {
  return analyzers.get(language)
}

/**
 * Gets all registered analyzers.
 *
 * @returns Array of all registered analyzers
 */
export function getRegisteredAnalyzers(): LanguageSafetyAnalyzer[] {
  return Array.from(analyzers.values())
}

/**
 * Gets all registered language names.
 *
 * @returns Array of supported language names
 */
export function getRegisteredLanguages(): SupportedLanguage[] {
  return Array.from(analyzers.keys())
}

/**
 * Checks if an analyzer is registered for a language.
 *
 * @param language - The language to check
 * @returns true if an analyzer is registered
 */
export function hasAnalyzer(language: SupportedLanguage): boolean {
  return analyzers.has(language)
}

/**
 * Clears all registered analyzers.
 * Primarily useful for testing.
 */
export function clearAnalyzers(): void {
  analyzers.clear()
}

/**
 * Analyzes code for a specific language using the registered analyzer.
 * Falls back to a safe default result if no analyzer is registered.
 *
 * @param code - The source code to analyze
 * @param language - The programming language of the code
 * @returns Analysis result with impact level and detected patterns
 *
 * @example
 * ```typescript
 * const result = analyzeForLanguage('eval(user_input)', 'python')
 * // Returns: { language: 'python', impact: 'critical', matchedPatterns: ['eval'], ... }
 * ```
 */
export function analyzeForLanguage(
  code: string,
  language: SupportedLanguage
): LanguageAnalysisResult {
  const analyzer = analyzers.get(language)

  if (!analyzer) {
    return {
      language,
      impact: 'none',
      matchedPatterns: [],
      description: `No safety analyzer registered for ${language}`,
    }
  }

  return analyzer.analyze(code)
}
