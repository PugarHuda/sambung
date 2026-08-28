#!/usr/bin/env node
// Reads the scene's beacons back: what happened on real devices, in order.
//
//   npm run notes                       # the live world
//   npm run notes -- preview-rainbowroad.dcl.eth
//   SAMBUNG_API=http://127.0.0.1:8787/api/chain npm run notes   # a local endpoint
//
// This is the only view of the scene running on somebody else's phone. Every
// failure the scene swallows for the player's sake lands here, next to the
// arrivals and first taps that say whether anybody is playing at all.

const { fetch } = globalThis

const api = (process.env.SAMBUNG_API ?? 'https://sambung-dcl.vercel.app/api/chain').replace(
  /\/api\/chain$/,
  '/api/note'
)
const world = process.argv[2] ?? 'rainbowroad.dcl.eth'

/** @typedef {{ at: string; kind: string; platform: string; detail?: string }} Beacon */

/**
 * The endpoint's reply, held to the shape the scene writes.
 * @param {unknown} body
 * @returns {Beacon[]}
 */
function beaconsOf(body) {
  if (typeof body !== 'object' || body === null) return []
  const notes = /** @type {{ notes?: unknown }} */ (body).notes
  if (!Array.isArray(notes)) return []
  /** @param {unknown} v */
  const str = (v) => (typeof v === 'string' ? v : '')
  return /** @type {unknown[]} */ (notes).flatMap((n) => {
    if (typeof n !== 'object' || n === null) return []
    const o = /** @type {Record<string, unknown>} */ (n)
    const detail = str(o.detail)
    return [
      { at: str(o.at), kind: str(o.kind), platform: str(o.platform), detail: detail || undefined }
    ]
  })
}

const res = await fetch(`${api}?world=${encodeURIComponent(world)}`)
if (!res.ok) {
  console.error(`${api} answered ${res.status}`)
  process.exit(1)
}
const notes = beaconsOf(await res.json())
if (notes.length === 0) {
  console.log(`no beacons for ${world}`)
  process.exit(0)
}

/** @type {Map<string, number>} */
const counts = new Map()
for (const n of notes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1)
console.log(
  `${world}: ${notes.length} beacons - ` + [...counts].map(([k, v]) => `${k} ${v}`).join(', ')
)
for (const n of notes) {
  const when = n.at.replace('T', ' ').slice(0, 19)
  console.log(`${when}  ${n.kind.padEnd(9)} ${n.platform.padEnd(8)} ${n.detail ?? ''}`)
}
