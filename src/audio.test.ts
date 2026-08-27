import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMOTES } from './game.ts'
import { CLIP, PAD_PITCH, MISS_PITCH, ratio } from './audio.ts'

test('every pad has a voice', () => {
  assert.equal(PAD_PITCH.length, EMOTES.length)
})

test('the pads rise, and none of them collide', () => {
  for (let i = 1; i < PAD_PITCH.length; i++) {
    const step = (PAD_PITCH[i] as number) / (PAD_PITCH[i - 1] as number)
    assert.ok(PAD_PITCH[i]! > PAD_PITCH[i - 1]!, `pad ${i} is not above pad ${i - 1}`)
    // A whole tone is the smallest gap the tuning uses. Anything tighter and two
    // pads would be hard to tell apart by ear, which is the point of the pitches.
    assert.ok(step >= ratio(2) - 1e-9, `pads ${i - 1} and ${i} are less than a tone apart`)
  }
})

test('the whole range stays inside what a pitch shift can hold', () => {
  // Far outside this and the clip either rumbles or turns into a chirp: playback
  // rate is the only thing changing, so the timbre stretches with it.
  for (const p of PAD_PITCH) assert.ok(p >= 0.25 && p <= 4, `pitch ${p} is out of range`)
  assert.ok(MISS_PITCH < (PAD_PITCH[0] as number), 'a miss must sit below every pad')
  assert.ok(MISS_PITCH >= 0.25, 'a miss below quarter speed is a rumble, not a sound')
})

test('the clip path is the one the deploy ships', () => {
  // The budget guard checks this file exists; this checks the scene asks for the
  // folder the guard watches.
  assert.match(CLIP, /^sounds\/[\w.-]+\.wav$/)
})
