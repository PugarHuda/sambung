import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSnapshot,
  betterOf,
  builders,
  demoAdvance,
  shouldPlayDemo,
  isoWeek,
  EMPTY
} from './record.ts'

const link = (emote: number, user = 'u1', name = 'Lynx') => ({ emote, user, name })

test('a well-formed snapshot round-trips', () => {
  const s = parseSnapshot({ record: 2, chain: [link(0), link(7, 'u2', 'Tox')] })
  assert.ok(s)
  assert.equal(s.record, 2)
  assert.equal(s.chain[1].name, 'Tox')
})

test('rejects a record that disagrees with its chain', () => {
  assert.equal(parseSnapshot({ record: 99, chain: [link(0)] }), null)
})

test('rejects emote indexes outside the pad range', () => {
  assert.equal(parseSnapshot({ record: 1, chain: [link(8)] }), null)
  assert.equal(parseSnapshot({ record: 1, chain: [link(-1)] }), null)
  assert.equal(parseSnapshot({ record: 1, chain: [link(1.5)] }), null)
})

test('rejects junk instead of throwing', () => {
  for (const junk of [null, undefined, 42, 'nope', {}, { record: 1 }, { chain: [] }]) {
    assert.equal(parseSnapshot(junk), null, `junk survived: ${JSON.stringify(junk)}`)
  }
})

test('rejects an absurdly long chain', () => {
  const chain = Array.from({ length: 201 }, () => link(0))
  assert.equal(parseSnapshot({ record: chain.length, chain }), null)
})

test('truncates oversized names rather than trusting them', () => {
  const s = parseSnapshot({ record: 1, chain: [link(0, 'u'.repeat(200), 'n'.repeat(200))] })
  assert.ok(s)
  assert.equal(s.chain[0].name.length, 40)
})

test('betterOf keeps the longer run and ignores ties', () => {
  const short = { record: 1, chain: [link(0)] }
  const long = { record: 2, chain: [link(0), link(1)] }
  assert.equal(betterOf(short, long), long)
  assert.equal(betterOf(long, short), long)
  assert.equal(betterOf(long, { record: 2, chain: [link(3), link(4)] }), long, 'tie keeps ours')
  assert.equal(betterOf(EMPTY, long), long)
})

test('builders counts distinct contributors', () => {
  assert.equal(builders({ record: 3, chain: [link(0, 'a'), link(1, 'b'), link(2, 'a')] }), 2)
  assert.equal(builders(EMPTY), 0)
})

test('demoAdvance walks every link then stops', () => {
  const seen = [0]
  let i = 0
  while ((i = demoAdvance(i, 3, 12)) !== -1) seen.push(i)
  assert.deepEqual(seen, [0, 1, 2], 'every link of a 3-chain must be shown exactly once')
})

test('demoAdvance stops immediately on a single-link record', () => {
  assert.equal(demoAdvance(0, 1, 12), -1)
})

test('demoAdvance honours the cap on a long record', () => {
  const seen = [0]
  let i = 0
  while ((i = demoAdvance(i, 40, 12)) !== -1) seen.push(i)
  assert.equal(seen.length, 12, 'a 40-long record must replay only the capped 12')
  assert.equal(seen[seen.length - 1], 11)
})

test('demoAdvance treats an empty record as already finished', () => {
  assert.equal(demoAdvance(0, 0, 12), -1)
})

test('the arrival replay only runs for an untouched arrival', () => {
  assert.equal(shouldPlayDemo(5, false, 0), true, 'fresh visitor with a record to show')
  assert.equal(shouldPlayDemo(0, false, 0), false, 'nothing to replay yet')
  assert.equal(shouldPlayDemo(5, true, 0), false, 'player already tapped — never seize the pads')
  assert.equal(shouldPlayDemo(5, false, 3), false, 'a chain is already going')
})

test('isoWeek follows the ISO-8601 rules, including the year boundaries', () => {
  // Reference values from the ISO-8601 definition: a week belongs to the year
  // containing its Thursday.
  const cases: Array<[string, string]> = [
    ['2026-08-26T00:00:00Z', '2026-W35'], // an ordinary midweek day
    ['2026-08-24T00:00:00Z', '2026-W35'], // Monday starts the week
    ['2026-08-30T23:59:59Z', '2026-W35'], // Sunday still closes the same week
    ['2026-08-31T00:00:00Z', '2026-W36'], // the next Monday rolls over
    ['2027-01-01T12:00:00Z', '2026-W53'], // a Friday that belongs to last year
    ['2025-12-29T00:00:00Z', '2026-W01'], // a Monday that belongs to next year
    ['2024-12-31T00:00:00Z', '2025-W01'], // leap year, still next year's week 1
    ['2026-01-04T00:00:00Z', '2026-W01']
  ]
  for (const [iso, expected] of cases) {
    assert.equal(isoWeek(new Date(iso)), expected, `wrong week for ${iso}`)
  }
})

test('isoWeek is stable across every hour of a day', () => {
  const seen = new Set<string>()
  for (let h = 0; h < 24; h++) {
    seen.add(isoWeek(new Date(Date.UTC(2026, 7, 26, h))))
  }
  assert.equal(seen.size, 1, 'the week must not shift within a single UTC day')
})

test('a weekly block is parsed alongside the all-time record', () => {
  const s = parseSnapshot({
    record: 2,
    chain: [link(0), link(1)],
    week: { record: 1, chain: [link(3)] }
  })
  assert.ok(s)
  assert.equal(s.record, 2)
  // Asserted rather than optional-chained: an absent block would otherwise make
  // both checks pass against undefined.
  assert.ok(s.week, 'the weekly block must be parsed')
  assert.equal(s.week.record, 1)
  assert.equal(s.week.chain[0]?.emote, 3)
})

test('a malformed weekly block is dropped, not fatal', () => {
  const s = parseSnapshot({ record: 1, chain: [link(0)], week: { record: 9, chain: [link(0)] } })
  assert.ok(s, 'the all-time record must still come through')
  assert.equal(s.record, 1)
  assert.equal(s.week, undefined, 'the inconsistent weekly block is discarded')
})

test('a snapshot without a weekly block is still valid', () => {
  const s = parseSnapshot({ record: 1, chain: [link(0)] })
  assert.ok(s)
  assert.equal(s.week, undefined)
})
