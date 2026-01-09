# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

bashx.do is an AI-enhanced bash execution layer that wraps bash commands with intelligent judgment, safety analysis, and intent understanding. Unlike filesystem or git wrappers, bashx provides ONE tool called `bash` that accepts either commands or natural language intent, parses input using tree-sitter-bash WASM into an AST, and performs structural safety analysis (not regex-based).

**Core Philosophy**: "Think before executing"

## Commands

```bash
npm run build        # Compile TypeScript with tsup
npm run dev          # Watch mode build
npm run test         # Run tests with vitest (watch mode)
npm run test:run     # Run tests once
npm run typecheck    # TypeScript type checking
npm run lint         # Run ESLint on src/
npm run clean        # Remove dist/ directory
```

## Architecture

```
Input (command OR natural language intent)
    ↓
AST Parser (tree-sitter-bash WASM)
    ↓
AST Analysis (extract intent, auto-fix syntax, suggest optimizations)
    ↓
Safety Classification (structural, not regex-based)
    ↓
Safety Gate (block critical ops, require confirmation)
    ↓
Execution (run command, track for undo)
    ↓
BashResult (rich metadata)
```

**Key directories:**
- `src/` - Main source code
- `src/ast/` - AST parsing and analysis (tree-sitter integration)
- `src/mcp/` - MCP tool definition (single `bash` tool)

**Key files:**
- `src/types.ts` - Single source of truth for all TypeScript types
- `src/index.ts` - SDK entry point, exports `bash` function and `Bash()` factory

## Development Approach

This project follows strict TDD (Red-Green-Refactor). Use beads for issue tracking:

```bash
bd ready                              # Find available work
bd show <id>                          # View issue details
bd update <id> --status=in_progress   # Claim work
bd close <id>                         # Mark complete
bd sync                               # Sync with git remote
```

## Safety Principles

1. Never execute without classification - every command gets classified
2. Dry-run by default for dangerous operations
3. Use AST-based structural analysis, not regex pattern matching
4. Always suggest safer alternatives when blocking

## Session Completion

Work is NOT complete until `git push` succeeds:

```bash
git pull --rebase
bd sync
git push
git status  # MUST show "up to date with origin"
```
