import {
  engine,
  Entity,
  Transform,
  MeshRenderer,
  MeshCollider,
  Material,
  AudioSource,
  TouchScreenControls,
  InputAction,
  UiCanvasInformation,
  AvatarShape,
  TextShape,
  pointerEventsSystem
} from '@dcl/sdk/ecs'
import { Color3, Color4, Vector3 } from '@dcl/sdk/math'
import { MessageBus } from '@dcl/sdk/message-bus'
import { getPlayer, onEnterScene, onLeaveScene } from '@dcl/sdk/players'
import { triggerEmote, copyToClipboard } from '~system/RestrictedActions'
import { getRealm, getExplorerInformation } from '~system/Runtime'
import { getPlayersInScene } from '~system/Players'
import {
  EMOTES,
  CHEER_EMOTE,
  State,
  newState,
  tap,
  tick,
  adopt,
  litIndex,
  parseChain,
  showStep,
  LIT_FRACTION
} from './game.ts'
import {
  Snapshot,
  Link,
  EMPTY,
  parseSnapshot,
  parseAuthors,
  clampText,
  betterOf,
  demoAdvance,
  shouldPlayDemo,
  worldKey,
  jumpUrl,
  myMark
} from './record.ts'
import { ghostPlan, EMOTE_URN, WEARABLES } from './ghosts.ts'
import { CLIP, PAD_PITCH, MISS_PITCH } from './audio.ts'
import { REQUEST_TIMEOUT_MS, withRetry } from './net.ts'
import { setupUi } from './ui.tsx'

const CENTER = Vector3.create(8, 0, 8)
const RING_RADIUS = 5.5
const FLASH = 0.25 // seconds a pad stays lit after you press it

// Where the record lives between visits. Empty means local-only, and the game is
// fully playable that way — the network is a layer on top, never a dependency.
// Verified live: GET/POST round-trip, monotonic writes, malformed payloads rejected.
// Typed as string, not as its literal: an empty value is a supported mode
// (local-only play), and the guards below must stay reachable code.
const RECORD_API: string = 'https://sambung-dcl.vercel.app/api/chain'
/** The scene's console, but reachable: see server/api/note.ts. Same host. */
const NOTE_API: string = RECORD_API.replace(/\/api\/chain$/, '/api/note')
/** "desktop", "mobile", "vr" or "web", as the client reports itself. */
let platform = 'unknown'

/**
 * Where records live when the realm cannot say. The realm is asked first (see
 * resolveWorld): a preview must never write into the live world's record, and
 * the World this scene is hosted on is borrowed - it can be reassigned.
 */
const DEFAULT_WORLD = 'rainbowroad.dcl.eth'
let world = DEFAULT_WORLD
/** The realm as the client names it - what an invite link has to point at. */
let realmName = DEFAULT_WORLD

const state: State = newState()
const bus = new MessageBus()

/**
 * Parallel to state.chain: who added each link. Kept here rather than inside
 * State so the game logic stays identity-free and unit-testable on its own.
 * Appended and cleared in lockstep with the chain — see onTap and the season
 * watcher in main().
 */
let authors: { user: string; name: string }[] = []

/**
 * Everyone else currently in the scene.
 *
 * Kept because a chain is only broadcast when somebody extends it, so before
 * this a player who walked in mid-round saw an empty stage until the next tap.
 */
const others = new Set<string>()
let known: Snapshot = EMPTY

// The only onboarding a first-timer gets, so it states the rule, not the mood:
// pads that light are the chain; you repeat them; then you add one.
let ticker = 'Tap a pad: your avatar performs it, and the chain starts. Repeat it, then add a link.'

/** Seconds left of the "chain is gone" line after a season ends. */
const ENDED_HOLD = 3
let endedTimer = 0

// The record plays itself back once on arrival: a visitor should watch what the
// record IS before being asked to beat it. Never a memory test — any tap skips it.
// ponytail: capped, because a 40-long record would be a 30-second cutscene.
const DEMO_MAX = 12
let demoIdx = -1
let demoTimer = 0
/** Set by the first accepted tap. The record reply may arrive long after it. */
let played = false
let flashIdx = -1
let flashTimer = 0
/** Each pillar carries its own colour, so nothing indexes EMOTES in parallel. */
let pillars: { entity: Entity; hex: string; lit: boolean }[] = []

