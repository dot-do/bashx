import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: [
      // Node.js-specific tests that use child_process, fs, os
      'tests/safety-gate.test.ts',
      'tests/mcp/bash-tool.test.ts',
      'tests/sdk-client.test.ts',
      'tests/tree-sitter-integration.test.ts',
      'tests/undo-tracking.test.ts',
      // POSIX compliance tests - run against real shell
      'tests/posix/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist'],
  },
})
