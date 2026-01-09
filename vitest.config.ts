import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts', 'src/db/tests/**/*.test.ts'],
    exclude: [
      'node_modules',
      'dist',
      // Node.js-specific tests that use child_process, fs, os
      'tests/safety-gate.test.ts',
      'tests/mcp/bash-tool.test.ts',
      'tests/sdk-client.test.ts',
      'tests/tree-sitter-integration.test.ts',
      'tests/undo-tracking.test.ts',
    ],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
})