function me(): string {
  return getPlayer()?.name ?? 'Someone'
}

function myId(): { user: string; name: string } {
  const p = getPlayer()
  return { user: p?.userId ?? 'anon', name: p?.name ?? 'Someone' }
}

/** The current chain as a storable record, with its builders attached. */
function snapshotNow(): Snapshot {
  return {
    record: state.chain.length,
    chain: state.chain.map((emote, i) => ({
      emote,
      user: authors[i]?.user ?? 'anon',
      name: authors[i]?.name ?? 'Someone'
    }))
  }
}

/**
 * One place for anything that goes wrong quietly.
 *
 * Every network failure here is deliberately non-fatal, which is right for play
 * but leaves nothing to look at when a judge reports "the record never showed".
 * The scene console (log/error only - the runtime has no warn) is visible in
 * preview and in the client debug panel, so a silent failure leaves a trace. No
 * player data is written out beyond the name already shown in-world.
 */
function note(what: string, err: unknown) {
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`[sambung] ${what}:`, detail)
  beacon('error', `${what}: ${detail}`)
}

/**
 * One line to the endpoint about something that happened on this device.
 *
 * Nothing that identifies the player travels: the kind of event, the client
 * platform, and for errors a short detail. It is the only way to learn what a
 * judge's phone did - every failure here is swallowed for the player's sake,
 * and a console on a phone is a console nobody reads. Fire and forget; a
 * beacon that fails must not become another beacon.
 */
function beacon(kind: string, detail?: string) {
  if (!NOTE_API) return
  const body = JSON.stringify(detail ? { kind, platform, detail } : { kind, platform })
  fetch(`${NOTE_API}?world=${encodeURIComponent(world)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    timeout: REQUEST_TIMEOUT_MS
  }).catch(() => undefined)
}

/** The scene runtime provides setTimeout, so backoff is a real wait, not a spin. */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * One attempt at the endpoint, retried only when retrying could help.
 *
 * A transport failure or a 5xx may pass; a 4xx is our own malformed request and
 * would fail identically three times. The scene's fetch defaults to a 30 second
 * timeout, which is far too long to leave a visitor's record hanging, so every
 * call carries its own.
 */
async function callRecordApi(init?: {
  method: string
  headers: Record<string, string>
  body: string
}) {
  return withRetry(async () => {
    const res = await fetch(`${RECORD_API}?world=${encodeURIComponent(world)}`, {
      ...init,
      timeout: REQUEST_TIMEOUT_MS
    })
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`)
    return res
  }, sleep)
}

async function loadRecord() {
  if (!RECORD_API) return
  try {
    const res = await callRecordApi()
    if (!res.ok) {
      note('the record endpoint refused the read', `HTTP ${res.status}`)
      return
    }
    // A 200 that fails validation means the endpoint changed shape under us,
    // which is worth knowing about even though play continues regardless.
    if (!adoptSnapshot(parseSnapshot(await res.json()))) return
    if (shouldPlayDemo(known.record, played, state.chain.length)) {
      // One line for the whole replay. Naming each builder per step rewrote the
      // ticker every 0.4 s, which made the names - the reason to come back -
      // the one thing on screen nobody could read.
      const links = known.record === 1 ? '1 link' : `${known.record} links`
      ticker = `The record: ${links}, built by ${builderLine(known)}.`
      startDemo()
    }
  } catch (err) {
    // Offline, or the endpoint is down. Local-only play is the correct fallback,
    // so the player is never shown an error - but the reason is recorded.
    note('could not load the record', err)
  }
}

async function postRecord(snap: Snapshot) {
  if (!RECORD_API) return
  try {
    const res = await callRecordApi({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snap)
    })
    if (!res.ok) {
      note('the record endpoint refused the write', `HTTP ${res.status}`)
      return
    }
    // The reply is the endpoint's own view after the write: it holds the week it
    // stamped, and any record another player set while this one was in flight.
    // Throwing it away is how the ticker used to announce "nobody has set a chain
    // this week" one second after this player set it.
    adoptSnapshot(parseSnapshot(await res.json()))
  } catch (err) {
    // Losing one record post is survivable. Blocking the game on it is not.
    note('could not publish the record', err)
  }
}

