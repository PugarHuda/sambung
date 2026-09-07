import { test, expect, APIRequestContext, Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { EMOTES } from '../src/game.ts'

// Plays the deployed World in a real Decentraland client.
//
// Everything else in this repo stops short of the thing being judged. The unit
// tests exercise modules, `bundle.test.ts` reads the CRDT stream the scene
// sends, and `deployed-world.spec.ts` checks the bytes on the content server -
// but not one of them can say whether a person can walk in and play. Three
// separate defects this month lived exactly in that gap: builders facing away
// from the visitor, a pad grid drawn at a fifth of its size, and the record
// replay finishing behind the client's loading curtain. Every one was found by
// a human looking at a photograph, and none of them would have failed a test.
//
// So this drives the Bevy web client against the live World and proves the
// whole chain end to end: browser -> client -> our bundle -> the scene's own
// fetch -> our endpoint. The proof is the beacon. The scene reports `arrive`
// when it starts and `first_tap` when a pad is first pressed, so if a beacon we
// did not already have shows up at /api/note, every link in that chain worked.
//
// The layout is pinned separately, by reading pixels. The scene's UI is drawn
// INTO the WebGL canvas, so there is no DOM element to click or assert on - the
// click is a raw canvas coordinate. A click that misses the grid does NOT fail
// quietly: it falls through to the 3D world and lands on whichever pillar is
// behind it, and the pillars are tappable, so the beacon would still arrive.
// That is why the eight pad colours are sampled at the exact coordinates the
// click will use, before the click happens.
//
// Not in CI and not in the default run: it needs a real GPU (WebGPU has no
// software fallback, so the browser must be headed) and takes minutes. It also
// writes real `arrive`/`first_tap` beacons to the live world, which is the
// point - they are diagnostic and capped, and proving the pipeline in
// production is worth a few rows. It never completes a chain, so it cannot
// touch the record.

const WORLD = 'rainbowroad.dcl.eth'
const CLIENT = `https://decentraland.org/bevy-web/?realm=${WORLD}`
const NOTE = (process.env.SAMBUNG_API ?? 'https://sambung-dcl.vercel.app/api/chain')
  .replace(/\/api\/chain$/, '/api/note')
  .concat(`?world=${WORLD}`)

/**
 * Pad centres at 1920x1200, measured on the running client on 2026-08-31 and
 * used to play a real two-player round on 09-02.
 *
 * At this viewport the client's UI scale is exactly 1.0 - it lays scene UI out
 * in a fixed 1920x1200 point space - so a point the scene asks for is a pixel
 * on screen. That is only true here, which is why the viewport is pinned.
 * Landscape puts the grid on the right as a 2x4 block.
 */
const COL = [1302, 1610]
const ROW = [232, 478, 722, 968]
const padAt = (i: number) => ({ x: COL[i % 2] as number, y: ROW[Math.floor(i / 2)] as number })

/**
 * Vertical offset from a pad's centre to somewhere solid inside it.
 *
 * The centre itself is where the pad's own white label is drawn, so sampling
 * there reads the text and not the pad: measured on real frames, four of the
 * eight came back near-white and the palette collapsed to a minimum pairwise
 * distance of 3.7. Seventy pixels up clears the glyphs and is still well inside
 * a pad about 213 tall.
 */
const PAD_SAMPLE_DY = -70
/**
 * How far apart the eight sampled colours must stay.
 *
 * Measured at 16.3 across three frames and four offsets - that is the closest
 * pair in the palette once the client has blended it at the unlit 0.45. The bar
 * is set at half of it: comfortably below what a working grid produces, and far
 * above what a broken one does. If the grid vanished, collapsed to a sliver or
 * moved off its coordinates, all eight samples would read the same background
 * and this would fall to nearly zero - which is exactly the shape of the two
 * layout defects this project has actually shipped.
 */
const MIN_PALETTE_SPREAD = 8
/**
 * How long the pads may take to appear after the sandbox starts.
 *
 * Generous, because it covers the client's own loading curtain and not our
 * scene. It is a ceiling on "can this be played at all", not a performance
 * target - measured runs reach the stage well inside it.
 */
const PADS_VISIBLE_BUDGET_MS = 120_000

/** pngjs arrives with Playwright. If that ever stops, this import fails loudly. */
function sampler(shot: Buffer): (x: number, y: number) => [number, number, number] {
  const png = PNG.sync.read(shot)
  return (x, y) => {
    // Bounds are checked because the flat pixel array does not check them for
    // us: an x left of the clip produces a negative offset that quietly wraps
    // onto the previous row and returns a real, wrong colour. Verified - moving
    // the pad columns 260px off still read a healthy spread of 16.3 from pixels
    // that were nowhere near a pad. A sample outside the frame is a broken
    // test, not a failing one, and it should say so.
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
      throw new Error(
        `sampled ${x},${y}, which is outside the ${png.width}x${png.height} frame - ` +
          'the pad coordinates and the clip have drifted apart'
      )
    }
    const i = (png.width * y + x) << 2
    return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0]
  }
}

const distance = (a: number[], b: number[]) =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0))

/** Just the pad grid, so a poll every couple of seconds stays cheap. */
const GRID = { x: 1160, y: 120, width: 600, height: 960 }

