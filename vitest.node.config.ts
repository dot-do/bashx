import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    watch: false,
    testTimeout: 10000,
    hookTimeout: 10000,
    teardownTimeout: 5000,
    passWithNoTests: true,
    // Run tests in single thread to avoid process cleanup issues
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
        isolate: false,
      },
    },
    include: [
      // Node.js-specific tests that use child_process, fs, os
      'tests/safety-gate.test.ts',
      'tests/mcp/bash-tool.test.ts',
      'tests/sdk-client.test.ts',
      'tests/tree-sitter-integration.test.ts',
      'tests/undo-tracking.test.ts',
      // POSIX compliance tests - run against real shell
      'tests/posix/**/*.test.ts',
      // HTTP transport and auth tests (uses msw)
      'src/remote/**/*.test.ts',
      // NPM registry client tests
      'src/npmx/**/*.test.ts',
      // Core package architecture tests
      'test/core/**/*.test.ts',
      // RPC integration tests (uses Node.js child_process)
      'test/rpc/**/*.test.ts',
      'tests/rpc/**/*.test.ts',
      // Storage patterns tests (pure unit tests)
      'src/storage/**/*.test.ts',
      // CLI client tests (uses mock WebSocket)
      'cli/**/*.test.ts',
      // Web terminal client tests (uses mock xterm.js and WebSocket)
      'web/**/*.test.ts',
      // Type import tests (RED phase TDD tests)
      'tests/types/**/*.test.ts',
      // DO utility tests that don't need Workers runtime
      'tests/do/terminal-renderer.test.ts',
      // MCP stateful shell tests (uses Node.js process.cwd, child_process)
      'src/mcp/stateful-shell.test.ts',
    ],
    exclude: ['node_modules', 'dist'],
  },
})