/** Fold an endpoint reply into what this client knows. */
function adoptSnapshot(snap: Snapshot | null): boolean {
  if (!snap) {
    note('the record endpoint returned an unusable payload', 'failed validation')
    return false
  }
  known = betterOf(known, snap)
  if (known.record > state.record) state.record = known.record
  return true
}

/**
 * The reachable goal. The all-time record can be years of players deep; the
 * weekly one is what a visitor today can realistically take, which is the whole
 * reason to come back on another day.
 */
function weeklyTarget(): string {
  const week = known.week
  if (!week || week.record === 0) return 'Nobody has set a chain this week. Go first.'
  // Being told to beat your own number is a taunt; being told it is yours is
  // the reason to come back and defend it.
  const mine = week.chain[week.chain.length - 1]?.user === myId().user
  if (mine) return `This week's best is yours at ${week.record}. Keep it.`
  return `This week's best is ${week.record} — beat it.`
}

/**
 * The number the player is actually chasing. The all-time record can be years
 * of players deep; the week's best is the one a visitor today can take, so it
 * is the one the header shows whenever the endpoint has told us about a week.
 */
function target(): { label: string; n: number } {
  if (known.week) return { label: "WEEK'S BEST", n: known.week.record }
  return { label: 'RECORD', n: state.record }
}

