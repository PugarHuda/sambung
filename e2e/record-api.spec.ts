import { test, expect, Page, TestInfo } from '@playwright/test'

// These run inside a real browser page, so CORS and its preflight are enforced by
// the browser rather than assumed - curl can test neither. The page is served from
// an intercepted origin so no external site is needed, but the endpoint calls are
// real: this suite talks to the deployed function and writes to the real store.
//
// The store only accepts records that beat the stored one, so state is monotonic
// and a retry can never repeat itself on the same key. Every test therefore gets
// its own world, keyed by project AND retry attempt, and the one test that needs
// an ordered history performs that whole history itself rather than leaning on
// its neighbours.

// The deployed endpoint by default. Overridable so the same suite can be pointed
// at a preview deployment before it is aliased into production.
const API = process.env.SAMBUNG_API ?? 'https://sambung-dcl.vercel.app/api/chain'
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

const ORIGIN = originFor(API)

function urlFor(testInfo: TestInfo, slug: string): string {
  const run = process.env.SAMBUNG_TEST_WORLD ?? 'pwtest'
  const world = `${run}-${testInfo.project.name}-${slug}-r${testInfo.retry}.dcl.eth`
  return `${API}?world=${world}`
}

const LOCAL = ORIGIN.startsWith('http://127.0.0.1')

