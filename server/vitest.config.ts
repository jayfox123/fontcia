import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/helpers/load-test-env.ts'],
  },
});
