import { defineConfig, devices } from '@playwright/test'

// The world key is chosen once in globalSetup, not here: this module is
// re-evaluated inside every worker, so computing it here gave each worker a
// different world and made the suite flake.

const LIVE_WORLD = '**/deployed-world.spec.ts'
const ABUSE = '**/abuse.spec.ts'
const CLIENT = '**/live-client.spec.ts'
const CAPTURE = '**/capture.spec.ts'
const BROWSERS = ['chromium', 'firefox', 'webkit', 'mobile-chrome', 'mobile-safari']

/**
 * What it takes to run the actual Decentraland client on this machine.
 *
 * Headed on purpose: the Bevy client needs WebGPU and headless-shell exposes no
 * adapter, so this cannot run on a CI runner and is not asked to. The viewport
 * is pinned because the pad coordinates the suites click are only true at
 * 1920x1200 - at that size the client's UI scale is exactly 1.0.
 */
const REAL_CLIENT = {
  ...devices['Desktop Chrome'],
  headless: false,
  viewport: { width: 1920, height: 1200 },
  launchOptions: {
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,WebGPU',
      '--ignore-gpu-blocklist',
      '--use-angle=default'
    ]
  }
}

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
    ...BROWSERS.map((name, i) => ({
      name,
      testIgnore: [LIVE_WORLD, ABUSE, CLIENT, CAPTURE],
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
    // The write-limit flood. Last, and alone: it spends the per-caller budget
    // that every other project here shares, so nothing may run beside or after
    // it within the same minute.
    {
      name: 'abuse',
      testMatch: ABUSE,
      dependencies: BROWSERS,
      use: { ...devices['Desktop Chrome'] }
    },
    // Assertions about the deployed World, which are only true after a deploy.
    // Kept out of the default run and out of CI; `npm run verify` is the caller.
    { name: 'deployed', testMatch: LIVE_WORLD, use: { ...devices['Desktop Chrome'] } },
    // The only suite that plays the game in a real client.
    {
      name: 'client',
      testMatch: CLIENT,
      timeout: 600_000,
      retries: 0,
      use: REAL_CLIENT
    },
    // The same client, recorded. Footage for the buildathon demo video, which
    // is assembled by the Remotion project next door - see e2e/capture.spec.ts.
    // Same viewport for the same reason, and the video is captured at it 1:1 so
    // a pad coordinate in marks.json is a pixel in the frame.
    {
      name: 'capture',
      testMatch: CAPTURE,
      timeout: 900_000,
      retries: 0,
      use: {
        ...REAL_CLIENT,
        video: { mode: 'on' as const, size: { width: 1920, height: 1200 } }
      }
    }
  ]
})
