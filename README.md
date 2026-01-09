# bashx.do

> ONE tool. ONE interface. Maximum intelligence.

**bashx** wraps bash with judgment. It doesn't just execute—it **thinks** before executing.

```typescript
import { bash } from 'bashx'

// Just run commands
await bash`ls -la`

// Or describe what you want
await bash`find all typescript files over 100 lines`

// Dangerous commands are blocked
await bash`rm -rf /`  // → { blocked: true, requiresConfirm: true }

// Unless you confirm
await bash('rm -rf /', { confirm: true })  // → executes
```

## DO Integration

bashx provides the `$.bash` capability for dotdo Durable Objects:

```typescript
import { DO } from 'dotdo/bash'

class MySite extends DO {
  async build() {
    // $.bash is lazy-loaded from bashx
    await this.$.bash`npm install && npm run build`
    const result = await this.$.bash.exec('npm', ['run', 'test'])
  }
}
```

### Execution Tiers

bashx uses a **tiered execution model** for optimal performance:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Tier 1: Native In-Worker (<1ms)                   │
├─────────────────────────────────────────────────────────────────────┤
│  • fetch/ofetch (curl equivalent)     • JSON operations              │
│  • Node.js APIs (nodejs_compat_v2)    • Text processing              │
│  • Path, crypto, streams, zlib        • Basic file ops via $.fs      │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│                 Tier 2: RPC Bindings (<5ms)                          │
├─────────────────────────────────────────────────────────────────────┤
│  • $.jq → jq.do (jqjs as a service)                                  │
│  • $.npm → npm.do (package resolution/execution)                     │
│  • Heavy operations as separate Workers (keep bundle small)          │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│              Tier 3: worker_loaders (<10ms cold)                     │
├─────────────────────────────────────────────────────────────────────┤
│  • Dynamic npm packages (fetch from esm.sh, run in isolate)          │
│  • User-provided code (sandboxed V8 isolate)                         │
│  • ai-evaluate pattern for code execution                            │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│              Tier 4: Sandbox SDK (2-3s cold)                         │
├─────────────────────────────────────────────────────────────────────┤
│  Only for things that truly need Linux:                              │
│  • Shell scripts with bash-specific features                         │
│  • Python with native C extensions (numpy, pandas)                   │
│  • Binary executables (ffmpeg, imagemagick)                          │
└─────────────────────────────────────────────────────────────────────┘
```

### Native Command Mappings

Most Unix commands map to native Workers APIs:

| Command | Native Equivalent | Tier |
|---------|-------------------|------|
| `curl` | `ofetch`/`fetch` | 1 |
| `cat`, `head`, `tail` | `$.fs.read()` | 1 |
| `ls`, `find` | `$.fs.list()` | 1 |
| `jq` | RPC to jq.do or inline jqjs | 2 |
| `node` | nodejs_compat_v2 | 1 |
| `npm install` | esm.sh + worker_loaders | 3 |
| `bash script.sh` | Sandbox SDK | 4 |

### As an RPC Service

For heavy bash operations, bashx can run as a separate Worker:

```toml
# wrangler.toml
[[services]]
binding = "BASHX"
service = "bashx-do"
```

```typescript
// Heavy operations go through RPC
const result = await env.BASHX.exec('complex-script.sh')
```

## The Insight

```
fsx  → wraps filesystem protocol → discrete tools make sense
gitx → wraps git protocol       → discrete tools make sense
bashx → IS the universal tool   → ONE tool: bash
```

Bash already has thousands of "tools" - they're called commands. We don't re-wrap what's already wrapped.

## Installation

```bash
npm install bashx
# or
pnpm add bashx
```

## API

### Tagged Template

```typescript
import { bash } from 'bashx'

// Commands
await bash`git status`
await bash`find . -name "*.ts" | wc -l`

// With interpolation
const file = 'package.json'
await bash`cat ${file}`