/** Distinct builders in the order they first appear, for "built by Ana, Bo and 3 more". */
function builderLine(snap: Snapshot): string {
  const names: string[] = []
  const seen = new Set<string>()
  for (const l of snap.chain) {
    if (seen.has(l.user)) continue
    seen.add(l.user)
    // Names are stored at up to 40 characters; three of those would wrap the
    // replay line to four rows on a phone.
    names.push(clampText(l.name, 14) || 'Someone')
  }
  const shown = names.slice(0, 3)
  const rest = names.length - shown.length
  const last = shown[shown.length - 1] ?? 'nobody'
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${last}` : last
  return rest > 0 ? `${list} and ${rest} more` : list
}

function demoRunning(): boolean {
  return demoIdx >= 0
}

function stopDemo() {
  demoIdx = -1
}

function startDemo() {
  if (known.record === 0) return
  demoIdx = 0
  demoTimer = 0
  // The people who built it, standing on the stage. A solo visitor watches the
  // record performed by its actual builders rather than reading their names.
  showGhosts(known.chain)
  const first = known.chain[0]
  if (first) ghostPerform(first.user, first.emote)
}

/** Advance the record playback. Returns true while it still owns the pillars. */
function tickDemo(dt: number): boolean {
  if (!demoRunning()) return false
  demoTimer += dt
  // The same ramp the game itself uses, so a long record is a quick flourish
  // rather than a cutscene a visitor has to sit through.
  const step = showStep(known.chain.length)
  if (demoTimer < step) return true
  demoTimer -= step
  const next = demoAdvance(demoIdx, known.chain.length, DEMO_MAX)
  if (next === -1) {
    const shown = Math.min(known.chain.length, DEMO_MAX)
    const rest = known.record > shown ? `…and ${known.record - shown} more. ` : ''
    // A returning player is told where they are in it. The record already knows
    // who built every link, and being named in it is the reason to come back.
    const mine = myMark(known.chain, myId().user)
    ticker =
      mine > 0
        ? `Link ${mine} of that record is yours. It is still standing.`
        : `${rest}That was the record. ${weeklyTarget()}`
    stopDemo()
    // The record is theirs, so the applause is theirs. It also leaves the stage
    // holding a group of people rather than a row of mannequins.
    ghostsCheer()
    return false
  }
  demoIdx = next
  const link = known.chain[next]
  if (link) ghostPerform(link.user, link.emote)
  return true
}

function highlight(): number {
  if (demoRunning()) {
    // The same gap the game keeps, so a record with a repeated pad replays as
    // the two notes it is.
    if (demoTimer >= showStep(known.chain.length) * LIT_FRACTION) return -1
    return known.chain[demoIdx]?.emote ?? -1
  }
  // A miss shows the pad it should have been, for as long as the miss is held.
  // The wrong pad used to light exactly like a right one, so a player learned
  // "missed" from the thud and the word and never from the pads.
  if (state.phase === 'failed') return state.chain[state.cursor] ?? -1
  const shown = litIndex(state)
  if (shown >= 0) return shown
  return flashTimer > 0 ? flashIdx : -1
}

// The builders of the record, standing on the stage and performing their own
// links. Where each one stands is ghostPlan's arithmetic; this is only the
// entities, which is why it lives here with buildStage rather than in a module
// node --test cannot load.
//
// Two facts the 2026-08-31 spike paid for:
//   1. AvatarShape DOES render inside a normal scene. The proto comment saying
//      it "is only actually used in the global Avatar Scene" is wrong.
//   2. expressionTriggerId must be a FULL URN. The bare id that triggerEmote()
//      takes renders a frozen avatar in the rest pose, and says nothing.
const ghosts = new Map<string, Entity>()

/**
 * Put the builders on the stage, replacing whoever was there.
 *
 * The id is namespaced rather than the raw userId: a returning player whose link
 * is in the record is standing in the scene under that exact id, and handing the
 * client two avatars with one id invites it to merge or fight over them.
 */
function showGhosts(chain: Link[]) {
  clearGhosts()
  for (const slot of ghostPlan(chain)) {
    const ghost = engine.addEntity()
    Transform.create(ghost, { position: Vector3.create(slot.x, 0.3, slot.z) })
    AvatarShape.create(ghost, {
      id: `ghost:${slot.user}`,
      name: slot.name,
      // Explicit, because the client drew a naked body when this was empty and
      // the proto's documented per-slot defaults never arrived.
      wearables: WEARABLES,
      emotes: [],
      expressionTriggerId: '',
      expressionTriggerTimestamp: 0
    })
    // The client draws no floating nametag for a scene AvatarShape - only for
    // real players - so the name that makes this a person rather than a prop
    // has to be drawn by the scene.
    const label = engine.addEntity()
    Transform.create(label, { position: Vector3.create(0, 2.4, 0), parent: ghost })
    TextShape.create(label, { text: slot.name, fontSize: 2 })
    ghosts.set(slot.user, ghost)
  }
}

/**
 * One builder performs one link. The timestamp has to change for the client to
 * treat it as a fresh trigger, so the same emote twice in a row still plays.
 */
function ghostPerform(user: string, emote: number) {
  const ghost = ghosts.get(user)
  const id = EMOTES[emote]?.id
  if (!ghost || !id) return
  const shape = AvatarShape.getMutable(ghost)
  shape.expressionTriggerId = EMOTE_URN + id
  shape.expressionTriggerTimestamp = Date.now()
}

/** Everyone at once, when the record has finished replaying. */
function ghostsCheer() {
  for (const ghost of ghosts.values()) {
    const shape = AvatarShape.getMutable(ghost)
    shape.expressionTriggerId = EMOTE_URN + CHEER_EMOTE
    shape.expressionTriggerTimestamp = Date.now()
  }
}

function clearGhosts() {
  for (const ghost of ghosts.values()) engine.removeEntityWithChildren(ghost)
  ghosts.clear()
}

/** Carries the miss sound. The stage itself is where a broken chain belongs. */
let stage: Entity = engine.RootEntity

function buildStage() {
  const floor = engine.addEntity()
  stage = floor
  Transform.create(floor, {
    position: Vector3.create(8, 0.1, 8),
    scale: Vector3.create(13, 0.2, 13)
  })
  MeshRenderer.setCylinder(floor)
  MeshCollider.setCylinder(floor)
  Material.setPbrMaterial(floor, { albedoColor: Color4.fromHexString('#14121F'), roughness: 1 })
  AudioSource.create(floor, { audioClipUrl: CLIP, playing: false, pitch: MISS_PITCH, volume: 1 })

  pillars = EMOTES.map((e, i) => {
    const angle = (i / EMOTES.length) * Math.PI * 2
    const entity = engine.addEntity()
    Transform.create(entity, {
      position: Vector3.create(
        CENTER.x + Math.cos(angle) * RING_RADIUS,
        1.6,
        CENTER.z + Math.sin(angle) * RING_RADIUS
      ),
      scale: Vector3.create(0.7, 3.2, 0.7)
    })
    MeshRenderer.setBox(entity)
    MeshCollider.setBox(entity)
    // The voice sits on the pillar, so the sound arrives from the pad that lit -
    // the ring is spatial audio, not a stereo mix. Global audio would have been
    // the lazier call but it is desktop-only, and this scene is for phones.
    AudioSource.create(entity, {
      audioClipUrl: CLIP,
      playing: false,
      pitch: PAD_PITCH[i] ?? 1,
      volume: 1
    })
    // The pillar is a pad too. The collider was already there for nothing; now
    // tapping the thing that lit counts the same as tapping its button, which
    // is how a desktop judge with a mouse and no thumb zone plays at all, and
    // how a phone player who looks up from the grid keeps playing.
    pointerEventsSystem.onPointerDown(
      { entity, opts: { button: InputAction.IA_POINTER, hoverText: e.label, maxDistance: 14 } },
      () => onTap(i)
    )
    paint(entity, e.hex, false)
    return { entity, hex: e.hex, lit: false }
  })
}

function paint(entity: Entity, hex: string, lit: boolean) {
  const c = Color3.fromHexString(hex)
  Material.setPbrMaterial(entity, {
    albedoColor: lit ? Color4.fromColor3(c) : Color4.create(c.r * 0.25, c.g * 0.25, c.b * 0.25, 1),
    emissiveColor: lit ? c : Color3.Black(),
    emissiveIntensity: lit ? 3 : 0,
    roughness: 0.6
  })
}

/**
 * Strike an entity's clip from the top.
 *
 * `playing` alone is not enough to retrigger: the client keeps the flag true
 * after a clip ends, so a second strike would write the same component state,
 * emit no update, and be silent. Nudging currentTime guarantees the component
 * actually changes, and the offset is a tenth of a millisecond - inaudible.
 */
function pulse(entity: Entity) {
  const audio = AudioSource.getMutableOrNull(entity)
  if (!audio) return
  audio.currentTime = audio.currentTime === 0 ? 0.0001 : 0
  audio.playing = true
}

function syncPillars() {
  const on = highlight()
  pillars.forEach((pillar, i) => {
    const shouldBeLit = i === on
    if (pillar.lit === shouldBeLit) return
    pillar.lit = shouldBeLit
    paint(pillar.entity, pillar.hex, shouldBeLit)
    // Light and sound are the same event, so every path that lights a pad -
    // playback, a tap, the record replay - is scored without knowing about audio.
    if (shouldBeLit) pulse(pillar.entity)
    else {
      const audio = AudioSource.getMutableOrNull(pillar.entity)
      if (audio) audio.playing = false
    }
  })
}

function onTap(i: number) {
  // A tap can only come from the pad grid, but the index is still an index:
  // resolve it once, and treat an impossible one as no tap at all.
  const emote = EMOTES[i]
  if (!emote) return

  // Skipping is always allowed: a player who wants to start must never be held
  // hostage by someone else's replay.
  const skipped = demoRunning()
  if (skipped) stopDemo()

  const result = tap(state, i)
  if (result === 'ignored') return

  if (!played) beacon('first_tap')
  played = true
  // No flash on a miss: highlight() shows the expected pad instead.
  if (result !== 'missed') {
    flashIdx = i
    flashTimer = FLASH
  }

  // The avatar performs the emote, so everyone in the world reads your input
  // without needing any UI of yours. This is the whole social surface.
  if (result !== 'missed') void triggerEmote({ predefinedEmote: emote.id })

  if (result === 'added') {
    authors.push(myId())
    // Your own thumb, your own screen: no name, no count - the header has it.
    ticker = skipped ? `Record skipped. You added ${emote.label}.` : `You added ${emote.label}.`
    bus.emit('chain', { chain: state.chain, authors, by: me(), label: emote.label })
  } else if (result === 'completed') {
    // A run that beats this week's target but not the all-time one is still news:
    // the weekly number is the reachable goal on the ticker, and it used to be
    // impossible to move it in any world whose all-time record was already higher.
    const mine = snapshotNow()
    const beatsAllTime = mine.record > known.record
    const beatsWeek = mine.record > (known.week?.record ?? 0)
    if (beatsAllTime) {
      // The room finds out the way it finds out everything else in this game:
      // by watching an avatar. Beating the record used to change a number in
      // your own corner of the screen and nothing else.
      void triggerEmote({ predefinedEmote: CHEER_EMOTE })
      ticker = `${me()} set the record at ${mine.record}.`
      known = betterOf(known, mine)
      bus.emit('record', mine)
      beacon('record', `${mine.record}`)
    } else if (beatsWeek) {
      // The week is the target on the ticker, so taking it has to be said.
      ticker = `${me()} took this week's best at ${mine.record}.`
    } else {
      ticker = `Chain of ${mine.record} repeated.`
    }
    if (beatsWeek) known = { ...known, week: mine }
    if (beatsAllTime || beatsWeek) void postRecord(mine)
  } else if (result === 'missed') {
    pulse(stage)
    // Position, not length: the header and the status carry the length.
    ticker = `You missed link ${state.cursor + 1} of ${state.chain.length}.`
  }
}

