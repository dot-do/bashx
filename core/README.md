# @dotdo/bashx

Pure library for bash command parsing, classification, escaping, and safety analysis. Zero Cloudflare dependencies - runs anywhere JavaScript runs.

## Installation

```bash
npm install @dotdo/bashx
```

## Features

- **AST Parsing** - Parse bash commands into abstract syntax trees
- **Safety Analysis** - Classify commands by risk level (safe, warning, critical)
- **Intent Extraction** - Understand what commands are trying to do
- **Shell Escaping** - POSIX-compliant argument escaping
- **Input Classification** - Detect natural language vs commands

## Usage

```typescript
import {
  parseCommand,
  classifySafety,
  extractIntent,
  escapeArg,
  isCommand
} from '@dotdo/bashx'

// Parse a command
const ast = parseCommand('ls -la /home')

// Check safety
const safety = classifySafety('rm -rf /')
// { level: 'critical', reason: 'Recursive deletion of root' }

// Extract intent
const intent = extractIntent('git push origin main')
// { action: 'push', target: 'remote', details: {...} }

// Escape arguments
const escaped = escapeArg("file with spaces.txt")
// 'file with spaces.txt'

// Classify input
isCommand('ls -la')  // true
isCommand('list all files')  // false
```

## Subpath Exports

```typescript
import { parse, walk, ASTNode } from '@dotdo/bashx/ast'
import { classify, SafetyLevel } from '@dotdo/bashx/safety'
import { isCommand, classify } from '@dotdo/bashx/classify'
import { escapeArg, escapeArgs } from '@dotdo/bashx/escape'
import { ShellBackend } from '@dotdo/bashx/backend'
```

## API

### AST (`@dotdo/bashx/ast`)

- `parse(command: string): ASTNode` - Parse command into AST
- `walk(node: ASTNode, visitor)` - Walk AST with visitor pattern
- `isCommand()`, `isPipeline()`, `isRedirect()` - Type guards

### Safety (`@dotdo/bashx/safety`)

- `classifySafety(command: string): SafetyClassification`
- `extractIntent(command: string): Intent`
- `suggestSafer(command: string): string | null`

### Classify (`@dotdo/bashx/classify`)

- `isCommand(input: string): boolean`
- `isNaturalLanguage(input: string): boolean`
- `classify(input: string): 'command' | 'natural' | 'ambiguous'`

### Escape (`@dotdo/bashx/escape`)

- `escapeArg(arg: string): string` - Escape single argument
- `escapeArgs(args: string[]): string[]` - Escape array of arguments
- `needsQuoting(arg: string): boolean` - Check if quoting needed

## Related

- [bashx.do](https://bashx.do) - Managed service with AI enhancement
- [fsx.do](https://fsx.do) - Filesystem for Workers
- [gitx.do](https://gitx.do) - Git for Workers

## License

MIT
