import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/server.ts', 'src/tools.ts'],
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
      reporter: ['text', 'json-summary'],
    },
  },
});