// The pad grid owns the whole bottom band of the screen — exactly where the native
// joystick and gamepad buttons sit, and they swallow the taps underneath them. Nothing
// here uses movement or an InputAction, so clear the mobile HUD outright.
// ponytail: drop hideJoystick if playtests want players to walk the stage.
const HUD_BUTTONS = [
  InputAction.IA_POINTER,
  InputAction.IA_PRIMARY,
  InputAction.IA_SECONDARY,
  InputAction.IA_JUMP,
  InputAction.IA_ACTION_3,
  InputAction.IA_ACTION_4,
  InputAction.IA_ACTION_5,
  InputAction.IA_ACTION_6
]

function clearMobileHud() {
  TouchScreenControls.createOrReplace(engine.RootEntity, {
    hideJoystick: true,
    hideCrosshair: true,
    touchInputs: HUD_BUTTONS.map((inputAction) => ({ inputAction, hide: true }))
  })
}

/**
 * Ask the realm which world this is, before the first record call goes out.
 *
 * Never fatal: an unanswered realm just means the default world key, which is
 * what the scene used to hardcode.
 */
async function resolveWorld() {
  try {
    const { realmInfo } = await getRealm({})
    world = worldKey(realmInfo, DEFAULT_WORLD)
    realmName = (realmInfo?.realmName ?? '').trim() || DEFAULT_WORLD
    if (realmInfo?.isPreview) console.log(`[sambung] preview realm - records go to "${world}"`)
  } catch (err) {
    note('could not read the realm, using the default world key', err)
  }
  // The platform is the one fact worth knowing about every arrival: whether
  // the phone client is what people actually come in on. Asked after the
  // world is known, so the arrival lands in the right list.
  try {
    const info = await getExplorerInformation({})
    platform = info.platform || 'unknown'
  } catch (err) {
    note('could not read the explorer information', err)
  }
  beacon('arrive')
  reportCanvas()
}

