import { defineConfig, devices } from '@playwright/test'

// The world key is chosen once in globalSetup, not here: this module is
// re-evaluated inside every worker, so computing it here gave each worker a
// different world and made the suite flake.

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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 14'] } }
  ]
})
