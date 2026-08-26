// Readability maths for the pad labels. No DCL imports, so it is unit-testable.
//
// Four of the eight pads fail the WCAG large-text threshold with white labels
// once lit - DAB, a pale yellow, sits at 1.67:1 - and a pad is lit exactly when
// the player needs to read it, during playback. Rather than hand-picking a text
// colour per pad and letting it rot when a hex changes, the colour is derived.

/** sRGB channel to linear light, per WCAG 2.x. */
function channel(v: number): number {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Relative luminance of a `#rrggbb` colour, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`)
  const n = parseInt(m[1] as string, 16)
  return (
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff)
  )
}

/** WCAG contrast ratio between two colours, from 1 (identical) to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** The label colours a pad may use. Ink is not pure black: it reads softer. */
export const LIGHT_INK = '#FFFFFF'
export const DARK_INK = '#131018'

/** WCAG AA for large text. The pad labels are bold and large on screen. */
export const MIN_CONTRAST = 3

/**
 * The ink a label should use on this background.
 *
 * White is kept wherever it clears the threshold, even when dark ink would score
 * higher: flipping healthy pads too would rework the look for no readability
 * gain. Only the pads that actually fail switch.
 */
export function readableInk(background: string): string {
  const light = contrastRatio(LIGHT_INK, background)
  if (light >= MIN_CONTRAST) return LIGHT_INK
  return contrastRatio(DARK_INK, background) > light ? DARK_INK : LIGHT_INK
}
