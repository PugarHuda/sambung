// Contract test between the two deploy units.
//
// The scene (src/) and the record endpoint (server/) ship separately, so the
// endpoint cannot import the scene's validator — it carries its own copy. That
// copy is the whole defence against a forged snapshot, and a silent drift
// between the two would either reject honest records or let bad ones through.
// Nothing else in the build would notice, so this test reads the endpoint as
// text and holds it to the scene's numbers.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EMOTES } from './game.ts'

const SERVER = readFileSync(new URL('../server/api/chain.ts', import.meta.url), 'utf8')

function constantIn(source: string, name: string): number {
  // String.raw: a plain template literal would swallow the backslash and turn
  // \d into a literal 'd', quietly matching nothing.
  const m = source.match(new RegExp(String.raw`const ${name} = (\d+)`))
  assert.ok(m, `${name} not found in server/api/chain.ts — was it renamed?`)
  return Number(m[1])
}

test('the endpoint accepts exactly the emote range the scene can render', () => {
  assert.equal(
    constantIn(SERVER, 'MAX_EMOTE'),
    EMOTES.length,
    'server MAX_EMOTE drifted from EMOTES.length; a stored record could index past the pad table'
  )
})

test('the endpoint and the scene agree on the chain and name caps', () => {
  const client = readFileSync(new URL('./record.ts', import.meta.url), 'utf8')
  for (const name of ['MAX_CHAIN', 'MAX_NAME']) {
    assert.equal(
      constantIn(SERVER, name),
      constantIn(client, name),
      `${name} differs between server and scene`
    )
  }
})

test('the endpoint still rejects, rather than clamps, an out-of-range emote', () => {
  assert.match(
    SERVER,
    /l\.emote < 0 \|\| l\.emote >= MAX_EMOTE\) return null/,
    'the endpoint must return null (reject) on a bad emote, never coerce it'
  )
})

/** Pull a function body out of a source file, whitespace-normalised. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} not found`)
  const open = source.indexOf('{', start)
  let depth = 0
  let i = open
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) break
  }
  return source
    .slice(open + 1, i)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

test('both copies of isoWeek are the same calculation', () => {
  const client = readFileSync(new URL('./record.ts', import.meta.url), 'utf8')
  assert.equal(
    bodyOf(SERVER, 'isoWeek'),
    bodyOf(client, 'isoWeek'),
    'the weekly reset would fall on different days in the scene and the endpoint'
  )
})