// Natural language (auto-detected)
await bash`list all typescript files modified today`
await bash`find large files over 100MB`
```

### With Options

```typescript
// Confirm dangerous operations
await bash('rm -rf node_modules', { confirm: true })

// Dry run
await bash('deploy.sh', { dryRun: true })

// Custom timeout
await bash('long-running-task', { timeout: 60000 })

// Custom working directory
await bash('npm install', { cwd: './packages/core' })
```

## Result Type

Every invocation returns a rich result:

```typescript
interface BashResult {
  // Input
  input: string           // Original input
  command: string         // Actual command (or generated)
  generated: boolean      // Was command generated from intent?

  // AST Analysis
  ast?: Program           // Parsed AST (tree-sitter-bash)
  valid: boolean          // Syntactically valid?
  errors?: ParseError[]   // Syntax errors found
  fixed?: {               // Auto-fixed version (if fixable)
    command: string
    changes: Fix[]
  }

  // Semantic Understanding
  intent: {
    commands: string[]    // Commands being run
    reads: string[]       // Files being read
    writes: string[]      // Files being written
    deletes: string[]     // Files being deleted
    network: boolean      // Network access?
    elevated: boolean     // Needs sudo?
  }

  // Safety Classification
  classification: {
    type: 'read' | 'write' | 'delete' | 'execute' | 'network' | 'system'
    impact: 'none' | 'low' | 'medium' | 'high' | 'critical'
    reversible: boolean
    reason: string
  }

  // Execution
  stdout: string
  stderr: string
  exitCode: number

  // Safety Gate
  blocked?: boolean       // Was execution blocked?
  requiresConfirm?: boolean
  blockReason?: string

  // Recovery
  undo?: string           // Command to undo (if reversible)
  suggestions?: string[]  // Optimizations, alternatives
}
```

## MCP Integration

**ONE tool: `bash`**

```typescript
{
  name: 'bash',
  description: 'Execute bash commands with AI-enhanced safety and AST-based validation',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Command or intent' },
      confirm: { type: 'boolean', description: 'Confirm dangerous operations' }
    },
    required: ['input']
  }
}
```

### Claude Desktop Integration

```json
{
  "mcpServers": {
    "bashx": {
      "command": "npx",
      "args": ["bashx", "--mcp"]
    }
  }
}
```

## Architecture

```
Input: command OR intent
         ↓
┌─────────────────────────────────────┐
│         AST Parser                  │
│  • tree-sitter-bash (WASM)         │
│  • Parse to AST                    │
│  • Recover from errors             │
│  • Identify syntax issues          │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│         AST Analysis                │
│  • Extract commands, files         │
│  • Structural safety analysis      │
│  • Auto-fix syntax errors          │
│  • Suggest optimizations           │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│         Safety Gate                 │
│  • Classify from AST (not regex)   │
│  • Block critical operations       │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│         Execution                   │
│  • Run (possibly fixed) command    │
│  • Track for undo                  │
└─────────────────────────────────────┘
         ↓
Output: BashResult with AST metadata
```

## AST-Based Safety

Safety analysis uses **structural AST analysis**, not regex:

```typescript
// AST knows this is rm with -rf flag targeting /
// Not just pattern matching "rm -rf /"
const ast = parse('rm -rf /')
const analysis = analyze(ast)
// {
//   type: 'delete',
//   impact: 'critical',
//   reversible: false,
//   reason: 'Recursive delete targeting root filesystem'
// }
```

This enables:

1. **Structural detection** of dangerous patterns
2. **Syntax error detection** and auto-fixing
3. **Command optimization** suggestions
4. **Intent extraction** from AST structure

## Syntax Fixing

bashx can detect and fix malformed commands:

```typescript
// Input with unclosed quote
await bash`echo "hello`
// → Detects unclosed quote, suggests fix
// → fixed: { command: 'echo "hello"', changes: [...] }
```

## License

MIT
