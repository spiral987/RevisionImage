import { defineConfig } from 'vitest/config';

// テストは engine/backend/session（純TS）のみを対象とするため、React プラグインは不要。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
