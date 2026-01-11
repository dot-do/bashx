/**
 * VirtualPTY - Headless Terminal Emulator
 *
 * A virtual PTY implementation that can run in any JavaScript environment.
 * Makes TUI frameworks like React Ink believe they have a real terminal.
 *
 * @packageDocumentation
 */

import { ANSIParser } from './parser.js'
import { TerminalBuffer } from './buffer.js'
import type {
  VirtualPTYOptions,
  PTYInfo,
  PTYEvent,
  ScreenChangeEvent,
  ParsedSequence,
  DataCallback,
  ScreenChangeCallback,
  SequenceCallback,
  EventCallback,
  ScreenBuffer,
  Color,
} from './types.js'
import {
  BEL,
  BS,
  HT,
  LF,
  VT,
  FF,
  CR,
  SGR,
  DECModes,
  CSICommands,
  ESCCommands,
  OSCCommands,
} from './constants.js'

// ============================================================================
// VirtualPTY Class
// ============================================================================

/**
 * VirtualPTY emulates a terminal for headless environments.
 *
 * Key features:
 * - Parses and executes ANSI escape sequences
 * - Maintains a screen buffer with cursor position and colors
 * - Exposes callbacks for streaming output to clients
 * - Provides WritableStream interface for stdout/stderr
 * - Reports as a TTY to satisfy isatty() checks
 *
 * @example
 * ```typescript
 * const pty = new VirtualPTY({ cols: 80, rows: 24 })
 *
 * // Listen for screen changes
 * pty.onScreenChange((event, buffer) => {
 *   console.log('Screen updated:', buffer.toString())
 * })
 *
 * // Write data (like from a child process)
 * pty.write('\x1b[31mHello\x1b[0m World!\n')
 *
 * // Get current screen state
 * console.log(pty.getScreenBuffer().toString())
 * ```
 */
export class VirtualPTY {
  /** Configuration */
  private readonly options: Required<VirtualPTYOptions>

  /** Screen buffer */
  private readonly buffer: TerminalBuffer

  /** ANSI parser */
  private readonly parser: ANSIParser

  /** Total bytes written */
  private _bytesWritten = 0

  /** Total sequences parsed */
  private _sequencesParsed = 0

  /** Terminal title (set via OSC) */
  private _title = ''

  /** Callbacks */
  private dataCallbacks: DataCallback[] = []
  private screenChangeCallbacks: ScreenChangeCallback[] = []
  private sequenceCallbacks: SequenceCallback[] = []
  private eventCallbacks: EventCallback[] = []

  constructor(options: VirtualPTYOptions = {}) {
    this.options = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      trackBuffer: options.trackBuffer ?? true,
      scrollback: options.scrollback ?? 1000,
      termType: options.termType ?? 'xterm-256color',
      env: options.env ?? {},
    }

    this.buffer = new TerminalBuffer(this.options.cols, this.options.rows)

