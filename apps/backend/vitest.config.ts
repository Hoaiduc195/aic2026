import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts',
        'src/app.module.ts',
        'src/database/migrate.ts',
        'src/database/database.client.ts',
        'src/database/postgres.database.ts',
        'src/storage/r2-object-storage.ts',
        'src/common/tokens.ts',
        'src/common/types.ts',
      ],
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
      reporter: ['text', 'json-summary'],
    },
  },
});
