import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frameFor, layoutFor, FALLBACK } from './layout.ts'

test('no canvas information means a portrait phone, never a zero frame', () => {
  const f = frameFor()
  assert.equal(f.width, FALLBACK.width)
  assert.equal(f.height, FALLBACK.height)
  assert.equal(f.landscape, false)
  assert.equal(frameFor(0, 0).width, FALLBACK.width, 'a zero canvas is not a canvas')
})

test('the device margin and the client HUD are both honoured, edge by edge', () => {
  // Portrait phone: a notch at the top, a home indicator at the bottom, and a
  // client that draws chat and emotes down the left.
  const f = frameFor(390, 844, { top: 47, bottom: 34 }, { left: 72, bottom: 20, right: 8 })
  assert.equal(f.top, 47)
  assert.equal(f.left, 72, 'the HUD reservation on the left must be kept clear')
  assert.equal(f.width, 390 - 72 - 8)
  assert.equal(f.height, 844 - 47 - 34, 'the larger bottom reservation wins')
  assert.equal(f.landscape, false)
})

test('a phone on its side lays out for one thumb on the right', () => {
  const f = frameFor(844, 390, { left: 47, right: 47 }, { left: 120, bottom: 30 })
  assert.equal(f.landscape, true)
  const L = layoutFor(f)
  assert.equal(L.grid.position.right, '2%', 'the pads sit on the thumb side')
  assert.ok(L.grid.position.top, 'the column starts from the top, not the bottom band')
  assert.equal(L.header.align, 'flex-start', 'the header moves to the free space on the left')
  assert.notEqual(layoutFor(frameFor(390, 844)).pad.width, L.pad.width)
})

test('a reservation that swallows the canvas leaves the pads room to exist', () => {
  const f = frameFor(390, 844, { top: 900 }, { left: 400 })
  assert.ok(f.width >= 390 * 0.25)
  assert.ok(f.height >= 844 * 0.25)
})

test('a square canvas is portrait: the bottom band is the safer default', () => {
  assert.equal(frameFor(600, 600).landscape, false)
})

test('every layout sizes eight pads inside their grid', () => {
  for (const L of [layoutFor(frameFor(390, 844)), layoutFor(frameFor(844, 390))]) {
    const pw = parseFloat(L.pad.width)
    const ph = parseFloat(L.pad.height)
    // Two columns in landscape, four in portrait; the rows fill the rest. In
    // either case the pads must fit with a gutter left over, or the wrap breaks
    // and the last pad falls off the grid.
    const cols = pw > 30 ? 2 : 4
    const rows = 8 / cols
    assert.ok(cols * pw < 100, `${cols} pads of ${pw}% overflow the row`)
    assert.ok(rows * ph < 100, `${rows} rows of ${ph}% overflow the grid`)
    assert.ok(cols * pw > 85 && rows * ph > 85, 'the gutters are wider than the pads need')
  }
})