    this.parser = new ANSIParser({
      onSequence: this.handleSequence.bind(this),
      onPrint: this.handlePrint.bind(this),
      onExecute: this.handleExecute.bind(this),
      onOSC: this.handleOSC.bind(this),
    })
  }

  // ==========================================================================
  // Public API - Writing
  // ==========================================================================

  /** Track if any printable characters were written during parse */
  private _pendingScreenChange = false

  /**
   * Write data to the PTY (string or bytes)
   */
  write(data: string | Uint8Array): void {
    const bytes = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data

    this._bytesWritten += bytes.length

    // Notify raw data listeners
    for (const cb of this.dataCallbacks) {
      cb(data)
    }

    // Reset pending change flag
    this._pendingScreenChange = false

    // Parse through state machine
    this.parser.parse(bytes)

    // Emit screen change if any printable chars were written
    if (this._pendingScreenChange) {
      this.emitScreenChange('write')
    }
  }

  /**
   * Get a WritableStream that writes to this PTY
   */
  getWritableStream(): WritableStream<Uint8Array> {
    const pty = this
    return new WritableStream({
      write(chunk) {
        pty.write(chunk)
      },
    })
  }

  /**
   * Get a writer object compatible with stream writers
   */
  getWriter(): { write: (data: string | Uint8Array) => void } {
    return {
      write: (data: string | Uint8Array) => this.write(data),
    }
  }

  // ==========================================================================
  // Public API - Screen Buffer
  // ==========================================================================

  /**
   * Get the current screen buffer
   */
  getScreenBuffer(): TerminalBuffer {
    return this.buffer
  }

  /**
   * Get a snapshot of the screen buffer (immutable copy)
   */
  getSnapshot(): ScreenBuffer {
    return this.buffer.snapshot()
  }

  /**
   * Get screen content as string
   */
  toString(): string {
    return this.buffer.toString()
  }

  /**
   * Get all lines as array
   */
  getLines(): string[] {
    return this.buffer.getLines()
  }

  // ==========================================================================
  // Public API - Resizing
  // ==========================================================================

  /**
   * Resize the terminal
   */
  resize(cols: number, rows: number): void {
    this.buffer.resize(cols, rows)
    this.emitScreenChange('resize')
  }

  // ==========================================================================
  // Public API - Information
  // ==========================================================================

  /**
   * Get PTY information
   */
  getInfo(): PTYInfo {
    return {
      cols: this.buffer.cols,
      rows: this.buffer.rows,
      termType: this.options.termType,
      isTTY: true,
      bytesWritten: this._bytesWritten,
      sequencesParsed: this._sequencesParsed,
    }
  }

  /**
   * Get terminal title (set by OSC sequences)
   */
  getTitle(): string {
    return this._title
  }

  /**
   * Whether this is a TTY (always true for VirtualPTY)
   */
  get isTTY(): true {
    return true
  }

  /**
   * Number of columns
   */
  get columns(): number {
    return this.buffer.cols
  }

  /**
   * Number of rows
   */
  get rows(): number {
    return this.buffer.rows
  }

  // ==========================================================================
  // Public API - Event Handlers
  // ==========================================================================

  /**
   * Register callback for raw data
   */
  onData(callback: DataCallback): () => void {
    this.dataCallbacks.push(callback)
    return () => {
      const idx = this.dataCallbacks.indexOf(callback)
      if (idx >= 0) this.dataCallbacks.splice(idx, 1)
    }
  }

  /**
   * Register callback for screen changes
   */
  onScreenChange(callback: ScreenChangeCallback): () => void {
    this.screenChangeCallbacks.push(callback)
    return () => {
      const idx = this.screenChangeCallbacks.indexOf(callback)
      if (idx >= 0) this.screenChangeCallbacks.splice(idx, 1)
    }
  }

  /**
   * Register callback for parsed sequences
   */
  onSequence(callback: SequenceCallback): () => void {
    this.sequenceCallbacks.push(callback)
    return () => {
      const idx = this.sequenceCallbacks.indexOf(callback)
      if (idx >= 0) this.sequenceCallbacks.splice(idx, 1)
    }
  }

  /**
   * Register callback for PTY events
   */
  onEvent(callback: EventCallback): () => void {
    this.eventCallbacks.push(callback)
    return () => {
      const idx = this.eventCallbacks.indexOf(callback)
      if (idx >= 0) this.eventCallbacks.splice(idx, 1)
    }
  }

  // ==========================================================================
  // Public API - Environment
  // ==========================================================================

  /**
   * Get environment variables that should be set for child processes
   */
  getEnvironment(): Record<string, string> {
    return {
      TERM: this.options.termType,
      COLUMNS: String(this.buffer.cols),
      LINES: String(this.buffer.rows),
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
      ...this.options.env,
    }
  }

  // ==========================================================================
  // Internal - Sequence Handling
  // ==========================================================================

  /**
   * Handle a parsed ANSI sequence
   */
  private handleSequence(sequence: ParsedSequence): void {
    this._sequencesParsed++

    // Notify listeners
    for (const cb of this.sequenceCallbacks) {
      cb(sequence)
    }

    // Execute the sequence
    switch (sequence.type) {
      case 'csi':
        this.executeCSI(sequence)
        break
      case 'esc':
        this.executeEscape(sequence)
        break
    }

    this.emitScreenChange('write')
  }

  /**
   * Handle a printable character
   */
  private handlePrint(char: string, _code: number): void {
    this.buffer.writeChar(char)
    this._pendingScreenChange = true
  }

  /**
   * Handle a control character
   */
  private handleExecute(code: number): void {
    switch (code) {
      case BEL:
        this.emitEvent({ type: 'bell', timestamp: Date.now() })
        break
      case BS:
        this.buffer.backspace()
        break
      case HT:
        this.buffer.tab()
        break
      case LF:
      case VT:
      case FF:
        this.buffer.lineFeed()
        break
      case CR:
        this.buffer.carriageReturn()
        break
    }
  }

  /**
   * Handle an OSC (Operating System Command) sequence
   */
  private handleOSC(params: string[]): void {
    if (params.length === 0) return

    const ps = parseInt(params[0], 10)

    switch (ps) {
      case 0: // Set icon name and window title
      case 1: // Set icon name
      case 2: // Set window title
        if (params.length > 1) {
          this._title = params.slice(1).join(';')
          this.emitEvent({ type: 'title', title: this._title, timestamp: Date.now() })
        }
        break
      // Other OSC codes could be handled here (clipboard, colors, etc.)
    }
  }

  /**
   * Execute a CSI sequence
   */
  private executeCSI(seq: ParsedSequence): void {
    const params = seq.params
    const p0 = params[0] ?? 1  // Default to 1 for most commands
    const p1 = params[1] ?? 1

    // Handle private sequences (e.g., ?25h for cursor)
    if (seq.privateMarker === '?') {
      this.executePrivateCSI(seq)
      return
    }

    switch (seq.finalChar) {
      // Cursor movement
      case 'A': // CUU - Cursor Up
        this.buffer.cursorUp(p0 || 1)
        break
      case 'B': // CUD - Cursor Down
        this.buffer.cursorDown(p0 || 1)
        break
      case 'C': // CUF - Cursor Forward
        this.buffer.cursorForward(p0 || 1)
        break
      case 'D': // CUB - Cursor Backward
        this.buffer.cursorBackward(p0 || 1)
        break
      case 'E': // CNL - Cursor Next Line
        this.buffer.carriageReturn()
        this.buffer.cursorDown(p0 || 1)
        break
      case 'F': // CPL - Cursor Previous Line
        this.buffer.carriageReturn()
        this.buffer.cursorUp(p0 || 1)
        break
      case 'G': // CHA - Cursor Horizontal Absolute
        this.buffer.moveCursor((p0 || 1) - 1, this.buffer.cursor.y)
        break
      case 'H': // CUP - Cursor Position
      case 'f': // HVP - Horizontal Vertical Position
        this.buffer.moveCursor((p1 || 1) - 1, (p0 || 1) - 1)
        break
      case 'd': // VPA - Vertical Position Absolute
        this.buffer.moveCursor(this.buffer.cursor.x, (p0 || 1) - 1)
        break

      // Erase
      case 'J': // ED - Erase in Display
        switch (params[0] ?? 0) {
          case 0:
            this.buffer.eraseToEndOfScreen()
            break
          case 1:
            this.buffer.eraseToStartOfScreen()
            break
          case 2:
          case 3:
            this.buffer.eraseScreen()
            break
        }
        break
      case 'K': // EL - Erase in Line
        switch (params[0] ?? 0) {
          case 0:
            this.buffer.eraseToEndOfLine()
            break
          case 1:
            this.buffer.eraseToStartOfLine()
            break
          case 2:
            this.buffer.eraseLine()
            break
        }
        break

      // Insert/Delete
      case '@': // ICH - Insert Character
        this.buffer.insertChars(p0 || 1)
        break
      case 'P': // DCH - Delete Character
        this.buffer.deleteChars(p0 || 1)
        break
      case 'L': // IL - Insert Line
        this.buffer.insertLines(p0 || 1)
        break
      case 'M': // DL - Delete Line
        this.buffer.deleteLines(p0 || 1)
        break

      // Scroll
      case 'S': // SU - Scroll Up
        this.buffer.scrollUp(p0 || 1)
        this.emitScreenChange('scroll')
        break
      case 'T': // SD - Scroll Down
        this.buffer.scrollDown(p0 || 1)
        this.emitScreenChange('scroll')
        break

      // Scroll region
      case 'r': // DECSTBM - Set Top and Bottom Margins
        this.buffer.setScrollRegion(
          (p0 || 1) - 1,
          (params[1] ?? this.buffer.rows) - 1
        )
        break

      // SGR - Select Graphic Rendition (colors and attributes)
      case 'm':
        this.executeSGR(params)
        break

      // Cursor save/restore
      case 's': // SCP - Save Cursor Position
        this.buffer.saveCursor()
        break
      case 'u': // RCP - Restore Cursor Position
        this.buffer.restoreCursor()
        break

      // Device status reports (we just acknowledge them)
      case 'n': // DSR - Device Status Report
        // Would need to implement response mechanism
        break
    }
  }

  /**
   * Execute a private CSI sequence (with ? prefix)
   */
  private executePrivateCSI(seq: ParsedSequence): void {
    const p0 = seq.params[0] ?? 0

    switch (seq.finalChar) {
      case 'h': // DECSET - DEC Private Mode Set
        switch (p0) {
          case 25: // DECTCEM - Show cursor
            this.buffer.setCursorVisible(true)
            this.emitScreenChange('cursor')
            break
          case 1049: // Alternate screen buffer
            // Could implement alternate buffer here
            break
        }
        break
      case 'l': // DECRST - DEC Private Mode Reset
        switch (p0) {
          case 25: // DECTCEM - Hide cursor
            this.buffer.setCursorVisible(false)
            this.emitScreenChange('cursor')
            break
          case 1049: // Main screen buffer
            break
        }
        break
    }
  }

  /**
   * Execute an escape sequence
   */
  private executeEscape(seq: ParsedSequence): void {
    switch (seq.finalChar) {
      case '7': // DECSC - Save Cursor
        this.buffer.saveCursor()
        break
      case '8': // DECRC - Restore Cursor
        this.buffer.restoreCursor()
        break
      case 'M': // RI - Reverse Index
        this.buffer.reverseLineFeed()
        break
      case 'c': // RIS - Reset to Initial State
        this.buffer.eraseScreen()
        this.buffer.moveCursor(0, 0)
        this.buffer.resetAttributes()
        this.emitScreenChange('clear')
        break
    }
  }

  /**
   * Execute SGR (Select Graphic Rendition) sequence
   */
  private executeSGR(params: number[]): void {
    // If no params, treat as reset
    if (params.length === 0) {
      this.buffer.resetAttributes()
      return
    }

    let i = 0
    while (i < params.length) {
      const code = params[i]

      switch (code) {
        case 0: // Reset
          this.buffer.resetAttributes()
          break
        case 1: // Bold
          this.buffer.setAttribute('bold', true)
          break
        case 2: // Dim
          this.buffer.setAttribute('dim', true)
          break
        case 3: // Italic
          this.buffer.setAttribute('italic', true)
          break
        case 4: // Underline
          this.buffer.setAttribute('underline', true)
          break
        case 5: // Blink
          this.buffer.setAttribute('blink', true)
          break
        case 7: // Inverse
          this.buffer.setAttribute('inverse', true)
          break
        case 8: // Hidden
          this.buffer.setAttribute('hidden', true)
          break
        case 9: // Strikethrough
          this.buffer.setAttribute('strikethrough', true)
          break
        case 22: // Normal intensity (not bold, not dim)
          this.buffer.setAttribute('bold', false)
          this.buffer.setAttribute('dim', false)
          break
        case 23: // Not italic
          this.buffer.setAttribute('italic', false)
          break
        case 24: // Not underlined
          this.buffer.setAttribute('underline', false)
          break
        case 25: // Not blinking
          this.buffer.setAttribute('blink', false)
          break
        case 27: // Not inverse
          this.buffer.setAttribute('inverse', false)
          break
        case 28: // Not hidden
          this.buffer.setAttribute('hidden', false)
          break
        case 29: // Not strikethrough
          this.buffer.setAttribute('strikethrough', false)
          break

        // Standard foreground colors (30-37)
        case 30: case 31: case 32: case 33:
        case 34: case 35: case 36: case 37:
          this.buffer.setForeground(code - 30)
          break

        // Extended foreground color
        case 38:
          i = this.parseExtendedColor(params, i, true)
          continue // parseExtendedColor advances i

        // Default foreground
        case 39:
          this.buffer.setForeground('default')
          break

        // Standard background colors (40-47)
        case 40: case 41: case 42: case 43:
        case 44: case 45: case 46: case 47:
          this.buffer.setBackground(code - 40)
          break

        // Extended background color
        case 48:
          i = this.parseExtendedColor(params, i, false)
          continue

        // Default background
        case 49:
          this.buffer.setBackground('default')
          break

        // Bright foreground colors (90-97)
        case 90: case 91: case 92: case 93:
        case 94: case 95: case 96: case 97:
          this.buffer.setForeground(code - 90 + 8)
          break

        // Bright background colors (100-107)
        case 100: case 101: case 102: case 103:
        case 104: case 105: case 106: case 107:
          this.buffer.setBackground(code - 100 + 8)
          break
      }

      i++
    }
  }

  /**
   * Parse extended color (256-color or RGB)
   * Returns the new index position
   */
  private parseExtendedColor(params: number[], i: number, isForeground: boolean): number {
    if (i + 1 >= params.length) return i + 1

    const mode = params[i + 1]

    if (mode === 5 && i + 2 < params.length) {
      // 256-color mode: 38;5;n or 48;5;n
      const colorIndex = params[i + 2]
      const color: Color = colorIndex
      if (isForeground) {
        this.buffer.setForeground(color)
      } else {
        this.buffer.setBackground(color)
      }
      return i + 3
    }

    if (mode === 2 && i + 4 < params.length) {
      // RGB mode: 38;2;r;g;b or 48;2;r;g;b
      const color: Color = {
        r: params[i + 2],
        g: params[i + 3],
        b: params[i + 4],
      }
      if (isForeground) {
        this.buffer.setForeground(color)
      } else {
        this.buffer.setBackground(color)
      }
      return i + 5
    }

    return i + 1
  }

  // ==========================================================================
  // Internal - Event Emission
  // ==========================================================================

  /**
   * Emit a screen change event
   */
  private emitScreenChange(type: ScreenChangeEvent['type']): void {
    const event: ScreenChangeEvent = {
      type,
      timestamp: Date.now(),
    }

    for (const cb of this.screenChangeCallbacks) {
      cb(event, this.buffer.snapshot())
    }

    this.emitEvent(event)
  }

  /**
   * Emit a PTY event
   */
  private emitEvent(event: PTYEvent): void {
    for (const cb of this.eventCallbacks) {
      cb(event)
    }
  }
}
