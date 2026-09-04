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

test('a single builder stands in the middle of the wedge, not at the end of an arc of one', () => {
  const solo = ghostPlan([link(0, '0xa', 'Ana')])
  assert.equal(solo.length, 1)
  const only = solo[0]
  assert.ok(only)
  assert.ok(only.x < 8, `expected the visitor's left, got x=${only.x}`)
  assert.ok(only.z > 8, `expected the far half, got z=${only.z}`)
})

test('every builder stands clear of the visitor and inside the pillars', () => {
  const chain = Array.from({ length: MAX_GHOSTS }, (_, i) => link(0, `0x${i}`, `P${i}`))
  for (const g of ghostPlan(chain)) {
    // The visitor spawns anywhere in 6.5..9.5 on both axes. A ghost inside that
    // box lands on top of whoever just arrived.
    const inSpawn = g.x >= 6.5 && g.x <= 9.5 && g.z >= 6.5 && g.z <= 9.5
    assert.ok(!inSpawn, `${g.name} stands in the spawn region at ${g.x},${g.z}`)
    // The pillars ring the stage at 5.5; a ghost outside that is off the stage.
    const fromCentre = Math.hypot(g.x - 8, g.z - 8)
    assert.ok(fromCentre < 5.5, `${g.name} stands outside the pillars at ${fromCentre}`)
  }
})

test('nobody stands where the pad grid is drawn over them', () => {
  // Photographed 2026-09-04: the pad grid is screen-space and owns the right of
  // the view in landscape, and +x is screen right. A builder at x > 8 was 90%
  // hidden behind it. This is the regression that cost a deploy to see.
  for (let n = 1; n <= MAX_GHOSTS; n++) {
    const chain = Array.from({ length: n }, (_, i) => link(0, `0x${i}`, `P${i}`))
    for (const g of ghostPlan(chain)) {
      assert.ok(g.x < 8, `${g.name} stands under the pad grid at x=${g.x} (${n} builders)`)
    }
  }
})

test('a pair of builders stands together, not at opposite ends of the stage', () => {
  // Two is the commonest record, and stretching a group to fill the wedge put
  // those two as far apart as the stage allows - one of them out at the edge of
  // the frame. They stand a fixed distance apart now.
  const pair = ghostPlan([link(0, '0xa', 'Ana'), link(1, '0xb', 'Bo')])
  const [a, b] = pair
  assert.ok(a && b)
  const apart = Math.hypot(a.x - b.x, a.z - b.z)
  assert.ok(apart > 1.2 && apart < 2.2, `a pair stood ${apart.toFixed(2)}m apart`)
})

test('a full stage still fits inside the wedge', () => {
  // Fixed spacing has to give way once there are enough people, or the group
  // widens out of the clear side of the stage and back under the pad grid.
  const chain = Array.from({ length: MAX_GHOSTS }, (_, i) => link(0, `0x${i}`, `P${i}`))
  const plan = ghostPlan(chain)
  for (let i = 1; i < plan.length; i++) {
    const prev = plan[i - 1]
    const cur = plan[i]
    assert.ok(prev && cur)
    const apart = Math.hypot(prev.x - cur.x, prev.z - cur.z)
    // Close enough to read as a crowd, far enough not to stand inside a body.
    assert.ok(apart > 0.6, `${prev.name} and ${cur.name} overlap at ${apart.toFixed(2)}m`)
  }
})

test('a builder faces the middle of the stage, which is where the visitor is', () => {
  const chain = Array.from({ length: MAX_GHOSTS }, (_, i) => link(0, `0x${i}`, `P${i}`))
  for (const g of ghostPlan(chain)) {
    // A yaw of theta points an entity along (sin theta, cos theta) in this
    // left-handed space. Walking one metre that way must get closer to (8,8) -
    // an avatar with no rotation at all faced +z and away, which is the bug.
    const t = (g.yaw * Math.PI) / 180
    const before = Math.hypot(g.x - 8, g.z - 8)
    const after = Math.hypot(g.x + Math.sin(t) - 8, g.z + Math.cos(t) - 8)
    assert.ok(after < before, `${g.name} faces away from the stage: yaw ${g.yaw}`)
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
