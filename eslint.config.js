import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Ignore patterns
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '**/*.d.ts',
      '**/*.test.ts',
      '**/tests/**',
      '**/test/**',
    ],
  },
  // Base recommended config for TypeScript
  ...tseslint.configs.recommended,
  // Custom rules for src/
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow explicit any for now (can tighten later)
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow unused vars with underscore prefix
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Allow namespaces for now (used in crypto module)
      '@typescript-eslint/no-namespace': 'off',
      // Use ts-expect-error instead of ts-ignore
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': 'allow-with-description' },
      ],
    },
  }
)
