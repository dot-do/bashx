/**
 * Virtual PTY Types
 *
 * Type definitions for the VirtualPTY terminal emulation layer.
 * Enables TUI frameworks like React Ink to run in headless environments.
 *
 * @packageDocumentation
 */

// ============================================================================
// Branded Types for Type Safety
// ============================================================================

/**
 * Branded type helper - creates nominal types that are structurally
 * incompatible with plain values despite having the same underlying type.
 *
 * @example
 * ```typescript
 * type Row = Brand<number, 'Row'>
 * type Col = Brand<number, 'Col'>
 *
 * const row: Row = 5 as Row
 * const col: Col = 10 as Col
 *
 * // Type error: can't assign Row to Col
 * const wrong: Col = row
 * ```
 */
declare const __brand: unique symbol
export type Brand<T, B> = T & { [__brand]: B }

/**
 * Row index in the terminal buffer (0-based)
 */
export type Row = Brand<number, 'Row'>

/**
 * Column index in the terminal buffer (0-based)
 */
export type Col = Brand<number, 'Col'>

/**
 * SGR (Select Graphic Rendition) code
 */
export type SGRCode = Brand<number, 'SGRCode'>

/**
 * DEC private mode number
 */
export type DECMode = Brand<number, 'DECMode'>

/**
 * OSC (Operating System Command) code
 */
export type OSCCode = Brand<number, 'OSCCode'>

/**
 * Byte value (0-255)
 */
export type Byte = Brand<number, 'Byte'>

/**
 * Create a Row value
 */
export function row(n: number): Row {
  return n as Row
}

/**
 * Create a Col value
 */
export function col(n: number): Col {
  return n as Col
}

/**
 * Create an SGRCode value
 */
export function sgrCode(n: number): SGRCode {
  return n as SGRCode
}

/**
 * Create a DECMode value
 */
export function decMode(n: number): DECMode {
  return n as DECMode
}

/**
 * Create an OSCCode value
 */
export function oscCode(n: number): OSCCode {
  return n as OSCCode
}

/**
 * Create a Byte value
 */
export function byte(n: number): Byte {
  if (n < 0 || n > 255) {
    throw new RangeError(`Byte value must be 0-255, got ${n}`)
  }
  return n as Byte
}

// ============================================================================
// Screen Buffer Types
// ============================================================================

/**
 * ANSI color codes (0-255 for 256-color mode)
 * Standard colors: 0-15
 * 216 color cube: 16-231
 * Grayscale: 232-255
 */
export type ColorCode = number

/**
 * RGB color representation
 */
export interface RGBColor {
  r: number
  g: number
  b: number
}

/**
 * Color specification - either a code or RGB value
 */
export type Color = ColorCode | RGBColor | 'default'

/**
 * Text attributes for a cell
 */
export interface CellAttributes {
  /** Foreground color */
  fg: Color
  /** Background color */
  bg: Color
  /** Bold/bright text */
  bold: boolean
  /** Dim/faint text */
  dim: boolean
  /** Italic text */
  italic: boolean
  /** Underlined text */
  underline: boolean
  /** Blinking text */
  blink: boolean
  /** Inverse video (swap fg/bg) */
  inverse: boolean
  /** Hidden/invisible text */
  hidden: boolean
  /** Strikethrough text */
  strikethrough: boolean
}

/**
 * A single character cell in the screen buffer
 */
export interface Cell {
  /** The character (single Unicode codepoint or empty string for unset) */
  char: string
  /** Character width (0 for continuation cells in wide chars, 1-2 normally) */
  width: number
  /** Display attributes */
  attrs: CellAttributes
}

/**
 * Cursor state
 */
export interface CursorState {
  /** Column position (0-based) */
  x: number
  /** Row position (0-based) */
  y: number
  /** Whether cursor is visible */
  visible: boolean
  /** Cursor style */
  style: 'block' | 'underline' | 'bar'
  /** Whether cursor is blinking */
  blinking: boolean
}