async function onOrigin(page: Page) {
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

type Call = { status: number; body: unknown; error?: string }

async function call(page: Page, url: string, init?: Record<string, unknown>): Promise<Call> {
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

const link = (emote: number, name = 'Lynx', user = '0xaaa') => ({ emote, user, name })

/** Content-Type: application/json is what forces the browser to preflight. */
const post = (payload: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
})

const record = (body: unknown) => (body as { record: number }).record

/**
 * Reads until the store agrees, or gives up.
 *
 * The record lives in an object store whose listing index lags a write by about
 * a second, measured at roughly one read in eight. The contract this endpoint
 * offers is convergence, not instant consistency, so the test asserts exactly
 * that instead of pretending the write is immediately visible.
 */
async function readsBack(page: Page, url: string, expected: number): Promise<unknown> {
  let last: unknown = null
  for (let attempt = 0; attempt < 8; attempt++) {
    last = await call(page, url).then((r) => r.body)
    if (record(last) === expected) return last
    await page.waitForTimeout(750)
  }
  return last
}
const weekRecord = (body: unknown) => (body as { week?: { record: number } }).week?.record

test.describe('record endpoint', () => {
  test('an unknown world reads as empty rather than erroring', async ({ page }, testInfo) => {
    await onOrigin(page)
    const r = await call(page, urlFor(testInfo, 'empty'))
    expect(r.error, 'a CORS rejection would surface as an error here').toBeUndefined()
    expect(r.status).toBe(200)
    expect(record(r.body)).toBe(0)
    expect(weekRecord(r.body), 'a fresh world reports an empty week too').toBe(0)
  })

  test('the full record lifecycle holds in order', async ({ page }, testInfo) => {
    await onOrigin(page)
    const url = urlFor(testInfo, 'lifecycle')
    const chain = [link(0), link(4, 'Tox', '0xbbb'), link(7)]

    // Written, and counted as both the all-time and this week's best.
    const first = await call(page, url, post({ record: 3, chain })).then((r) => r.body)
    expect(record(first)).toBe(3)
    expect((first as { chain: unknown }).chain).toEqual(chain)
    expect(weekRecord(first), 'a new record also takes the weekly slot').toBe(3)

    const readBack = await readsBack(page, url, 3)
    expect(record(readBack), 'the record must survive the round trip').toBe(3)
    expect(weekRecord(readBack)).toBe(3)

    // Double submit is a no-op, not a duplicate or a growth.
    const twice = await call(page, url, post({ record: 3, chain })).then((r) => r.body)
    expect(record(twice), 'a double submit must change nothing').toBe(3)
    expect(weekRecord(twice)).toBe(3)

    // A shorter record cannot displace a longer one.
    const lower = await call(page, url, post({ record: 1, chain: [link(2, 'Vandal', '0xzzz')] }))
    expect(lower.status).toBe(200)
    expect(record(lower.body), 'the standing record must win').toBe(3)

    // A genuine improvement is accepted, and lifts both records together.
    const better = [...chain, link(5, 'Ayu')]
    const improved = await call(page, url, post({ record: 4, chain: better })).then((r) => r.body)
    expect(record(improved)).toBe(4)
    expect(weekRecord(improved)).toBe(4)

    // And the improvement is what survives.
    const final = await readsBack(page, url, 4)
    expect(record(final), 'the beaten record must not come back').toBe(4)
    expect(weekRecord(final)).toBe(4)
  })

  test('malformed payloads are rejected, never coerced', async ({ page }, testInfo) => {
    await onOrigin(page)
    const url = urlFor(testInfo, 'malformed')
    const cases: Array<[string, unknown]> = [
      ['emote above the pad range', { record: 4, chain: [link(0), link(1), link(2), link(99)] }],
      ['negative emote', { record: 4, chain: [link(0), link(1), link(2), link(-1)] }],
      ['fractional emote', { record: 4, chain: [link(0), link(1), link(2), link(1.5)] }],
      ['record disagrees with chain length', { record: 999, chain: [link(0)] }],
      ['chain is not an array', { record: 0, chain: 'nope' }],
      ['missing chain', { record: 1 }],
      ['empty object', {}],
      ['null', null]
    ]
    for (const [label, payload] of cases) {
      const r = await call(page, url, post(payload))
      expect(r.status, `${label} must be refused`).toBe(400)
      expect((r.body as { error: string }).error).toBe('malformed snapshot')
    }
    // Nothing rejected may have leaked into the store.
    const after = await call(page, url).then((r) => r.body)
    expect(record(after), 'a refused write must leave the world untouched').toBe(0)
    expect(weekRecord(after)).toBe(0)
  })

  test('a non-JSON body is refused without crashing the function', async ({ page }, testInfo) => {
    await onOrigin(page)
    const r = await call(page, urlFor(testInfo, 'nonjson'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all'
    })
    expect(r.status).toBe(400)
  })

  test('an unsupported method cannot succeed from a browser', async ({ page }, testInfo) => {
    await onOrigin(page)
    const r = await call(page, urlFor(testInfo, 'method'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
    // Engines differ here on purpose. Access-Control-Allow-Methods lists only GET,
    // POST and OPTIONS, so Firefox and WebKit refuse PUT at the preflight and the
    // fetch throws (status 0), while Chromium lets it reach the function and reads
    // the 405. Pinning either number would encode a browser quirk; the invariant
    // that matters is that PUT never works.
    expect(r.status, 'PUT must not be accepted by the browser or the endpoint').not.toBe(200)
  })

  test('unicode names survive and oversized ones are clamped, not rejected', async ({
    page
  }, testInfo) => {
    await onOrigin(page)
    const url = urlFor(testInfo, 'unicode')
    const long = 'A'.repeat(200)
    const chain = [
      link(0, 'Ayu \u{1F319} まりあ'),
      link(1, long),
      link(2),
      link(3),
      link(4),
      link(5),
      link(6),
      link(7)
    ]
    const r = await call(page, url, post({ record: 8, chain }))
    expect(r.status).toBe(200)
    const stored = r.body as { chain: Array<{ name: string }> }
    expect(stored.chain[0].name, 'multi-byte names must not be mangled').toBe(
      'Ayu \u{1F319} まりあ'
    )
    expect(stored.chain[1].name.length, 'a long name is clamped to the cap').toBe(40)

    // The clamp must persist, not just appear in the write response.
    const read = (await call(page, url).then((r2) => r2.body)) as {
      chain: Array<{ name: string }>
    }
    expect(read.chain[0].name).toBe('Ayu \u{1F319} まりあ')
    expect(read.chain[1].name.length).toBe(40)
  })
})

test.describe('the record under pressure', () => {
  test('simultaneous winners cannot erase each other', async ({ page }, testInfo) => {
    await onOrigin(page)
    const url = urlFor(testInfo, 'concurrent')

    // Six players finish at the same moment. Each one read an empty world, so
    // each believes it set the record, and all six writes land together. This is
    // not hypothetical: it was measured as a lost update on 3 of 6 rounds - a
    // record of 9 erased by a slower 3 - before reads started reconciling by
    // maximum instead of by recency.
    // Longest first, on purpose. Fired in ascending order the last write is also
    // the best one, and a store that simply keeps the most recent version would
    // pass by luck - it did, when this test was first written that way.
    const lengths = [6, 5, 4, 3, 2, 1]
    const results = await page.evaluate(
      async ({ u, ls }) => {
        const body = (n: number) => ({
          record: n,
          chain: Array.from({ length: n }, (_, i) => ({
            emote: i % 8,
            user: `0x${n}`,
            name: `Player${n}`
          }))
        })
        const calls = ls.map((n) =>
          fetch(u, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body(n))
          }).then((r) => r.status)
        )
        return Promise.all(calls)
      },
      { u: url, ls: lengths }
    )
    expect(
      results.every((s) => s === 200),
      `statuses: ${results.join(',')}`
    ).toBe(true)

    const best = Math.max(...lengths)
    const after = await readsBack(page, url, best)
    expect(record(after), 'the longest simultaneous run must survive all the others').toBe(best)
    expect(weekRecord(after)).toBe(best)
    // And the chain stored must be the winner's, not a shorter one's.
    expect((after as { chain: unknown[] }).chain.length).toBe(best)
  })

  test('a body past the cap is refused without taking the function down', async ({
    page
  }, testInfo) => {
    await onOrigin(page)
    const url = urlFor(testInfo, 'huge')
    const huge = await call(page, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Valid shape, absurd size: the cap has to bite before the JSON parser does.
      body: JSON.stringify({ record: 1, chain: [link(0)], padding: 'x'.repeat(80_000) })
    })
    expect(huge.status, 'an oversized body must not be stored').not.toBe(200)

    // The function must still be there for the next player.
    const after = await call(page, url)
    expect(after.status).toBe(200)
    expect(record(after.body), 'a refused write must leave the world untouched').toBe(0)
  })
})
