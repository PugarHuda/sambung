import { expect, APIRequestContext, Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { EMOTES } from '../src/game.ts'

// Driving a real Decentraland client against the deployed World.
//
// Shared by the two suites that need a running client: `live-client.spec.ts`,
// which asserts a visitor can load the World and press a pad, and
// `capture.spec.ts`, which records the same visit as footage for the demo
// video. Every number here was measured on the running client, and the comments
// say which - they are the expensive part, and duplicating them into a second
// file is how one copy silently goes stale.

export const WORLD = 'rainbowroad.dcl.eth'
export const CLIENT = `https://decentraland.org/bevy-web/?realm=${WORLD}`
export const NOTE = (process.env.SAMBUNG_API ?? 'https://sambung-dcl.vercel.app/api/chain')
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
export const padAt = (i: number) => ({
  x: COL[i % 2] as number,
  y: ROW[Math.floor(i / 2)] as number
})

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
export const MIN_PALETTE_SPREAD = 8
/**
 * How long the pads may take to appear after the sandbox starts.
 *
 * Generous, because it covers the client's own loading curtain and not our
 * scene. It is a ceiling on "can this be played at all", not a performance
 * target - measured runs reach the stage well inside it.
 */
export const PADS_VISIBLE_BUDGET_MS = 120_000

/** Just the pad grid, so a poll every couple of seconds stays cheap. */
export const GRID = { x: 1160, y: 120, width: 600, height: 960 }

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

/** The closest pair among the eight pad samples in one frame of the grid. */
export function paletteSpread(shot: Buffer): { closest: number; pair: string } {
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

export type Note = { at: string; kind: string; platform: string; detail?: string }

export async function notes(request: APIRequestContext): Promise<Note[]> {
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
export async function beaconAfter(
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
export async function enterAsGuest(page: Page): Promise<void> {
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

/**
 * Waits until the eight pads are drawn where the layout says they are.
 *
 * Deliberately a poll, not a single frame. The client holds an "Entering
 * Decentraland" curtain up for tens of seconds AFTER the scene sandbox has
 * started - the first version of this photographed the curtain and read a
 * spread of 2.4, which is the check catching its own naivety. What a visitor
 * cares about is when the pads appear, so that is what is measured.
 */
export async function waitForPads(
  page: Page,
  budgetMs = PADS_VISIBLE_BUDGET_MS
): Promise<{ seconds: number; best: { closest: number; pair: string } | null; shot: Buffer }> {
  const deadline = Date.now() + budgetMs
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
  return { seconds: (Date.now() - began) / 1000, best, shot }
}