/**
 * Screen buffer representing terminal display state
 */
export interface ScreenBuffer {
  /** Number of columns */
  cols: number
  /** Number of rows */
  rows: number
  /** 2D array of cells [row][col] */
  cells: Cell[][]
  /** Cursor state */
  cursor: CursorState
  /** Current default attributes for new characters */
  defaultAttrs: CellAttributes
  /** Scroll region top row (0-based, inclusive) */
  scrollTop: number
  /** Scroll region bottom row (0-based, inclusive) */
  scrollBottom: number
}

// ============================================================================
// Parser State Machine Types
// ============================================================================

/**
 * ANSI parser states based on VT500 state machine
 * @see https://vt100.net/emu/dec_ansi_parser
 */
export type ParserState =
  | 'ground'
  | 'escape'
  | 'escape_intermediate'
  | 'csi_entry'
  | 'csi_param'
  | 'csi_intermediate'
  | 'csi_ignore'
  | 'dcs_entry'
  | 'dcs_param'
  | 'dcs_intermediate'
  | 'dcs_passthrough'
  | 'dcs_ignore'
  | 'osc_string'
  | 'sos_pm_apc_string'

/**
 * Parsed ANSI escape sequence
 */
export interface ParsedSequence {
  /** Type of sequence */
  type: 'csi' | 'esc' | 'osc' | 'dcs' | 'control'
  /** Final character (command) */
  finalChar: string
  /** Private marker (e.g., '?' in CSI ? 25 h) */
  privateMarker?: string
  /** Intermediate characters */
  intermediates: string
  /** Numeric parameters */
  params: number[]
  /** Raw sequence string */
  raw: string
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Screen change event - emitted when display updates
 */
export interface ScreenChangeEvent {
  /** Type of change */
  type: 'write' | 'resize' | 'scroll' | 'clear' | 'cursor'
  /** Affected region (if applicable) */
  region?: {
    x: number
    y: number
    width: number
    height: number
  }
  /** Timestamp of the change */
  timestamp: number
}

/**
 * Bell event - emitted when BEL character received
 */
export interface BellEvent {
  type: 'bell'
  timestamp: number
}

/**
 * Title change event - emitted when OSC sets title
 */
export interface TitleChangeEvent {
  type: 'title'
  title: string
  timestamp: number
}

/**
 * Union type of all PTY events
 */
export type PTYEvent = ScreenChangeEvent | BellEvent | TitleChangeEvent

// ============================================================================
// Callback Types
// ============================================================================

/**
 * Callback for raw data streaming
 */
export type DataCallback = (data: Uint8Array | string) => void

/**
 * Callback for screen change events
 */
export type ScreenChangeCallback = (event: ScreenChangeEvent, buffer: ScreenBuffer) => void

/**
 * Callback for parsed sequences (useful for debugging/passthrough)
 */
export type SequenceCallback = (sequence: ParsedSequence) => void

/**
 * Callback for PTY events
 */
export type EventCallback = (event: PTYEvent) => void

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * VirtualPTY configuration options
 */
export interface VirtualPTYOptions {
  /** Number of columns (default: 80) */
  cols?: number
  /** Number of rows (default: 24) */
  rows?: number
  /** Whether to track full screen buffer state (default: true) */
  trackBuffer?: boolean
  /** Maximum scrollback lines (default: 1000, 0 to disable) */
  scrollback?: number
  /** Terminal type to report (default: 'xterm-256color') */
  termType?: string
  /** Initial environment variables */
  env?: Record<string, string>
}

/**
 * PTY info returned by getInfo()
 */
export interface PTYInfo {
  /** Number of columns */
  cols: number
  /** Number of rows */
  rows: number
  /** Terminal type */
  termType: string
  /** Whether PTY is a TTY (always true for VirtualPTY) */
  isTTY: true
  /** Total bytes written */
  bytesWritten: number
  /** Total sequences parsed */
  sequencesParsed: number
}
