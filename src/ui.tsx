import ReactEcs, { ReactEcsRenderer, UiEntity, Label, ScreenInsetArea } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { EMOTES, State } from './game.ts'
import { readableInk } from './contrast.ts'

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

export function setupUi(ctx: UiContext) {
  // Everything lives inside the renderer-reported safe area: the header sits near
  // the top edge and the pads own the bottom band, which on a phone is exactly
  // where the notch, status bar and home indicator are. ScreenInsetArea owns its
  // own positioning, so the child just fills it.
  ReactEcsRenderer.setUiRenderer(() => {
    // Resolved once per frame rather than once per pad: the answer is the same
    // for all eight, and this callback is the hot path.
    const on = ctx.highlight()
    const demo = ctx.demo()
    const target = ctx.target()
    // An invite is only offered when a tap is not a move. During playback and
    // repeat the pad sits a thumb-slip above the top row, and a slip onto it
    // used to be a silent non-move mid-chain.
    const inviting = !demo && ctx.state.phase === 'choosing'

    return (
      <ScreenInsetArea>
        <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              // 4% of the inset area, and 92% wide so a long ticker line wraps
              // with a margin instead of running into the screen edges.
              position: { top: '4%', left: '4%' },
              width: '92%',
              flexDirection: 'column',
              alignItems: 'center'
            }}
          >
            {/* The name is nowhere else on screen: the client chrome shows the
                World's name, which belongs to the organiser. */}
            <Label value="SAMBUNG" fontSize={14} color={FAINT} />
            <Label
              value={`${target.label} ${target.n} · LIVES ${ctx.state.lives}`}
              fontSize={18}
              color={FAINT}
            />
            <Label value={status(ctx.state, demo, ctx.ended())} fontSize={32} color={WHITE} />
            <Label value={ctx.ticker()} fontSize={20} color={VOICE} textAlign="top-center" />
          </UiEntity>

          {/* The one thing this game could not do: hand somebody the World.
              Parked in the dead band between the ticker and the pads, on the
              right, where a thumb already rests and no pad ever sits. */}
          {inviting && (
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { bottom: '41%', right: '2%' },
                width: '26%',
                height: '7%',
                justifyContent: 'center',
                alignItems: 'center'
              }}
              uiBackground={{ color: INVITE }}
              onMouseDown={ctx.onInvite}
            >
              <Label value="INVITE" fontSize={18} color={WHITE} textAlign="middle-center" />
            </UiEntity>
          )}

          {/* Thumb zone: 4x2 pads pinned to the bottom, sized in % so it survives
              every phone aspect ratio. Gutters are a third of a pad's margin for
              error: at 24% x 46% they were about five pixels on a portrait phone. */}
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { bottom: '3%', left: '2%' },
              width: '96%',
              height: '34%',
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
                  width: '23%',
                  height: '44%',
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
      </ScreenInsetArea>
    )
  })
}
