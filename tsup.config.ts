import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'do/index': 'src/do/index.ts',
    'mcp/index': 'src/mcp/index.ts',
    'safety/index': 'src/safety/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  external: ['rpc.do', 'mcp.do'],
})
