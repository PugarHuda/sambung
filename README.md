# Sambung

_Sambung_ — Indonesian for "to continue", and the name of the childhood chain game.
Simon says, played with your avatar.

One player taps an emote pad. Their avatar performs it, and it joins the chain. Everyone
else has to repeat the whole chain from memory — then whoever gets it right earns the
right to add the next one. The chain is shared by everyone in the World.

A chain has three lives. Miss, and it replays; miss it away entirely and the season
closes, the chain resets, and its length is left behind as the **record** to beat.

Built for the **Decentraland Friendzone Mobile Buildathon**. Live at
[RainbowRoad.dcl.eth](https://decentraland.org/jump/?realm=rainbowroad.dcl.eth), and
listed in Decentraland Places.

## Why it works on a phone

- **Eight big pads, one thumb.** No walking, no aiming, no camera control, no typing.
- **The native HUD is cleared.** `TouchScreenControls` hides the joystick, crosshair and
  gamepad buttons, so nothing overlaps the thumb zone or eats a tap meant for a pad.
- **The UI lives inside `ScreenInsetArea`,** so the header and the pad grid respect the
  notch, the status bar and the home indicator instead of hiding under them.
- **Colour is the signal, words are the backup** — and the label ink is derived per pad
  from its WCAG contrast ratio (`src/contrast.ts`), because four of the eight pads are
  too pale to carry white text at the moment they light up.
- **Every pad is also a note.** One 13 KB clip, played at eight pitches, so a chain is a
  melody and not just a sequence of flashes. That is the half of Simon that makes it
  memorable, and it costs one file.
- **No custom 3D assets.** One cylinder and eight boxes: **192 triangles**, 0.016% of the
  mobile hard limit of 1,200,000. No imported models, no textures, no materials beyond
  solid colour. `npm run budget` fails the build if that stops being true.

## Why it works when nobody else is around

Walk in and the record introduces itself: the best chain this World has ever held replays
across the pads, crediting the player behind each link, before you are asked for anything.
You watch what the record _is_, then start your own chain at one and chase it. Any tap
skips the replay — it is a welcome, never a memory test, and never a wall.

Judging happens one visitor at a time, so a game that needs four players is a game that
scores zero. Sambung is playable solo from the first tap. When someone else walks in, the
chain becomes shared and every input is broadcast through your avatar's emote, which is
the whole point: you read other players by watching them, not by reading a UI.

## The record

`server/api/chain.ts` is a single Vercel function in front of a Redis sorted set, deployed
separately from the scene and keyed by World.

- **A record is a set member scored by its own length,** so "the record" is the top of the
  set. Two players who finish at the same moment both add a member and the higher score
  wins on its own — no read-modify-write, no lock, and no way for a slower write to erase
  a better one. This replaced an object-store design that needed a list operation per
  read; the project's own test suite spent that store's free allowance in a day.
- **The all-time record never resets.** Blanking it could empty the World in the middle
  of a judging window.
- **A weekly best is a key per ISO week with a three-week expiry** — the reachable target
  on the ticker, and the reason to come back on another day. Expiry is the whole of the
  reset logic; the clock is the server's alone.
- **Reads are held at the edge for three seconds,** writes are limited per caller, and any
  world other than the deployed one ages out after a month of silence. All three exist
  because a store that runs out of operations is a record nobody can see.
- **The scene is local-first.** The game is fully playable before any network call
  resolves, and an unreachable endpoint reads as "no record yet" rather than an error.
  Requests carry an 8 s timeout and three retries with capped backoff.

The scene asks the realm which World it is in, so a local preview writes to its own
`preview-` key and can never touch the live record.

## Run it

```bash
npm install
npm start           # local preview
npm test            # 78 unit, contract, schema and bundle-boot tests
npm run budget      # triangle, asset and audio budget
npm run test:e2e    # 41 Playwright tests against the live endpoint, 5 browser engines
npm run lint        # eslint, type-aware
npm run sound       # regenerate sounds/pad.wav from scripts/make-sound.mjs
npm run serve       # the record endpoint on localhost, against the real store
```

Use the preview on an actual phone on the same network. Desktop lies about both
performance and touch ergonomics.

The test suite is deliberately layered:

| Suite                        | What only it can catch                                                     |
| ---------------------------- | -------------------------------------------------------------------------- |
| `src/*.test.ts`              | Chain rules, record parsing, contrast maths, retry policy, week boundaries |
| `src/contract.test.ts`       | Drift between the validator in the scene and its twin in the endpoint      |
| `src/scene-json.test.ts`     | `scene.json` against Decentraland's own schema, and the spawn region       |
| `src/bundle.test.ts`         | The real `bin/index.js` booting inside a stubbed scene runtime             |
| `e2e/record-api.spec.ts`     | CORS, preflight, concurrency, malformed and oversized payloads             |
| `e2e/abuse.spec.ts`          | A caller that writes like a loop is cut off; runs last, alone              |
| `e2e/deployed-world.spec.ts` | Whether the World actually serves what this repo says it does              |

The endpoint can be proven before a deployment slot is spent on it — Vercel's free plan
caps deployments per day, and this project has hit that cap with a fix ready twice:

```bash
npm run serve                                                       # in one terminal
SAMBUNG_API=http://127.0.0.1:8787/api/chain npm run test:e2e        # in another
```

## Publish it

```bash
npm run deploy      # scene → the World
npm run verify      # then check the World really got it
```

`npm run verify` is the step that matters. It reads the deployed entity back from the
content server and asserts that the bundle is byte-for-byte the local build, that the
metadata is not stale, that the audio clip is served and is a real WAVE stream, that
nothing private leaked into the public manifest, and that the Places listing shows the
copy we wrote. It has already caught a deploy that silently never happened.

After deploying, wait for Decentraland's asset-bundle conversion (~15 min) before judging
the result, and confirm the World's access is **Public**.

## Layout

| File                         | What's in it                                                          |
| ---------------------------- | --------------------------------------------------------------------- |
| `src/game.ts`                | The state machine, and the comms trust boundary. No DCL imports.      |
| `src/record.ts`              | Record parsing, world keys, week maths. No DCL imports.               |
| `src/net.ts`                 | Timeout and retry policy, with the clock injected.                    |
| `src/contrast.ts`            | WCAG luminance maths that picks each pad's label ink.                 |
| `src/audio.ts`               | The pitch table: one clip, eight voices.                              |
| `scripts/serve-endpoint.mjs` | The endpoint on localhost, for proving it before a deploy.            |
| `src/ui.tsx`                 | The thumb-zone pad grid and the status header.                        |
| `src/index.ts`               | Stage, emotes, audio, `MessageBus` sync, engine wiring.               |
| `server/api/chain.ts`        | The record endpoint. Deploys to Vercel (Singapore, beside the store). |
| `scripts/scene-budget.mjs`   | The performance claim, asserted from the source.                      |
| `scripts/make-sound.mjs`     | Generates the one audio file the scene ships.                         |

## Deliberately not built

- **Ghosts.** The plan is for the record replay to be performed by `AvatarShape` copies of
  the players who built it. The SDK warns that `AvatarShape` is "only actually used in the
  global Avatar Scene", so `src/spike-avatar.ts` exists to answer that on a real phone
  before anything is built on top of it. If the answer is no, the record replay stays as
  it is — lights and names.
- **Signed writes.** The endpoint validates shape, size and monotonicity, but does not
  verify a Decentraland auth chain. A determined forger can post one fake record.
  `signedFetch` verification is the upgrade path, worth doing if the record is actually
  vandalised.
- **Quests.** `@dcl/quests-client` ships with the SDK and is unused: `createQuestsClient`
  needs a `questId` already published to Decentraland's Quests service, which is
  provisioning outside this repo. Half-wiring it would be a stub.
- **Turn arbitration.** Two players extending the chain at the same instant resolve by
  "longest chain wins". Enough to converge; a real tiebreak only earns its keep if
  playtests show the collision actually happens.
- **Icon textures.** Words and colour cost zero bytes and zero draw calls.

## License

MIT — see [LICENSE](LICENSE).
