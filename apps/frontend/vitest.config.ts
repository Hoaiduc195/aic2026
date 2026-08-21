import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
      'server-only': new URL('./tests/server-only.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['./tests/**/*.test.{ts,tsx}'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**/*.ts', 'src/components/**/*.tsx'],
      exclude: ['src/lib/mock-data.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
