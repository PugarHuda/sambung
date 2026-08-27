import { test, expect } from '@playwright/test'
import { LOCAL, urlFor, onOrigin, call } from './helpers.ts'

// Runs in its own project, after every browser project has finished. The write
// limit is per caller and every project here calls from the same address, so a
// flood fired while another engine is mid-suite would refuse that engine's
// honest writes and look like a bug in the endpoint.

test.describe('the record under abuse', () => {
  test('a caller that writes like a loop is cut off, and the world is unharmed', async ({
    page
  }, testInfo) => {
    // Only meaningful against a single function instance, which a local run is
    // and a deployment usually is; against the CDN-fronted deployment the limit
    // still applies, it just cannot be provoked deterministically from here.
    test.skip(!LOCAL, 'needs one instance to count against')
    await onOrigin(page)
    const url = urlFor(testInfo, 'flood')
    const statuses = await page.evaluate(
      async ({ u, n }) => {
        const out: number[] = []
        for (let i = 0; i < n; i++) {
          // A shorter record every time, so nothing here can ever be stored and
          // the store pays only for the reads the limit lets through.
          const r = await fetch(u, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ record: 0, chain: [] })
          })
          out.push(r.status)
        }
        return out
      },
      { u: url, n: 320 }
    )
    // The browser projects that ran just before this share the caller budget,
    // so how many honest writes are left is not knowable here. The shape is:
    // some number of 200s, then 429 for good - never a refusal in the middle
    // of an honest burst, never a write that slips through after the cutoff.
    const cutoff = statuses.indexOf(429)
    expect(cutoff, 'the limit never engaged').toBeGreaterThan(0)
    expect(
      statuses.slice(0, cutoff).every((s) => s === 200),
      'refused mid-burst'
    ).toBe(true)
    expect(
      statuses.slice(cutoff).every((s) => s === 429),
      'a write slipped past the cutoff'
    ).toBe(true)
    // Reads are never rate limited: a judge arriving during a flood still sees
    // the record.
    const read = await call(page, url)
    expect(read.status).toBe(200)
  })
})
