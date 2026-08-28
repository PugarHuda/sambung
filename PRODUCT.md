# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The interface is not a web page. It is a `@dcl/react-ecs` UI rendered by the Decentraland
client (mobile, desktop, and the web explorer) inside a 3D scene, plus the scene itself. Of
the four schema values, `web` is the nearest: one design language everywhere, no OS-native
affordances to inherit. Treat every "web" assumption (CSS, DOM, browser fonts, hover, scroll)
as unavailable unless `@dcl/react-ecs` provides it: the toolkit is `UiEntity`, `Label`,
flex-style `uiTransform` in percentages, solid `uiBackground` colours, and `ScreenInsetArea`.
No images in the UI by product decision (see constraints).

## Users

Decentraland Mobile players on a phone, one-handed, in sessions of two to five minutes,
often alone. They arrive through the Places list or a jump link. The job is to fill a short
gap with something that feels social even with nobody else on the stage, and to leave with a
reason to invite someone or come back. (Confirmed.)

A buildathon judge is a special case of the same user: enters alone, once, and the first
thirty seconds decide the score. (Confirmed; judging 2026-09-05.)

Secondary, when it happens: a group already together on the stage, playing the shared chain
by watching each other. Not the case to optimise for.

## Product Purpose

Sambung is Simon says played with the player's avatar. Tap an emote pad, the avatar performs
it, the emote joins a chain; everyone repeats the chain from memory, and whoever gets it
right adds the next link. A chain has three lives; when it dies, its length is left behind as
the record to beat. Success is a visitor who plays past the first chain, and a room that
reads each other by watching avatars rather than reading a UI.

Built for the Decentraland Friendzone Mobile Buildathon, whose brief is a social experience
that gives people a reason to connect, stay longer, invite friends, and return regularly.

## Positioning

The avatar is the interface. Every input is an emote performed in the world, visible to
everyone present, so other players are read by watching them, not by reading a HUD. A
neighbouring scene can copy a memory game; it cannot copy that without becoming this. Backed
by a record that outlives the visit and names the player behind every link, and by a scene
light enough (192 triangles, no assets) that it never drops a frame on a mid-range phone.
(Confirmed.)

## Operating Context

- Lives in a borrowed Decentraland World, `RainbowRoad.dcl.eth`, granted by the organiser;
  the World's name, byline and access are the organiser's, not ours.
- Discovered through Places (`places.decentraland.org`) and jump links; the mobile client
  has no share sheet for a World, so the in-game INVITE pad copying a jump link is the
  only invite mechanism.
- Night skybox is fixed in `scene.json` (the emissive pads read as flat circles at noon).
- The native mobile HUD (joystick, crosshair, gamepad buttons) is hidden by the scene; there
  is no walking, aiming, or typing.
- A record endpoint (Vercel function + Redis) stores the all-time and weekly best per
  World; the scene is local-first and fully playable before, or without, any reply.

## Capabilities and Constraints

Confirmed functionality: eight emote pads (WAVE, CLAP, DAB, ROBOT, SHRUG, KISS, MONEY,
BOOM), each also a tappable pillar in the world with its own pitch; the chain/lives/record
state machine; opening replay of the record with each link's builder named; weekly target;
celebration emote when the record breaks; INVITE; presence of others announced in a ticker.

Binding constraints (confirmed):

- **Primitives only.** One cylinder, eight boxes, no imported models, no textures, no
  custom materials, one 13 KB generated WAV. `npm run budget` fails CI otherwise. UI labels
  are words plus colour, never icon textures.
- **One thumb.** The 4×2 pad grid owns the bottom 34% of the screen inside
  `ScreenInsetArea`; the header sits near the top. Layout is percentage-based so it holds on
  every aspect ratio. Nothing may require a second hand, a hover, or precision.
- **The eight pad colours are fixed** (`src/game.ts`); label ink per pad is derived from
  WCAG contrast (`src/contrast.ts`) and tested. A colour change must keep the tests green.
- **In-game copy is English only.** Product name stays Indonesian.

Terminology: _chain_ (the sequence), _link_ (one emote in it), _record_ (longest chain ever
repeated), _week's best_, _season_ (a chain's life until it dies), _builder_ (a player who
added a link).

Undecided: whether the record replay is performed by ghost avatars of its builders
(`AvatarShape` spike shipped 2026-08-28, awaiting a phone test) or stays as lights and
names.

## Brand Commitments

- Name **Sambung** — Indonesian for "to continue", and the childhood chain game _sambung
  kata_. Binding.
- Voice in the ticker: short, direct, second person, a little dry ("Chain broke at 7. This
  week's best is 9 — beat it."). No exclamation marks, no hype.
- Thumbnail at `images/thumbnail.png` (512×512, crop-safe zone above y=430 for the jump
  card).

## Evidence on Hand

- Live World: `https://decentraland.org/jump/?realm=rainbowroad.dcl.eth`.
- Source, tests and CI: `https://github.com/PugarHuda/sambung` (public).
- Measured: 192 triangles (0.016% of the mobile hard limit); 82 unit tests; 41 Playwright
  tests across five engines; a live-World verification suite.
- No testimonials, player counts, or press exist. Do not invent any.

## Product Principles

1. Playable alone in the first thirty seconds; social when someone else walks in.
2. The avatar performs every input; the UI never says what the world already shows.
3. Light enough for a mid-range phone is a feature, not a limit — spend nothing on assets.
4. The record is the retention hook: persist only what earns a return visit, name the people
   in it.
5. Local-first: the game never waits on the network.

## Accessibility & Inclusion

Pad labels must meet WCAG large-text contrast (3:1) against their lit colour; colour is the
primary signal, so every pad also carries a word and a distinct pitch. Target hit areas are
whole pads, not text.
