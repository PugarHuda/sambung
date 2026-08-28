// Where the UI may draw, and how it arranges itself there. No DCL imports, so
// the orientation logic is unit-testable with plain `node --test`.
//
// The renderer reports the canvas size and two rectangles it reserves: the
// device's own margins (notch, status bar, home indicator) and the client's HUD
// (chat, profile and emotes down the left edge on mobile, action buttons bottom
// right). The scene may draw only where neither is, and on a phone that region
// is wider than it is tall as often as not.

/** Insets from each edge of the canvas, in virtual pixels. */
export type Insets = { top: number; right: number; bottom: number; left: number }

/** The drawable rectangle, in virtual pixels from the canvas's top-left. */
export type Frame = { top: number; left: number; width: number; height: number; landscape: boolean }

/** Bare canvas when the renderer has not said otherwise: a phone in portrait. */
export const FALLBACK = { width: 390, height: 844 }

const ZERO: Insets = { top: 0, right: 0, bottom: 0, left: 0 }

/**
 * The drawable frame this frame.
 *
 * Both rectangles are honoured at once: whichever reserves more of an edge
 * wins that edge. A canvas the renderer has not described yet - the first
 * frames, an older client, the test host - falls back to a portrait phone,
 * so the layout is never undefined and never zero-sized.
 */
export function frameFor(
  width?: number,
  height?: number,
  screen?: Partial<Insets>,
  interactable?: Partial<Insets>
): Frame {
  const w = width && width > 0 ? width : FALLBACK.width
  const h = height && height > 0 ? height : FALLBACK.height
  const a = { ...ZERO, ...screen }
  const b = { ...ZERO, ...interactable }
  const top = Math.max(a.top, b.top)
  const left = Math.max(a.left, b.left)
  const right = Math.max(a.right, b.right)
  const bottom = Math.max(a.bottom, b.bottom)
  // A reservation that swallows the whole canvas is a renderer glitch, not a
  // layout: keep at least a quarter of each axis so the pads stay tappable.
  const fw = Math.max(w * 0.25, w - left - right)
  const fh = Math.max(h * 0.25, h - top - bottom)
  return { top, left, width: fw, height: fh, landscape: fw > fh }
}

/** A percentage of the drawable frame, in the form react-ecs accepts. */
export type Pct = `${number}%`
type Pos = { top?: Pct; bottom?: Pct; left?: Pct; right?: Pct }
type TextAlign = 'top-left' | 'top-center'

export type Layout = {
  header: { position: Pos; width: Pct; align: 'flex-start' | 'center'; textAlign: TextAlign }
  invite: { position: Pos; width: Pct; height: Pct }
  grid: { position: Pos; width: Pct; height: Pct }
  pad: { width: Pct; height: Pct }
}

/**
 * Portrait: a 4x2 band along the bottom, header top-centre, invite parked in
 * the dead band between them. All in % of the drawable frame.
 */
const PORTRAIT: Layout = {
  header: {
    position: { top: '4%', left: '4%' },
    width: '92%',
    align: 'center',
    textAlign: 'top-center'
  },
  invite: { position: { bottom: '41%', right: '2%' }, width: '26%', height: '7%' },
  grid: { position: { bottom: '3%', left: '2%' }, width: '96%', height: '34%' },
  // Gutters are a thumb's margin for error: at 24% x 46% they were about five
  // pixels on a portrait phone.
  pad: { width: '23%', height: '44%' }
}

/**
 * Landscape: a 2x4 column on the right, where one thumb actually is, header
 * top-left in the space that frees up, invite bottom-left. A 4-wide row across
 * a landscape screen is a two-thumb layout, and the product promises one.
 */
const LANDSCAPE: Layout = {
  header: {
    position: { top: '5%', left: '3%' },
    width: '52%',
    align: 'flex-start',
    textAlign: 'top-left'
  },
  invite: { position: { bottom: '6%', left: '3%' }, width: '22%', height: '12%' },
  grid: { position: { top: '5%', right: '2%' }, width: '40%', height: '90%' },
  pad: { width: '47%', height: '22.5%' }
}

export function layoutFor(frame: Frame): Layout {
  return frame.landscape ? LANDSCAPE : PORTRAIT
}
