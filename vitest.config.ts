import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'coverage/**',
        'dist/**',
        'demo-agent/**',
        'example/**',
        'node_modules/**',
        'test/**',
        'vitest.config.ts',
        'eslint.config.mjs',
      ],
    },
  },
});
