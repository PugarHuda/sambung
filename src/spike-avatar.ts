// THROWAWAY SPIKE — delete this file once the question is answered.
//
// Decide by 2026-09-09, the deploy freeze for the extended 2026-09-11 deadline.
// It was removed once already against the old 08-28 cutoff and restored when the
// buildathon was extended, so the date this file lives or dies by is written here
// rather than in somebody's head.
//
// Question: does AvatarShape actually render inside a scene (not just the global
// avatar scene), and does expressionTriggerId make it perform an emote — on the
// mobile client? The whole "ghost" feature dies if the answer is no.
//
// HALF ANSWERED 2026-08-31, in the Bevy web client against the deployed World:
// it RENDERS (the doc warning that AvatarShape "is only actually used in the
// global Avatar Scene" is wrong), but it never performed. Five frames spanning
// 120s — about forty emote cycles — were an identical rigid A-pose, and the body
// came up undressed despite the proto documenting per-slot wearable defaults.
//
// So the remaining question is narrower: WHY didn't it perform? Each deploy costs
// a human wallet signature, so rather than one guess per deploy this parks four
// variants side by side and lets one photograph decide between them.
//
//   A  control — exactly what was tested on 08-31, so the photo has a baseline
//   B  timestamp = Date.now()
//   C  B, plus the emote named as a full URN
//   D  C, plus the emote also declared in `emotes`
//
// The prime suspect is the timestamp. The proto calls it "start of emote
// animations", and the old spike passed a counter (1, 2, 3…) — read as a real
// clock that is 1970, so every emote is already long finished and the client
// draws the rest pose. B alone isolates that; C and D fall back on the two other
// readings of the proto (`expressionTriggerId` wanting a URN, and `emotes`
// being an allow-list of what may play).
//
// All four wear explicit wearables, because the defaults the proto documents did
// not arrive on their own and a naked mannequin on stage is worse than no ghost.

import { engine, Transform, AvatarShape, TextShape } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

const CYCLE = 3

const BASE = 'urn:decentraland:off-chain:base-emotes:'
/** The per-slot defaults the proto documents but the web client did not apply. */
const WEARABLES = [
  'urn:decentraland:off-chain:base-avatars:f_eyes_00',
  'urn:decentraland:off-chain:base-avatars:f_eyebrows_00',
  'urn:decentraland:off-chain:base-avatars:f_mouth_00',
  'urn:decentraland:off-chain:base-avatars:standard_hair',
  'urn:decentraland:off-chain:base-avatars:f_simple_yellow_tshirt',
  'urn:decentraland:off-chain:base-avatars:f_brown_trousers',
  'urn:decentraland:off-chain:base-avatars:bun_shoes'
]

type Variant = {
  tag: string
  x: number
  /** How the emote is named in expressionTriggerId. */
  urn: boolean
  /** Whether the emote is also declared in `emotes`. */
  listed: boolean
  /** A counter, as the old spike sent, or a real clock. */
  clock: boolean
}

const VARIANTS: Variant[] = [
  { tag: 'A-control', x: 5, urn: false, listed: false, clock: false },
  { tag: 'B-clock', x: 7, urn: false, listed: false, clock: true },
  { tag: 'C-urn', x: 9, urn: true, listed: false, clock: true },
  { tag: 'D-listed', x: 11, urn: true, listed: true, clock: true }
]

export function spikeAvatar() {
  for (const v of VARIANTS) spikeOne(v)
}

function spikeOne(v: Variant) {
  const name = (emote: string) => (v.urn ? BASE + emote : emote)

  const ghost = engine.addEntity()
  Transform.create(ghost, { position: Vector3.create(v.x, 0.3, 12.5) })
  AvatarShape.create(ghost, {
    id: `spike-${v.tag}`,
    name: v.tag,
    wearables: WEARABLES,
    emotes: v.listed ? [name('robot'), name('dab')] : [],
    expressionTriggerId: name('robot'),
    expressionTriggerTimestamp: v.clock ? Date.now() : 1
  })

  // A label that ticks even if the avatar never appears, so a blank result means
  // "AvatarShape did not render" rather than "the whole spike failed to load".
  const sign = engine.addEntity()
  Transform.create(sign, { position: Vector3.create(v.x, 2.6, 12.5) })
  TextShape.create(sign, { text: v.tag, fontSize: 2 })

  let t = 0
  let n = 1
  engine.addSystem((dt: number) => {
    t += dt
    if (t < CYCLE) return
    t = 0
    n++
    const emote = n % 2 === 0 ? 'dab' : 'robot'
    const a = AvatarShape.getMutable(ghost)
    a.expressionTriggerId = name(emote)
    a.expressionTriggerTimestamp = v.clock ? Date.now() : n
    TextShape.getMutable(sign).text = `${v.tag}\n${emote} (${n})`
  })
}
