import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { EMOTES, State } from './game.ts'
import { readableInk } from './contrast.ts'
import { Frame, frameFor, layoutFor } from './layout.ts'

export type UiContext = {
  state: State
  /** Emote index that should read as "lit" right now, or -1. */
  highlight: () => number
  /** True while the record replays itself on arrival. */
  demo: () => boolean
  /** Seconds left of the "chain is gone" hold after a season ends, or 0. */
  ended: () => number
  /** The number the player is actually chasing, and what to call it. */
  target: () => { label: string; n: number }
  ticker: () => string
  onTap: (i: number) => void
  onInvite: () => void
}

const WHITE = Color4.White()
const FAINT = Color4.create(1, 1, 1, 0.65)
/**
 * The product's voice. Brighter than the stats it sits under, because every
 * name, the record and the invite confirmation live here.
 */
const VOICE = Color4.create(1, 1, 1, 0.85)
/** Deliberately unlike any pad: an invite is not a move in the game. */
const INVITE = Color4.create(1, 1, 1, 0.16)

/**
 * Pad colours, resolved once.
 *
 * The renderer callback runs every frame, so parsing eight hex strings and
 * building sixteen Color4 objects inside it meant that allocation churn happened
 * sixty times a second on a phone, for values that never change.
 */
const PADS = EMOTES.map((e) => {
  const c = Color4.fromHexString(e.hex)
  return {
    id: e.id,
    label: e.label,
    lit: c,
    // Dim enough that a lit pad is unmistakable, bright enough that the eight
    // still read as eight colours: at 0.3 the yellow pad was a near-black box
    // and nobody could pre-locate it by colour.
    unlit: Color4.create(c.r * 0.45, c.g * 0.45, c.b * 0.45, 1),
    // A lit pad is the one the player is being asked to read, and four of the
    // eight are too pale to carry white text: see src/contrast.ts.
    litInk: Color4.fromHexString(readableInk(e.hex)),
    unlitInk: WHITE
  }
})

/**
 * The one line a phone player actually reads.
 *
 * Every state names its object: what to watch, what to repeat, what to add,
 * what a miss cost. The replay has its own case, because the state machine is
 * idle while the record performs, and "tap any pad" over a record performing
 * itself was the first thing every visitor saw.
 */
function status(s: State, demo: boolean, ended: number): string {
  if (demo) return 'WATCH — THE RECORD'
  switch (s.phase) {
    case 'choosing':
      if (s.chain.length > 0) return 'YOUR TURN — ADD A LINK'
      return ended > 0 ? 'CHAIN GONE — START AGAIN' : 'TAP A PAD — START A CHAIN'
    case 'showing':
      return `WATCH — ${s.chain.length} ${s.chain.length === 1 ? 'LINK' : 'LINKS'}`
    case 'input':
      return `REPEAT — ${s.cursor + 1} OF ${s.chain.length}`
    case 'failed':
      if (s.lives === 0) return 'OUT OF LIVES'
      return s.lives === 1 ? 'MISSED — LAST LIFE' : `MISSED — ${s.lives} LIVES LEFT`
  }
}

/**
 * The area the scene may draw in, as the renderer reports it this frame.
 *
 * UiCanvasInformation carries two rectangles. screenInsetArea is the device's
 * own margin - notch, status bar, home indicator. interactableArea is the part
 * the client's HUD leaves free: on mobile the client draws chat, profile and
 * emotes down the left edge and action buttons bottom-right, over any scene UI
 * underneath. ScreenInsetArea honours only the first, so the pad grid used to
 * run under the client's own buttons. The frame here is the intersection.
 */
function currentFrame(): Frame {
  const info = UiCanvasInformation.getOrNull(engine.RootEntity)
  return frameFor(info?.width, info?.height, info?.screenInsetArea, info?.interactableArea)
}

export function setupUi(ctx: UiContext) {
  ReactEcsRenderer.setUiRenderer(() => {
    // Resolved once per frame rather than once per pad: the answer is the same
    // for all eight, and this callback is the hot path.
    const on = ctx.highlight()
    const demo = ctx.demo()
    const target = ctx.target()
    const frame = currentFrame()
    const L = layoutFor(frame)
    // An invite is only offered when a tap is not a move. During playback and
    // repeat the pad sits a thumb-slip from the grid, and a slip onto it used
    // to be a silent non-move mid-chain.
    const inviting = !demo && ctx.state.phase === 'choosing'

    return (
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { top: frame.top, left: frame.left },
          width: frame.width,
          height: frame.height
        }}
      >
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: L.header.position,
            width: L.header.width,
            flexDirection: 'column',
            alignItems: L.header.align
          }}
        >
          {/* The name is nowhere else on screen: the client chrome shows the
              World's name, which belongs to the organiser. */}
          <Label value="SAMBUNG" fontSize={14} color={FAINT} textAlign={L.header.textAlign} />
          <Label
            value={`${target.label} ${target.n} · LIVES ${ctx.state.lives}`}
            fontSize={18}
            color={FAINT}
            textAlign={L.header.textAlign}
          />
          <Label
            value={status(ctx.state, demo, ctx.ended())}
            fontSize={32}
            color={WHITE}
            textAlign={L.header.textAlign}
          />
          <Label value={ctx.ticker()} fontSize={20} color={VOICE} textAlign={L.header.textAlign} />
        </UiEntity>

        {/* The one thing this game could not do: hand somebody the World. */}
        {inviting && (
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: L.invite.position,
              width: L.invite.width,
              height: L.invite.height,
              justifyContent: 'center',
              alignItems: 'center'
            }}
            uiBackground={{ color: INVITE }}
            onMouseDown={ctx.onInvite}
          >
            <Label value="INVITE" fontSize={18} color={WHITE} textAlign="middle-center" />
          </UiEntity>
        )}

        {/* The thumb zone. Portrait: a 4x2 band along the bottom. Landscape: a
            2x4 column on the right, where one thumb actually is. Sized in % of
            the drawable frame so it survives every phone. */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: L.grid.position,
            width: L.grid.width,
            height: L.grid.height,
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignContent: 'space-between'
          }}
        >
          {PADS.map((pad, i) => (
            <UiEntity
              key={pad.id}
              uiTransform={{
                width: L.pad.width,
                height: L.pad.height,
                justifyContent: 'center',
                alignItems: 'center'
              }}
              uiBackground={{ color: on === i ? pad.lit : pad.unlit }}
              onMouseDown={() => ctx.onTap(i)}
            >
              {/* ponytail: words + colour instead of icon textures. Colour is the
                  real signal; swap in icons only if playtests say words are slow to read. */}
              <Label
                value={pad.label}
                fontSize={20}
                color={on === i ? pad.litInk : pad.unlitInk}
                textAlign="middle-center"
              />
            </UiEntity>
          ))}
        </UiEntity>
      </UiEntity>
    )
  })
}
