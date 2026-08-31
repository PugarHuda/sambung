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
// It parks one avatar in front of the spawn point and cycles two emotes every
// 3s, so "renders but frozen" is distinguishable from "renders and performs".

import { engine, Transform, AvatarShape, TextShape } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

const CYCLE = 3

export function spikeAvatar() {
  const ghost = engine.addEntity()
  Transform.create(ghost, { position: Vector3.create(8, 0.3, 12.5) })
  AvatarShape.create(ghost, {
    id: 'spike-ghost',
    name: 'GHOST',
    wearables: [],
    emotes: [],
    expressionTriggerId: 'robot',
    expressionTriggerTimestamp: 1
  })

  // A label that ticks even if the avatar never appears, so a blank result means
  // "AvatarShape did not render" rather than "the whole spike failed to load".
  const sign = engine.addEntity()
  Transform.create(sign, { position: Vector3.create(8, 2.6, 12.5) })
  TextShape.create(sign, { text: 'spike: robot', fontSize: 3 })

  let t = 0
  let n = 1
  engine.addSystem((dt: number) => {
    t += dt
    if (t < CYCLE) return
    t = 0
    n++
    const emote = n % 2 === 0 ? 'dab' : 'robot'
    const a = AvatarShape.getMutable(ghost)
    a.expressionTriggerId = emote
    a.expressionTriggerTimestamp = n
    TextShape.getMutable(sign).text = `spike: ${emote} (${n})`
  })
}