/**
 * Send the raw canvas numbers home, once.
 *
 * The web client draws this scene's UI into a strip about twenty pixels wide on a
 * 390x844 canvas, while the same build lays out correctly at 1280x800. `frameFor`
 * cannot produce that on its own - it floors the frame at a quarter of each axis -
 * so the renderer is reporting something the layout does not expect, and no
 * screenshot can say what. This prints the numbers to the beacon list instead of
 * guessing at them.
 *
 * ponytail: diagnostic, delete once the portrait layout is understood. It rides on
 * the beacon that already exists rather than adding a channel.
 */
function reportCanvas() {
  const i = UiCanvasInformation.getOrNull(engine.RootEntity)
  if (!i) {
    beacon('error', 'canvas: none reported')
    return
  }
  const box = (r?: { top: number; right: number; bottom: number; left: number }) =>
    r ? `${r.top},${r.right},${r.bottom},${r.left}` : 'none'
  beacon(
    'error',
    `canvas ${i.width}x${i.height} ratio:${i.devicePixelRatio} screen:${box(i.screenInsetArea)} inter:${box(i.interactableArea)}`
  )
}

/**
 * Put this World on the player's clipboard.
 *
 * A World has no address a friend can guess and mobile has no share sheet for
 * one, so without this the only way to invite somebody is to spell out a name
 * ending in .dcl.eth over voice chat. A jump link opens Decentraland on this
 * stage; pasting it into a chat is the whole invite.
 */
function onInvite() {
  void copyToClipboard({ text: jumpUrl(realmName) })
    .then(() => {
      ticker = 'Link copied. Paste it to a friend — a chain needs somebody to dare.'
      beacon('invite')
    })
    .catch((err: unknown) => {
      // No clipboard on this client: the name is still something you can say out
      // loud, so the invite degrades to words rather than disappearing.
      note('could not copy the invite link', err)
      ticker = `Tell a friend to open ${realmName} — search it in Places.`
    })
}

