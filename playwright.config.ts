import { defineConfig, devices } from '@playwright/test'

// The world key is chosen once in globalSetup, not here: this module is
// re-evaluated inside every worker, so computing it here gave each worker a
// different world and made the suite flake.

const LIVE_WORLD = '**/deployed-world.spec.ts'

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // Each test now owns its own world key, so nothing is shared and order is free.
  fullyParallel: true,
  // This suite talks to a live serverless function, so a cold start can take tens
  // of seconds. The generous timeout and retries buy tolerance for that latency
  // without weakening a single assertion.
  timeout: 90_000,
  retries: 2,
  reporter: [['list']],
  use: { trace: 'off' },
  projects: [
    // The endpoint suites run in every engine on purpose: CORS, preflight and
    // fetch semantics differ between them, and the scene's own fetch is closest
    // to none of them - so the widest net is the honest one.
    ...['chromium', 'firefox', 'webkit', 'mobile-chrome', 'mobile-safari'].map((name, i) => ({
      name,
      testIgnore: LIVE_WORLD,
      use: {
        ...[
          devices['Desktop Chrome'],
          devices['Desktop Firefox'],
          devices['Desktop Safari'],
          devices['Pixel 7'],
          devices['iPhone 14']
        ][i]
      }
    })),
    // Assertions about the deployed World, which are only true after a deploy.
    // Kept out of the default run and out of CI; `npm run verify` is the caller.
    { name: 'deployed', testMatch: LIVE_WORLD, use: { ...devices['Desktop Chrome'] } }
  ]
})
