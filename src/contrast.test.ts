import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMOTES } from './game.ts'
import {
  contrastRatio,
  luminance,
  readableInk,
  LIGHT_INK,
  DARK_INK,
  MIN_CONTRAST
} from './contrast.ts'

test('luminance matches the WCAG anchors', () => {
  assert.equal(luminance('#000000'), 0)
  assert.equal(luminance('#ffffff'), 1)
  // Mid grey is far below 0.5: luminance is not linear in the channel value.
  assert.ok(luminance('#808080') > 0.21 && luminance('#808080') < 0.22)
})

test('luminance accepts either case and a missing hash', () => {
  assert.equal(luminance('#E63946'), luminance('e63946'))
  assert.equal(luminance('#e63946'), luminance('#E63946'))
})

test('luminance refuses anything that is not a six-digit hex', () => {
  for (const bad of ['#fff', 'red', '', '#12345g', '#1234567']) {
    assert.throws(() => luminance(bad), /not a #rrggbb colour/, `accepted ${bad}`)
  }
})

test('contrastRatio spans the full WCAG range and is symmetric', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21)
  assert.equal(contrastRatio('#ffffff', '#000000'), 21)
  assert.equal(contrastRatio('#123456', '#123456'), 1)
})

test('every pad label is readable while its pad is lit', () => {
  const failures: string[] = []
  for (const e of EMOTES) {
    const ratio = contrastRatio(readableInk(e.hex), e.hex)
    if (ratio < MIN_CONTRAST) failures.push(`${e.label} ${e.hex} at ${ratio.toFixed(2)}:1`)
  }
  assert.deepEqual(failures, [], `pads below ${MIN_CONTRAST}:1 once lit`)
})

test('every pad label is readable while its pad is dimmed', () => {
  // Mirrors the 0.3 multiply the UI applies to an unlit pad.
  const failures: string[] = []
  for (const e of EMOTES) {
    const n = parseInt(e.hex.slice(1), 16)
    const dim =
      '#' +
      [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
        .map((c) =>
          Math.round(c * 0.3)
            .toString(16)
            .padStart(2, '0')
        )
        .join('')
    const ratio = contrastRatio(readableInk(dim), dim)
    if (ratio < MIN_CONTRAST) failures.push(`${e.label} dimmed to ${dim} at ${ratio.toFixed(2)}:1`)
  }
  assert.deepEqual(failures, [], `dimmed pads below ${MIN_CONTRAST}:1`)
})

test('readableInk only switches the pads that white cannot carry', () => {
  assert.equal(readableInk('#E9C46A'), DARK_INK, 'pale yellow fails white, so it flips')
  assert.equal(readableInk('#F4A261'), DARK_INK, 'sandy orange fails white, so it flips')
  // Dark ink would score higher here (5.5 against 3.3) but white already clears
  // the bar, and the design keeps white wherever it can.
  assert.equal(readableInk('#2A9D8F'), LIGHT_INK, 'deep teal keeps white')
  assert.equal(readableInk('#131018'), LIGHT_INK, 'near-black keeps white')
})

test('whatever ink is chosen actually clears the threshold', () => {
  for (const e of EMOTES) {
    const ratio = contrastRatio(readableInk(e.hex), e.hex)
    assert.ok(ratio >= MIN_CONTRAST, `${e.label} ended at ${ratio.toFixed(2)}:1`)
  }
})
