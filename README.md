# Sambung

_Sambung_ — Indonesian for "to continue", and the name of the childhood chain game.
Simon says, played with your avatar.

One player taps an emote pad. Their avatar performs it, and it joins the chain. Everyone
else has to repeat the whole chain from memory — then whoever gets it right earns the
right to add the next one. The chain is shared by everyone in the World.

A chain has three lives. Miss, and it replays; miss it away entirely and the season
closes, the chain resets, and its length is left behind as the **record** to beat.

Built for the **Decentraland Friendzone Mobile Buildathon**.

## Why it works on a phone

- **Eight big pads, one thumb.** No walking, no aiming, no camera control, no typing.
- **The native HUD is cleared.** `TouchScreenControls` hides the joystick, crosshair and
  gamepad buttons, so nothing overlaps the thumb zone or eats a tap meant for a pad.
- **Colour is the signal, words are the backup.** Readable on a small screen at a glance.
- **Percent-based UI.** Layout holds on any aspect ratio.
- **No custom 3D assets.** One cylinder and eight boxes — the whole scene is primitives,
  so it loads instantly and never drops frames on a mid-range device.

## Why it works when nobody else is around

Walk in and the record introduces itself: the best chain this World has ever held replays
across the pads, crediting the player behind each link, before you are asked for anything.
You watch what the record _is_, then start your own chain at one and chase it. Any tap
skips the replay — it is a welcome, never a memory test, and never a wall.

Judging happens one visitor at a time, so a game that needs four players is a game that
scores zero. Sambung is playable solo from the first tap — you build the chain, you
repeat it, you chase your own best. When someone else walks in, the chain becomes shared
and every input is broadcast through your avatar's emote, which is the whole point: you
read other players by watching them, not by reading a UI.

## Run it

```bash
npm install
npm start     # opens the local preview
npm test      # game-logic self-check, no framework
```

Use the preview's mobile view — or better, open the preview URL on an actual phone on the
same network. Desktop lies about both performance and touch ergonomics.

## Publish it

1. Set `worldConfiguration.name` in `scene.json` to your Decentraland NAME or ENS domain
   (`yourname.dcl.eth` / `yourname.eth`).
2. `npm run deploy`
3. Wait for the asset-bundle conversion (~15 min) before judging the result.
4. Confirm the World's access is **Public** and that the spawn point drops you on the stage.

## Layout

| File               | What's in it                                                     |
| ------------------ | ---------------------------------------------------------------- |
| `src/game.ts`      | The state machine. No DCL imports, so it is testable on its own. |
| `src/game.test.ts` | `node --test` self-check for the chain rules.                    |
| `src/ui.tsx`       | The thumb-zone pad grid and the status header.                   |
| `src/index.ts`     | Stage, emote triggering, `MessageBus` sync, engine wiring.       |

## Deliberately not built yet

- **A record that outlives the tab.** Seasons and the record exist, but the number is
  still session-local. Carrying it across visits needs a small serverless endpoint —
  that is the next piece of work, not a someday.
- **Turn arbitration.** Two players extending the chain at the same instant resolve by
  "longest chain wins". Enough to converge; a real tiebreak only earns its keep if
  playtests show the collision actually happens.
- **Icon textures.** Words and colour cost zero bytes and zero draw calls.

## License

MIT — see [LICENSE](LICENSE).