/**
 * Count who is already standing here.
 *
 * onEnterScene only fires for arrivals after this client loads, so a player who
 * walked into a busy stage counted zero others and the ticker said so.
 */
async function seedOthers() {
  try {
    const mine = myId().user
    const { players } = await getPlayersInScene({})
    for (const p of players) if (p.userId && p.userId !== mine) others.add(p.userId)
  } catch (err) {
    note('could not list who is already in the scene', err)
  }
}

/** Tell the room who just walked in, and hand them the chain in progress. */
function watchArrivals() {
  onEnterScene((player) => {
    if (player.userId === myId().user) return
    others.add(player.userId)
    ticker =
      others.size === 1
        ? `${player.name} just arrived. Chain together.`
        : `${player.name} joined — ${others.size} others here.`

    // Re-broadcast so the newcomer adopts the round already under way instead of
    // waiting for the next tap. adopt() ignores anything not longer than what a
    // client already holds, so the duplicate emits from several players converge.
    // ponytail: every present player answers an arrival. Fine at party size; if a
    // crowd ever shows up, elect one answerer instead.
    if (state.chain.length > 0) {
      bus.emit('chain', {
        chain: state.chain,
        authors,
        by: me(),
        label: EMOTES[state.chain[state.chain.length - 1] ?? 0]?.label ?? ''
      })
    }
  })

  onLeaveScene((userId) => {
    others.delete(userId)
  })
}

export function main() {
  clearMobileHud()
  buildStage()
  setupUi({
    state,
    highlight,
    demo: demoRunning,
    ended: () => endedTimer,
    target,
    ticker: () => ticker,
    onTap,
    onInvite
  })

  watchArrivals()
  void seedOthers()
  // Never awaited: the scene must be playable before any of this lands. The
  // realm answer only has to arrive before the record call it keys.
  void resolveWorld().then(loadRecord)

  // Comms is a trust boundary. Anyone in the world can emit on this bus, and
  // what arrives is written straight into the live chain and printed in the
  // ticker - so it is parsed exactly as hard as an HTTP reply is.
  bus.on('chain', (msg: unknown) => {
    const m = (typeof msg === 'object' && msg !== null ? msg : {}) as Record<string, unknown>
    const chain = parseChain(m.chain)
    if (!chain) {
      note('a peer broadcast a chain this scene cannot use', JSON.stringify(m.chain ?? null))
      return
    }
    if (!adopt(state, chain)) return
    // A live round outranks the opening replay: without this the adopted chain
    // sat behind the demo, and the newcomer watched a record while the room was
    // already playing.
    stopDemo()
    // Authors travel with the chain, or the record we later store would credit
    // the wrong people.
    authors = parseAuthors(m.authors, chain.length)
    const by = clampText(m.by) || 'Someone'
    const label = clampText(m.label, 12) || 'an emote'
    ticker = `${by} added ${label}.`
  })

  // A record set by somebody else in the room. Without this every other client
  // kept the stale number until their next visit, and could then announce
  // themselves as record holder for a run the endpoint would refuse.
  bus.on('record', (msg: unknown) => {
    const snap = parseSnapshot(msg)
    if (!snap || snap.record <= known.record) return
    known = betterOf(known, snap)
    if (known.record > state.record) state.record = known.record
    const by = snap.chain[snap.chain.length - 1]?.name ?? 'Someone'
    ticker = `${by} set the record at ${snap.record}.`
  })

  // A season ends inside tick(), not on a tap, so watch for the chain emptying.
  // The surviving record is the whole point of the reset — say it out loud.
  let prevChain = 0
  engine.addSystem((dt: number) => {
    if (tickDemo(dt)) {
      syncPillars()
      return
    }
    tick(state, dt)
    if (prevChain > 0 && state.chain.length === 0) {
      authors = [] // stays in lockstep with the chain it describes
      endedTimer = ENDED_HOLD
      ticker = `Chain of ${prevChain} is gone. ${weeklyTarget()}`
    }
    prevChain = state.chain.length
    if (flashTimer > 0) flashTimer -= dt
    if (endedTimer > 0) endedTimer -= dt
    syncPillars()
  })
}

// ponytail: the live chain is deliberately NOT persisted — only the record chain is
// (see src/record.ts). Storing the live chain would hand a fresh visitor a 15-long
// chain to repeat from memory, which is a wall, not a welcome.
