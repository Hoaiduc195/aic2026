import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/components/**/*.tsx', 'src/lib/api.ts'],
      thresholds: { branches: 80, functions: 80, lines: 80, statements: 80 },
    },
  },
});