/** The closest pair among the eight pad samples in one frame of the grid. */
function paletteSpread(shot: Buffer): { closest: number; pair: string } {
  const pixel = sampler(shot)
  const pads = EMOTES.map((_, i) => {
    const at = padAt(i)
    return pixel(at.x - GRID.x, at.y + PAD_SAMPLE_DY - GRID.y)
  })
  let closest = Infinity
  let pair = ''
  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      const d = distance(pads[i] as number[], pads[j] as number[])
      if (d < closest) {
        closest = d
        pair = `${EMOTES[i]?.label ?? i} and ${EMOTES[j]?.label ?? j}`
      }
    }
  }
  return { closest, pair }
}

type Note = { at: string; kind: string; platform: string; detail?: string }

async function notes(request: APIRequestContext): Promise<Note[]> {
  const res = await request.get(NOTE)
  expect(res.status(), 'the beacon endpoint must answer before it can be believed').toBe(200)
  return ((await res.json()) as { notes: Note[] }).notes
}

/**
 * Waits for a beacon of this kind that is newer than everything we saw before.
 *
 * Compared by timestamp rather than by counting: the world is public, so a real
 * visitor arriving mid-run would move the count without meaning our client did
 * anything.
 */
async function beaconAfter(
  request: APIRequestContext,
  kind: string,
  since: string,
  budgetMs: number
): Promise<Note> {
  const deadline = Date.now() + budgetMs
  let seen: Note[] = []
  while (Date.now() < deadline) {
    seen = await notes(request)
    const fresh = seen.find((n) => n.kind === kind && n.at > since)
    if (fresh) return fresh
    await new Promise((r) => setTimeout(r, 2000))
  }
  const recent = seen
    .slice(0, 5)
    .map((n) => `${n.at} ${n.kind}`)
    .join(' | ')
  throw new Error(`no "${kind}" beacon arrived after ${since}. Newest were: ${recent || 'none'}`)
}

/** The scene is running when its sandbox says so; a clock cannot know. */
async function enterAsGuest(page: Page): Promise<void> {
  let up = false
  page.on('console', (m) => {
    if (m.text().includes('starting scene sandbox')) up = true
  })
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' })
  const guest = page.getByText(/EXPLORE AS GUEST/i)
  await guest.waitFor({ timeout: 180_000 })
  await guest.click()
  // The engine downloads, WASM compiles, comms connect, then the scene starts.
  const deadline = Date.now() + 240_000
  while (!up && Date.now() < deadline) await page.waitForTimeout(500)
  expect(up, 'the client never started the scene sandbox').toBe(true)
}

test('a visitor can load the World in a real client and press a pad', async ({
  page,
  request
}, testInfo) => {
  // Everything already at the endpoint, so nothing below can pass on old rows.
  const before = await notes(request)
  const since = before[0]?.at ?? '1970-01-01T00:00:00.000Z'

  await test.step('the client loads the deployed World and the scene starts', async () => {
    await enterAsGuest(page)
  })

  await test.step('the scene reports its arrival to our endpoint', async () => {
    // Proves the bundle ran, the scene resolved its realm, and its own fetch
    // reached us - the three things a black screen would hide.
    const arrived = await beaconAfter(request, 'arrive', since, 90_000)
    expect(arrived.platform, 'the client should report itself as a platform').toBeTruthy()
  })

  await test.step('the pads become visible to the player, and in their own colours', async () => {
    // Deliberately a poll, not a single frame. The client holds an "Entering
    // Decentraland" curtain up for tens of seconds AFTER the scene sandbox has
    // started - the first version of this step photographed the curtain and
    // read a spread of 2.4, which is the test catching its own naivety. What a
    // visitor cares about is when the pads appear, so that is what is measured.
    //
    // This is also the assertion the tap below cannot make. A click that misses
    // the grid does not fail quietly: it falls through to the 3D world onto
    // whichever pillar is behind it, and the pillars are tappable, so a beacon
    // would still arrive and a misplaced grid would still look like a pass.
    const deadline = Date.now() + PADS_VISIBLE_BUDGET_MS
    const began = Date.now()
    let best: { closest: number; pair: string } | null = null
    let shot: Buffer = Buffer.alloc(0)
    while (Date.now() < deadline) {
      shot = await page.screenshot({ clip: GRID })
      const seen = paletteSpread(shot)
      if (!best || seen.closest > best.closest) best = seen
      if (seen.closest > MIN_PALETTE_SPREAD) break
      await page.waitForTimeout(2000)
    }
    await testInfo.attach('pads.png', { body: shot, contentType: 'image/png' })
    const took = ((Date.now() - began) / 1000).toFixed(1)
    expect(
      best?.closest ?? 0,
      `after ${took}s the pads were still not drawn where the layout says: ` +
        `${best?.pair ?? 'no two pads'} sampled the same colour`
    ).toBeGreaterThan(MIN_PALETTE_SPREAD)
    console.log(
      `pads visible ${took}s after the scene started, spread ${(best?.closest ?? 0).toFixed(1)}`
    )
  })

  await test.step('a tap on a pad reaches the scene', async () => {
    // The opening replay owns the pillars; a tap during it is a skip, not a
    // play. Either way the scene records the tap, which is what is asserted.
    const pad = padAt(0)
    await page.mouse.click(pad.x, pad.y)
    await testInfo.attach('after-tap.png', {
      body: await page.screenshot(),
      contentType: 'image/png'
    })
    const tapped = await beaconAfter(request, 'first_tap', since, 60_000)
    expect(
      tapped.kind,
      `clicking ${EMOTES[0]?.label ?? 'the first pad'} at ${pad.x},${pad.y} never reached the scene`
    ).toBe('first_tap')
  })
})
