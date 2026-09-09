import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EMOTES, showStep } from '../src/game.ts'
import { MIN_PALETTE_SPREAD, enterAsGuest, padAt, waitForPads } from './client.ts'

// Records a real visit to the live World as footage for the demo video.
//
// Not a test of the scene - `live-client.spec.ts` is that, and this shares its
// client-driving helpers so the pad coordinates cannot drift apart. This exists
// because the buildathon submission needs a video, and the only honest way to
// show the game is to play it: no mockups, no screen recording of a hand-waved
// prototype, the deployed World in a real Decentraland client.
//
// Two things come out of it, into the Remotion project's `public/` folder:
//
//   gameplay.webm  the raw screen recording, from the login page to the last
//                  completed chain.
//   marks.json     what happened and when, in seconds from the first frame.
//                  Remotion needs this twice over: to trim away the two minutes
//                  of client boot nobody wants to watch, and to draw a tap
//                  ripple at each pad press - Playwright's recorder does not
//                  render a cursor, so without it the pads light up with no
//                  visible cause.
//
// It plays for real, which means it can move the live weekly record. That is
// fine and deliberate: a chain completed here was completed, and inventing a
// number for a video would be the dishonest version.

/** Where the Remotion project keeps its assets. Overridable; it is a sibling. */
const OUT = process.env.SAMBUNG_VIDEO_OUT ?? resolve(process.cwd(), '../sambung-video/public')

/**
 * The chain the run plays, as pad indices.
 *
 * Three links, chosen for colour and for what the avatar does: WAVE is red and
 * legible against the stage, ROBOT is the emote whose URN mismatch cost a
 * deploy to find, MONEY is the one a real visitor tapped during a photo run.
 */
const CHAIN = [0, 3, 6]

/** Seconds of the opening replay to record before touching anything. */
const WATCH_REPLAY = 16

/**
 * How long to wait for the scene to finish playing a chain of this length back.
 *
 * The scene's own arithmetic plus a margin. There is no way to read the phase
 * from outside - the UI is drawn into the WebGL canvas - so this is the one
 * place the capture trusts a clock. Tapping too early is harmless (`tap()`
 * ignores input while showing); tapping too late is also harmless. Only a tap
 * during `showing` that the scene reads as `input` could miss, and the margin
 * is what makes that impossible.
 */
const showingMs = (links: number) => links * showStep(links) * 1000 + 1800

test('record a real visit and a real game as footage', async ({ page }) => {
  const t0 = Date.now()
  const at = () => Number(((Date.now() - t0) / 1000).toFixed(2))
  const marks: { label: string; t: number }[] = []
  const taps: { t: number; x: number; y: number; label: string }[] = []
  const mark = (label: string) => {
    marks.push({ label, t: at() })
    console.log(`  ${at().toFixed(1).padStart(6)}s  ${label}`)
  }

  const tapPad = async (i: number) => {
    const p = padAt(i)
    taps.push({ t: at(), x: p.x, y: p.y, label: EMOTES[i]?.label ?? String(i) })
    await page.mouse.click(p.x, p.y)
  }

  mark('boot')
  await enterAsGuest(page)
  mark('scene-started')

  const pads = await waitForPads(page)
  expect(
    pads.best?.closest ?? 0,
    `after ${pads.seconds.toFixed(1)}s the pads were still not drawn where the layout says`
  ).toBeGreaterThan(MIN_PALETTE_SPREAD)
  mark('pads-visible')

  // The attract loop is running: the builders of the record are on the stage
  // performing it. This is the part a visitor sees before they do anything, and
  // the part the video exists to show, so it is recorded before the first tap -
  // which is also what stops it.
  await page.waitForTimeout(WATCH_REPLAY * 1000)
  mark('replay-watched')

  for (let len = 1; len <= CHAIN.length; len++) {
    // Add a link. In `choosing` the scene takes any pad and plays the whole
    // chain back, this new link last.
    await tapPad(CHAIN[len - 1] as number)
    mark(`add-link-${len}`)
    await page.waitForTimeout(showingMs(len))

    // Repeat it from the start, which is the game.
    mark(`repeat-${len}`)
    for (const i of CHAIN.slice(0, len)) {
      await tapPad(i)
      await page.waitForTimeout(600)
    }
    mark(`chain-of-${len}`)
    await page.waitForTimeout(1800)
  }

  await page.waitForTimeout(2500)
  mark('end')

  mkdirSync(OUT, { recursive: true })
  const video = page.video()
  expect(video, 'the capture project must be run with video recording on').toBeTruthy()
  // saveAs waits for the page to close, which is what flushes the recording.
  await page.close()
  await video?.saveAs(resolve(OUT, 'gameplay.webm'))

  writeFileSync(
    resolve(OUT, 'marks.json'),
    JSON.stringify(
      {
        world: 'rainbowroad.dcl.eth',
        recordedAt: new Date(t0).toISOString(),
        width: 1920,
        height: 1200,
        padsVisibleSeconds: Number(pads.seconds.toFixed(1)),
        paletteSpread: Number((pads.best?.closest ?? 0).toFixed(1)),
        chain: CHAIN.map((i) => EMOTES[i]?.label ?? String(i)),
        marks,
        taps
      },
      null,
      2
    )
  )
  console.log(`\nfootage and marks written to ${OUT}`)
})
