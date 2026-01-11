/**
 * @dotdo/bashx PTY Module
 *
 * Virtual PTY implementation for headless terminal emulation.
 * Enables TUI frameworks like React Ink to run in Durable Objects
 * and other headless JavaScript environments.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import { VirtualPTY } from '@dotdo/bashx/pty'
 *
 * // Create a virtual terminal
 * const pty = new VirtualPTY({ cols: 80, rows: 24 })
 *
 * // Listen for screen changes (for streaming to clients)
 * pty.onScreenChange((event, buffer) => {
 *   // Send buffer state to connected clients
 *   broadcastToClients(buffer.toString())
 * })
 *
 * // Write data to the terminal
 * pty.write('\x1b[31mHello\x1b[0m World!\n')
 *
 * // Get environment variables for child processes
 * const env = pty.getEnvironment()
 * // { TERM: 'xterm-256color', COLUMNS: '80', LINES: '24', ... }
 * ```
 */

// ============================================================================
// Main Exports
// ============================================================================

export { VirtualPTY } from './virtual-pty.js'
export { ANSIParser } from './parser.js'
export { TerminalBuffer, createDefaultAttributes, createEmptyCell, createDefaultCursor } from './buffer.js'

// ============================================================================
// Type Exports
// ============================================================================

export type {
  // Core configuration
  VirtualPTYOptions,
  PTYInfo,

  // Screen buffer types
  ScreenBuffer,
  Cell,
  CellAttributes,
  CursorState,
  Color,
  ColorCode,
  RGBColor,

  // Parser types
  ParserState,
  ParsedSequence,

  // Event types
  PTYEvent,
  ScreenChangeEvent,
  BellEvent,
  TitleChangeEvent,

  // Callback types
  DataCallback,
  ScreenChangeCallback,
  SequenceCallback,
  EventCallback,
} from './types.js'
