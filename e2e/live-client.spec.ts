import { test, expect } from '@playwright/test'
import { EMOTES } from '../src/game.ts'
import {
  MIN_PALETTE_SPREAD,
  beaconAfter,
  enterAsGuest,
  notes,
  padAt,
  waitForPads
} from './client.ts'

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
//
// The client-driving parts live in `client.ts`, shared with `capture.spec.ts`.

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
    // This is also the assertion the tap below cannot make. A click that misses
    // the grid does not fail quietly: it falls through to the 3D world onto
    // whichever pillar is behind it, and the pillars are tappable, so a beacon
    // would still arrive and a misplaced grid would still look like a pass.
    const { seconds, best, shot } = await waitForPads(page)
    await testInfo.attach('pads.png', { body: shot, contentType: 'image/png' })
    const took = seconds.toFixed(1)
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
