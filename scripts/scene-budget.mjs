#!/usr/bin/env node
// Guards the claim that Sambung is cheap enough for a mid-range phone.
//
// The Performance criterion is the one this scene wins on, and it wins because
// the whole thing is primitives: no GLTF, no textures, no materials beyond solid
// colour. That is easy to lose by accident - one imported model and the claim is
// gone - so this asserts it from the source on every push.
//
// Triangle counts per primitive are the standard tessellations used for
// budgeting and are reported as an estimate. The authority on the real number is
// the client's own metrics panel, which needs the Explorer to read.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { EMOTES } from '../src/game.ts'

const SRC = 'src'

/** Rendered-primitive ceiling. Well above what the game needs, far below trouble. */
const MAX_RENDERED = 40

/** Estimated triangles per primitive, for budgeting only. */
const TRIANGLES = { setBox: 12, setPlane: 2, setSphere: 512, setCylinder: 96 }

/** Mobile's hard limit. Loading is refused above this. */
const HARD_LIMIT = 1_200_000

/**
 * How many of each primitive the scene actually renders.
 *
 * Counting call sites would undercount badly: the eight pillars are a single
 * `MeshRenderer.setBox` inside `EMOTES.map`, so one line renders eight boxes.
 * The pillar count is read from the very array the scene builds from, so it
 * cannot drift away from the scene.
 */
const RENDERED = { setCylinder: 1, setBox: EMOTES.length }

const files = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  .filter((f) => !f.endsWith('.test.ts'))

const source = files.map((f) => `// ${f}\n${readFileSync(join(SRC, f), 'utf8')}`).join('\n')

const failures = []

// 1. No imported geometry, textures or audio: the whole point of the budget.
// Objects rather than tuples: a mixed tuple infers as (RegExp | string)[],
// and calling .exec on that is not provably safe.
const banned = [
  {
    pattern: /GltfContainer/,
    why: 'GltfContainer - an imported model breaks the "primitives only" claim'
  },
  { pattern: /\.glb\b|\.gltf\b/, why: 'a .glb/.gltf reference' },
  { pattern: /\.png\b|\.jpg\b|\.jpeg\b/, why: 'a texture reference in scene code' },
  { pattern: /AudioSource|AudioStream/, why: 'audio, which the scene does not ship' }
]
for (const { pattern, why } of banned) {
  const hit = pattern.exec(source)
  if (hit) failures.push(`found ${why} (matched "${hit[0]}")`)
}

// 2. Hold the tally and the scene to each other. A primitive that is rendered
// but not modelled here would hollow the budget out silently, and one modelled
// but no longer rendered would flatter it.
for (const call of Object.keys(TRIANGLES)) {
  const used = new RegExp(`MeshRenderer\\.${call}\\b`).test(source)
  if (used && !(call in RENDERED)) failures.push(`MeshRenderer.${call} is rendered but not counted`)
  if (!used && call in RENDERED) failures.push(`${call} is counted but no longer rendered`)
}
for (const m of source.matchAll(/MeshRenderer\.(\w+)/g)) {
  if (!(m[1] in TRIANGLES)) failures.push(`unknown MeshRenderer.${m[1]} - add its cost here`)
}

// 3. Add it up.
let estimated = 0
for (const [call, n] of Object.entries(RENDERED)) estimated += n * TRIANGLES[call]

const rendered = Object.values(RENDERED).reduce((a, b) => a + b, 0)
if (rendered > MAX_RENDERED) {
  failures.push(`${rendered} rendered primitives, ceiling is ${MAX_RENDERED}`)
}

const share = ((estimated / HARD_LIMIT) * 100).toFixed(4)
console.log('Sambung scene budget')
for (const [call, n] of Object.entries(RENDERED)) {
  console.log(`  ${String(n).padStart(2)} x ${call.padEnd(12)} ~${n * TRIANGLES[call]} tri`)
}
console.log(`  ${rendered} rendered primitives, ceiling ${MAX_RENDERED}`)
console.log(`  estimated ~${estimated} tri = ${share}% of the ${HARD_LIMIT} hard limit`)
console.log('  imported models: none | textures in scene code: none | audio: none')

if (failures.length > 0) {
  console.error('\nBudget broken:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\nWithin budget.')
