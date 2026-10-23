import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one test database, wiped between tests: files must run one at a
    // time. (A root-level option in Vitest 3; the unit tests are fast enough not to mind.)
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.unit.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          // Neon is reached over the network; a test makes many round trips.
          testTimeout: 300_000,
          hookTimeout: 300_000,
          // Run from Syria a query takes ~250–450 ms, so one sale can outlast the server's 20 s
          // transaction limit here though it takes well under a second next to the database.
          env: { TX_TIMEOUT_MS: '60000' },
        },
      },
    ],
  },
});
