import { Page, TestInfo } from '@playwright/test'

// Shared between the endpoint suites. The comments on each piece explain the
// browser rules that shaped it; they were each learned the hard way.

// The deployed endpoint by default. Overridable so the same suite can be pointed
// at a preview deployment before it is aliased into production.
export const API = process.env.SAMBUNG_API ?? 'https://sambung-dcl.vercel.app/api/chain'
/**
 * The origin the test page is served from. Always a different origin than the
 * endpoint, so CORS and its preflight are enforced either way.
 *
 * Against a local endpoint it has to be loopback too. Chrome's Private Network
 * Access rules block a page on a public origin from reaching 127.0.0.1 at all,
 * and the block happens before the request, so a perfectly good local endpoint
 * reads as "Failed to fetch" on every call. A different port is still a
 * different origin, so nothing is weakened by moving there.
 */
function originFor(api: string): string {
  const url = new URL(api)
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    return 'https://sambung-e2e.test'
  // scripts/serve-endpoint.mjs serves a blank page on the next port up. It has
  // to be a real server: a page Playwright fulfils has no address of its own, so
  // Chrome treats it as public and refuses it the loopback address space.
  return `${url.protocol}//${url.hostname}:${Number(url.port) + 1}`
}

export const ORIGIN = originFor(API)

export function urlFor(testInfo: TestInfo, slug: string): string {
  const run = process.env.SAMBUNG_TEST_WORLD ?? 'pwtest'
  const world = `${run}-${testInfo.project.name}-${slug}-r${testInfo.retry}.dcl.eth`
  return `${API}?world=${world}`
}

export const LOCAL = ORIGIN.startsWith('http://127.0.0.1')

export async function onOrigin(page: Page) {
  // Against the deployed endpoint the caller page is invented, so no external
  // site is needed. Against a local one it has to be fetched for real, or the
  // browser will not grant it the loopback address space - see originFor.
  if (!LOCAL) {
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>e2e</title>' })
    )
  }
  await page.goto(`${ORIGIN}/`)
}

export type Call = { status: number; body: unknown; error?: string }

export async function call(page: Page, url: string, init?: Record<string, unknown>): Promise<Call> {
  return page.evaluate(
    async ({ u, i }) => {
      try {
        const r = await fetch(u, (i as RequestInit | null) ?? undefined)
        const text = await r.text()
        let body: unknown = text
        try {
          body = JSON.parse(text)
        } catch {
          // keep the raw text so a non-JSON body is visible in the failure message
        }
        return { status: r.status, body }
      } catch (e) {
        // A CORS rejection lands here, which is exactly what we want to catch.
        return { status: 0, body: null, error: String(e) }
      }
    },
    { u: url, i: init ?? null }
  )
}

export const link = (emote: number, name = 'Lynx', user = '0xaaa') => ({ emote, user, name })

/** Content-Type: application/json is what forces the browser to preflight. */
export const post = (payload: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
})

export const record = (body: unknown) => (body as { record: number }).record

/**
 * Reads until the store agrees, or gives up.
 *
 * The record lives in an object store whose listing index lags a write by about
 * a second, measured at roughly one read in eight. The contract this endpoint
 * offers is convergence, not instant consistency, so the test asserts exactly
 * that instead of pretending the write is immediately visible.
 */
export async function readsBack(page: Page, url: string, expected: number): Promise<unknown> {
  let last: unknown = null
  for (let attempt = 0; attempt < 8; attempt++) {
    last = await call(page, url).then((r) => r.body)
    if (record(last) === expected) return last
    await page.waitForTimeout(750)
  }
  return last
}
export const weekRecord = (body: unknown) => (body as { week?: { record: number } }).week?.record
