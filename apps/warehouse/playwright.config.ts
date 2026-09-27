import { defineConfig } from '@playwright/test';

// End-to-end tests drive the real app in the Chrome already installed on the machine
// (channel: 'chrome'), so no browser download is needed.
//
// They expect the API and the app to be running against the TEST database — never the real one:
// the stock ledger is append-only and an opening count cannot be repeated.
//   backend:  DATABASE_URL=<TEST_DATABASE_URL> pnpm dev
//   app:      pnpm dev            (http://localhost:5180)
//   login:    E2E_EMAIL / E2E_PASSWORD
export default defineConfig({
  testDir: 'e2e',
  // Generous: from the development network each scan is ~5 s (VPN → Frankfurt). Production is not.
  timeout: 900_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  reporter: [['list']],
  outputDir: 'e2e/results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5180',
    channel: 'chrome',
    headless: true,
    locale: 'ar-SY',
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
  },
});
