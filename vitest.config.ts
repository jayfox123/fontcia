import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    passWithNoTests: true,
    // Some test files (service-worker.test.ts, login.test.ts,
    // overlay-integration.test.ts) use vi.resetModules() + a dynamic
    // import() per test/hook to isolate module-level side effects. That
    // re-transforms and re-executes the whole module graph, which is cheap
    // in isolation but can take several seconds under full-suite CPU
    // contention — past Vitest's 5000ms/10000ms defaults. Set generously
    // here so the whole suite is covered, not just the files that have
    // hit this in practice so far.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
