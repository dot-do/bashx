# bashx.do

**Safe shell execution for AI agents.** AST-parsed. Tiered execution. 1,400+ tests.

[![npm version](https://img.shields.io/npm/v/bashx.do.svg)](https://www.npmjs.com/package/bashx.do)
[![Tests](https://img.shields.io/badge/tests-1%2C415%20passing-brightgreen.svg)](https://github.com/dot-do/bashx)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why bashx?

**AI agents need to run shell commands.** But giving an AI unrestricted shell access is terrifying.

**bashx wraps bash with judgment.** Every command is parsed to an AST, analyzed for safety, and executed in the optimal tier - from native Workers APIs to full sandboxed Linux.

**Scales to millions of agents.** Each agent gets its own isolated shell environment on Cloudflare's edge network. No shared state. No noisy neighbors. Just safe, fast shell execution at global scale.

```typescript
import bash from 'bashx.do'

// Run commands safely
await bash`ls -la`
await bash`cat package.json`

// Dangerous commands are blocked
await bash`rm -rf /`
// => { blocked: true, reason: 'Recursive delete targeting root filesystem' }

// Unless explicitly confirmed
await bash`rm -rf node_modules`({ confirm: true })
```

## Installation

```bash
npm install bashx.do
```

For the pure library without Cloudflare dependencies:

```bash
npm install @dotdo/bashx
```

## Quick Start

```typescript
import bash from 'bashx.do'

// Simple commands
const files = await bash`ls -la`
const content = await bash`cat README.md`

// With interpolation (automatically escaped)
const filename = 'my file.txt'
await bash`cat ${filename}`  // => cat 'my file.txt'

// Natural language (auto-detected)
await bash`find all typescript files over 100 lines`
await bash`show disk usage for current directory`
```

## Architecture

```
Input (command OR natural language intent)
         |
         v
+-----------------------------------+
|         AST Parser                |
|    tree-sitter-bash (WASM)        |
+-----------------------------------+
         |
         v
+-----------------------------------+
|         Safety Analysis           |
|    Structural analysis, not regex |
|    -> type: 'delete'              |
|    -> impact: 'high'              |
|    -> reversible: false           |
+-----------------------------------+
         |
         v
+-----------------------------------+
|         Safety Gate               |
|    Block or require confirmation  |
+-----------------------------------+
         |
         v
+-----------------------------------+
|         Tier Selection            |
|    Pick optimal execution tier    |
+-----------------------------------+
         |
         v
+-----------------------------------+
|         Execute                   |
|    Run in selected tier           |
|    Track for undo                 |
+-----------------------------------+
         |
         v
Output: BashResult with full metadata
```

## Features

### AST-Based Safety Analysis

Every command is parsed with tree-sitter-bash and analyzed structurally - not with regex:

```typescript
// bashx understands command structure
await bash`rm -rf /`
// AST analysis:
// {
//   type: 'delete',
//   impact: 'critical',
//   reversible: false,
//   reason: 'Recursive delete targeting root filesystem'
// }

// Safe commands execute immediately
await bash`ls -la`  // impact: 'none', executes

// Dangerous commands require confirmation
await bash`chmod -R 777 /`  // blocked, requires confirm: true
```

### Tiered Execution

Commands run in the optimal tier for performance:

| Tier | Latency | Commands | Implementation |
|------|---------|----------|----------------|
| 1 | <1ms | cat, ls, head, tail, curl, wget, echo, printf | Native Workers APIs |
| 2 | <5ms | jq, git, npm | RPC to specialized services |
| 3 | <10ms | Node.js packages | Dynamic modules from esm.sh |
| 4 | 2-3s cold | Python, bash scripts, binaries | Full sandboxed Linux |

### Command Options

```typescript
// Confirm dangerous operations
await bash`rm -rf node_modules`({ confirm: true })

// Dry run (see what would happen)
await bash`deploy.sh`({ dryRun: true })

// Custom timeout
await bash`long-running-task`({ timeout: 60000 })

// Working directory
await bash`npm install`({ cwd: './packages/core' })
```

### Rich Results

Every command returns detailed information:

```typescript
const result = await bash`git status`

result.stdout        // Command output
result.stderr        // Error output
result.exitCode      // Exit code

result.ast           // Parsed AST (tree-sitter)
result.intent        // { commands: ['git'], reads: [], writes: [] }
result.classification // { type: 'read', impact: 'none', reversible: true }

result.undo          // Command to reverse (if reversible)
result.blocked       // Was execution blocked?
result.blockReason   // Why it was blocked
```

### Syntax Fixing

bashx can detect and fix malformed commands:

```typescript
await bash`echo "hello`
// => Detects unclosed quote
// => fixed: { command: 'echo "hello"', changes: [...] }
```

### Undo Support

Reversible commands can be undone:

```typescript
await bash`mv file.txt backup.txt`
// result.undo = 'mv backup.txt file.txt'

await bash`mkdir -p /app/data`
// result.undo = 'rmdir /app/data'
```

## MCP Integration

One tool for Claude Desktop and other MCP clients:

```json
{
  "mcpServers": {
    "bashx": {
      "command": "npx",
      "args": ["bashx.do", "--mcp"]
    }
  }
}
```

The AI gets one tool: `bash`. It handles everything.

```typescript
{
  name: 'bash',
  description: 'Execute commands with AST-based safety analysis',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Command or intent' },
      confirm: { type: 'boolean', description: 'Confirm dangerous operations' }
    }
  }
}
```

## Durable Object Integration

### With dotdo Framework

```typescript
import { DO } from 'dotdo'
import { withBash } from 'bashx.do/do'

class MySite extends withBash(DO) {
  async build() {
    await this.$.bash`npm install`
    await this.$.bash`npm run build`
    const result = await this.$.bash`npm test`
    return result.exitCode === 0
  }
}
```

### As RPC Service

```toml
# wrangler.toml
[[services]]
binding = "BASHX"
service = "bashx-worker"
```

```typescript
const result = await env.BASHX.exec('complex-script.sh')
```

## API Reference

### Tagged Template

```typescript
import bash from 'bashx.do'

// Basic usage
await bash`command`

// With options
await bash`command`({ confirm: true, timeout: 5000 })

// With interpolation (auto-escaped)
const file = 'my file.txt'
await bash`cat ${file}`
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `confirm` | boolean | Allow dangerous operations |
| `dryRun` | boolean | Show what would happen |
| `timeout` | number | Timeout in milliseconds |
| `cwd` | string | Working directory |

### Result Type

```typescript
interface BashResult {
  stdout: string
  stderr: string
  exitCode: number

  ast?: Program           // Parsed AST
  intent: Intent          // Extracted intent
  classification: Safety  // Safety classification

  blocked?: boolean
  blockReason?: string
  undo?: string
  suggestions?: string[]
}
```

## Core Library

For platform-agnostic usage without Cloudflare dependencies, use `@dotdo/bashx`:

```typescript
import {
  shellEscape,
  classifyInput,
  analyze,
  createProgram,
  createCommand
} from '@dotdo/bashx'

// Escape values for shell interpolation
const escaped = shellEscape('my file.txt')  // => 'my file.txt'

// Classify input as command or natural language
const result = await classifyInput('ls -la')
// { type: 'command', confidence: 0.95, ... }

// Analyze AST for safety
const ast = createProgram([createCommand('rm', ['-rf', 'temp'])])
const { classification, intent } = analyze(ast)
// classification: { type: 'delete', impact: 'high', reversible: false, ... }
```

See [core/README.md](./core/README.md) for full documentation of the core library.

## Project Structure

```
bashx/
  src/                    # Platform-dependent code (Cloudflare Workers)
    ast/                  # AST parsing with tree-sitter WASM
    mcp/                  # MCP tool definition
    do/                   # Durable Object integration
  core/                   # Pure library (@dotdo/bashx)
    ast/                  # AST type guards, factory functions
    safety/               # Safety analysis, classification
    escape/               # Shell escaping utilities
    classify/             # Input classification
    backend.ts            # Abstract backend interface
```

## Safety Principles

1. **Never execute without classification** - Every command gets classified
2. **Dry-run by default** for dangerous operations
3. **Structural analysis** - AST-based, not regex pattern matching
4. **Safer alternatives** - Always suggest when blocking

## Comparison

| Feature | Raw shell | bashx.do |
|---------|-----------|----------|
| Safety analysis | None | AST-based |
| Dangerous command blocking | No | Yes |
| Undo support | No | Yes |
| Tiered execution | No | Yes |
| Edge-native | No | Yes |
| AI-friendly | No | Yes |

## Performance

- **1,400+ tests** covering all operations
- **<1ms** for Tier 1 (native) commands
- **<5ms** for Tier 2 (RPC) commands
- **AST parsing** with tree-sitter WASM

## License

MIT

## Links

- [GitHub](https://github.com/dot-do/bashx)
- [Documentation](https://bashx.do)
- [Core Library](./core/README.md)
- [.do](https://do.org.ai)
- [Platform.do](https://platform.do)
