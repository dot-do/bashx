# bashx.do

> AI-enhanced bash execution with safety, intent understanding, and intelligent recovery

**bashx** wraps bash with judgment. It doesn't just execute—it **thinks** before executing.

```typescript
import { bashx } from 'bashx'

// Natural language → safe execution
await bashx`deploy the latest commit to staging`

// Explain before running
const explanation = await bashx.explain('find . -name "*.log" -delete')
// → "Recursively finds all .log files and deletes them. IRREVERSIBLE."

// Safety check
const report = await bashx.safe('chmod -R 777 /')
// → { safe: false, reasons: ['Recursive permission change on root'], severity: 'critical' }
```

## The Problem

```
fsx.do  = filesystem + AI → safe, reversible
gitx.do = git + AI        → safe, versioned
bash    = execute anything → DANGEROUS, irreversible
```

Bash is the universal execution layer. Every tool ultimately becomes a bash command. But unlike filesystems or git, **bash executes with consequences**.

## The Solution

bashx adds a **judgment layer** between intent and execution:

1. **Understands intent** (not just syntax)
2. **Assesses risk** (before running)
3. **Provides alternatives** (safer options)
4. **Recovers from failure** (intelligent retry)
5. **Explains actions** (transparency)

## Installation

```bash
npm install bashx
# or
pnpm add bashx
```

## API

### Natural Language Execution

```typescript
// Tagged template for intent-based execution
await bashx`list all typescript files modified today`
await bashx`clean up node_modules and rebuild`
await bashx`deploy to production` // Will require confirmation!
```

### Direct Execution with Safety

```typescript
// Execute with safety requirements
const result = await bashx.run({
  cmd: 'rm -rf ./build',
  intent: 'clean build directory',
  require: {
    safe: true,        // Must pass safety check
    reversible: true,  // Must be undoable
    maxImpact: 'medium' // Impact threshold
  }
})

// Dry run by default for dangerous operations
if (result.dryRun) {
  console.log('Would delete:', result.wouldDelete)
  await result.confirm() // Explicitly confirm
}
```

### Explain Commands

```typescript
const explanation = await bashx.explain('grep -r "TODO" --include="*.ts" | wc -l')
// {
//   summary: "Count lines containing 'TODO' in TypeScript files",
//   breakdown: [
//     { part: 'grep', type: 'command', explanation: 'Search for patterns in files' },
//     { part: '-r', type: 'flag', explanation: 'Search recursively' },
//     { part: '"TODO"', type: 'argument', explanation: 'Pattern to search for' },
//     { part: '--include="*.ts"', type: 'flag', explanation: 'Only search .ts files' },
//     { part: '|', type: 'pipe', explanation: 'Send output to next command' },
//     { part: 'wc -l', type: 'command', explanation: 'Count lines' }
//   ],
//   classification: { type: 'read', reversible: true, impact: 'none' },
//   sideEffects: []
// }
```

### Safety Analysis

```typescript
const report = await bashx.safe('rm -rf /', {
  cwd: '/home/user',
  user: 'developer'
})
// {
//   safe: false,
//   classification: {
//     type: 'delete',
//     reversible: false,
//     scope: 'global',
//     impact: 'critical',
//     requires: ['confirmation', 'sudo']
//   },
//   risks: [
//     { severity: 'critical', description: 'Deletes entire filesystem' }
//   ],
//   recommendations: [
//     'Never run this command',
//     'If cleaning up, specify exact directory'
//   ],
//   alternatives: [
//     { command: 'rm -rf ./build', description: 'Delete specific directory' }
//   ]
// }
```

### Generate Commands from Intent

```typescript
const generated = await bashx.generate('find large files over 100MB', {
  platform: 'darwin',
  shell: 'zsh'
})
// {
//   command: 'find . -type f -size +100M -exec ls -lh {} \\;',
//   explanation: 'Find files larger than 100MB and show their sizes',
//   classification: { type: 'read', ... },
//   alternatives: [
//     { command: 'du -h . | sort -rh | head -20', ... }
//   ]
// }
```

### Intelligent Recovery

```typescript
// Auto-recovery on common errors
const result = await bashx.exec('npm install', {
  recover: true,
  maxAttempts: 3
})
// If ENOSPC → cleanup temp files, retry
// If EACCES → suggest sudo or fix permissions
// If ENOENT → suggest creating directory
```

### Fix Failed Commands

```typescript
const fixed = await bashx.fix(
  'git commit -m "update"',
  'error: pathspec "update" did not match any file(s) known to git'
)
// {
//   command: 'git commit -m "update"',
//   explanation: 'The -m flag needs quotes around the message',
//   warnings: ['Make sure you have staged changes with git add']
// }
```

### Parse Command Output

```typescript
const npmAudit = await bashx.exec('npm audit --json')
const vulns = await bashx.parse(npmAudit.stdout, {
  critical: 'number',
  high: 'number',
  moderate: 'number',
  low: 'number',
  total: 'number'
})
// { critical: 2, high: 5, moderate: 12, low: 3, total: 22 }
```

## MCP Integration

bashx exposes 18 tools via Model Context Protocol:

| Tool | Description |
|------|-------------|
| `bash_run` | Execute command with safety checks |
| `bash_explain` | Explain what command does |
| `bash_safe` | Check if command is safe |
| `bash_generate` | Generate command from intent |
| `bash_dry_run` | Simulate command execution |
| `bash_pipe` | Chain commands with AI |
| `bash_parse` | Parse command output |
| `bash_env` | Get/set environment |
| `bash_history` | Search command history |
| `bash_alias` | Manage command aliases |
| `bash_which` | Find command location |
| `bash_man` | Get command documentation |
| `bash_complete` | Auto-complete command |
| `bash_fix` | Fix broken command |
| `bash_optimize` | Optimize command |
| `bash_undo` | Undo last command |
| `bash_script` | Generate shell script |
| `bash_cron` | Manage scheduled tasks |

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
┌─────────────────────────────────────────────────────────────┐
│                      bashx.do SDK                           │
│  bashx`intent` → safety check → execute → parse output     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Evaluation Layer                          │
│  ┌───────────────┐  ┌────────────────┐  ┌───────────────┐  │
│  │ Intent Parser │  │ Safety Checker │  │ Context Builder│  │
│  │ (ai.extract)  │  │ (ai.is)        │  │ (fsx, gitx)   │  │
│  └───────────────┘  └────────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Execution Layer                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ Sandbox     │  │ Dry-Run     │  │ Live Execution      │ │
│  │ (isolated)  │  │ (simulate)  │  │ (with recovery)     │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Safety Classification

Every command is classified before execution:

```typescript
interface CommandClassification {
  type: 'read' | 'write' | 'delete' | 'execute' | 'network' | 'system'
  reversible: boolean
  scope: 'file' | 'directory' | 'tree' | 'system' | 'global'
  impact: 'none' | 'low' | 'medium' | 'high' | 'critical'
  requires: ('confirmation' | 'backup' | 'dryrun' | 'sudo')[]
}
```

## License

MIT
