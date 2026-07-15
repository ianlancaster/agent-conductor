import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**', 'src/index.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 80,
        branches: 78,
        functions: 70,
        lines: 80,
      },
    },
  },
});
