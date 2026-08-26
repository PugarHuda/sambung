import ReactEcs, { ReactEcsRenderer, UiEntity, Label, ScreenInsetArea } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { EMOTES, State } from './game.ts'
import { readableInk } from './contrast.ts'

export type UiContext = {
  state: State
  /** Emote index that should read as "lit" right now, or -1. */
  highlight: () => number
  ticker: () => string
  onTap: (i: number) => void
}

const WHITE = Color4.White()
const FAINT = Color4.create(1, 1, 1, 0.65)

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
    unlit: Color4.create(c.r * 0.3, c.g * 0.3, c.b * 0.3, 1),
    // A lit pad is the one the player is being asked to read, and four of the
    // eight are too pale to carry white text: see src/contrast.ts.
    litInk: Color4.fromHexString(readableInk(e.hex)),
    unlitInk: WHITE
  }
})

function status(s: State): string {
  switch (s.phase) {
    case 'choosing':
      return s.chain.length === 0 ? 'TAP ANY PAD TO START THE CHAIN' : 'YOUR TURN — ADD ONE'
    case 'showing':
      return 'WATCH'
    case 'input':
      return `REPEAT  ${s.cursor}/${s.chain.length}`
    case 'failed':
      return 'MISSED — REPLAYING'
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
            <Label
              value={`CHAIN ${ctx.state.chain.length}   ·   RECORD ${ctx.state.record}   ·   LIVES ${ctx.state.lives}`}
              fontSize={22}
              color={FAINT}
            />
            <Label value={status(ctx.state)} fontSize={32} color={WHITE} />
            <Label value={ctx.ticker()} fontSize={16} color={FAINT} textAlign="top-center" />
          </UiEntity>

          {/* Thumb zone: 4x2 pads pinned to the bottom, sized in % so it survives
              every phone aspect ratio. */}
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
                  width: '24%',
                  height: '46%',
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
