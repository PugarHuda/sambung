import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ghostPlan, MAX_GHOSTS, EMOTE_URN, WEARABLES } from './ghosts.ts'
import { EMOTES } from './game.ts'
import type { Link } from './record.ts'

const link = (emote: number, user: string, name: string): Link => ({ emote, user, name })

test('one builder per person, in the order they first added a link', () => {
  const plan = ghostPlan([
    link(0, '0xa', 'Ana'),
    link(1, '0xb', 'Bo'),
    link(2, '0xa', 'Ana'),
    link(3, '0xc', 'Cy')
  ])
  assert.deepEqual(
    plan.map((g) => g.name),
    ['Ana', 'Bo', 'Cy']
  )
})

test('a crowded record fills the stage but does not overflow it', () => {
  const chain = Array.from({ length: 40 }, (_, i) => link(i % 8, `0x${i}`, `P${i}`))
  assert.equal(ghostPlan(chain).length, MAX_GHOSTS)
})

test('a single builder stands centre stage, not at the end of an arc of one', () => {
  const solo = ghostPlan([link(0, '0xa', 'Ana')])
  assert.equal(solo.length, 1)
  const only = solo[0]
  assert.ok(only)
  // Centre of the arc is straight ahead of the spawn point: x at the middle,
  // z at its furthest.
  assert.ok(Math.abs(only.x - 8) < 0.01, `expected centre stage, got x=${only.x}`)
  assert.ok(only.z > 11, `expected the far arc, got z=${only.z}`)
})

test('every builder stands on the stage, past the spawn region and inside the pillars', () => {
  const chain = Array.from({ length: MAX_GHOSTS }, (_, i) => link(0, `0x${i}`, `P${i}`))
  for (const g of ghostPlan(chain)) {
    // The player spawns in 6.5..9.5 and looks towards +z, so a ghost must stand
    // beyond that or it lands on top of the visitor.
    assert.ok(g.z > 9.5, `${g.name} stands in the spawn region at z=${g.z}`)
    // The pillars ring the stage at 5.5; a ghost outside that is off the stage.
    const fromCentre = Math.hypot(g.x - 8, g.z - 8)
    assert.ok(fromCentre < 5.5, `${g.name} stands outside the pillars at ${fromCentre}`)
  }
})

test('nobody stands in the same place as anybody else', () => {
  const chain = Array.from({ length: MAX_GHOSTS }, (_, i) => link(0, `0x${i}`, `P${i}`))
  const plan = ghostPlan(chain)
  const spots = new Set(plan.map((g) => `${g.x.toFixed(2)},${g.z.toFixed(2)}`))
  assert.equal(spots.size, plan.length)
})

test('a link with no author is not a ghost', () => {
  const plan = ghostPlan([link(0, '', 'nobody'), link(1, '0xa', 'Ana')])
  assert.deepEqual(
    plan.map((g) => g.name),
    ['Ana']
  )
})

test('an emote for an avatar is a full URN, which is what made it perform', () => {
  // The 2026-08-31 spike: the short id that triggerEmote() takes renders a
  // frozen avatar, silently. If this ever reverts to a bare id the ghosts stop
  // performing and nothing else fails, so the shape is asserted here.
  for (const emote of EMOTES) {
    const urn = EMOTE_URN + emote.id
    assert.match(urn, /^urn:decentraland:off-chain:base-emotes:[a-z]+$/)
  }
})

test('a ghost is dressed in every slot the proto leaves to a default', () => {
  // The client drew a naked body when wearables were empty, so this list is
  // load-bearing rather than decorative.
  for (const slot of ['eyes', 'eyebrows', 'mouth', 'hair', 'tshirt', 'trousers', 'shoes']) {
    assert.ok(
      WEARABLES.some((w) => w.includes(slot)),
      `nothing covers the ${slot} slot`
    )
  }
})
