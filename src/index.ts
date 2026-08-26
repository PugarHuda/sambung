import {
  engine,
  Entity,
  Transform,
  MeshRenderer,
  MeshCollider,
  Material,
  TouchScreenControls,
  InputAction
} from '@dcl/sdk/ecs'
import { Color3, Color4, Vector3 } from '@dcl/sdk/math'
import { MessageBus } from '@dcl/sdk/message-bus'
import { getPlayer, onEnterScene, onLeaveScene } from '@dcl/sdk/players'
import { triggerEmote } from '~system/RestrictedActions'
import { EMOTES, State, newState, tap, tick, adopt, litIndex, SHOW_STEP } from './game.ts'
import {
  Snapshot,
  EMPTY,
  parseSnapshot,
  betterOf,
  builders,
  demoAdvance,
  shouldPlayDemo
} from './record.ts'
import { REQUEST_TIMEOUT_MS, withRetry } from './net.ts'
import { setupUi } from './ui.tsx'
import { spikeAvatar } from './spike-avatar.ts' // SPIKE: remove with the file

const CENTER = Vector3.create(8, 0, 8)
const RING_RADIUS = 5.5
const FLASH = 0.25 // seconds a pad stays lit after you press it

// Where the record lives between visits. Empty means local-only, and the game is
// fully playable that way — the network is a layer on top, never a dependency.
// Verified live: GET/POST round-trip, monotonic writes, malformed payloads rejected.
// Typed as string, not as its literal: an empty value is a supported mode
// (local-only play), and the guards below must stay reachable code.
const RECORD_API: string = 'https://sambung-dcl.vercel.app/api/chain'
const WORLD = 'rainbowroad.dcl.eth'

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

let ticker = 'Chain up an emote, then dare the next player to repeat it.'

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
  console.error(`[sambung] ${what}:`, err instanceof Error ? err.message : String(err))
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
    const res = await fetch(`${RECORD_API}?world=${WORLD}`, {
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
    const snap = parseSnapshot(await res.json())
    if (!snap) {
      // A 200 that fails validation means the endpoint changed shape under us,
      // which is worth knowing about even though play continues regardless.
      note('the record endpoint returned an unusable payload', `HTTP ${res.status}`)
      return
    }
    known = betterOf(known, snap)
    if (known.record > state.record) state.record = known.record
    if (shouldPlayDemo(known.record, played, state.chain.length)) {
      ticker = `Record ${known.record}, built by ${builders(known)} players. Watch.`
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
    if (!res.ok) note('the record endpoint refused the write', `HTTP ${res.status}`)
  } catch (err) {
    // Losing one record post is survivable. Blocking the game on it is not.
    note('could not publish the record', err)
  }
}

/**
 * The reachable goal. The all-time record can be years of players deep; the
 * weekly one is what a visitor today can realistically take, which is the whole
 * reason to come back on another day.
 */
function weeklyTarget(): string {
  const week = known.week?.record ?? 0
  if (week === 0) return 'Nobody has set a chain this week. Go first.'
  return `This week's best is ${week} — beat it.`
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
  nameDemoStep() // the first builder gets credited too, not just the rest
}

function nameDemoStep() {
  const link = known.chain[demoIdx]
  const emote = link && EMOTES[link.emote]
  if (link && emote) ticker = `${link.name} added ${emote.label}`
}

/** Advance the record playback. Returns true while it still owns the pillars. */
function tickDemo(dt: number): boolean {
  if (!demoRunning()) return false
  demoTimer += dt
  if (demoTimer < SHOW_STEP) return true
  demoTimer -= SHOW_STEP
  const next = demoAdvance(demoIdx, known.chain.length, DEMO_MAX)
  if (next === -1) {
    const shown = Math.min(known.chain.length, DEMO_MAX)
    const rest = known.record > shown ? `…and ${known.record - shown} more. ` : ''
    ticker = `${rest}Record ${known.record}. ${weeklyTarget()}`
    stopDemo()
    return false
  }
  demoIdx = next
  nameDemoStep()
  return true
}

function highlight(): number {
  if (demoRunning()) return known.chain[demoIdx]?.emote ?? -1
  const shown = litIndex(state)
  if (shown >= 0) return shown
  return flashTimer > 0 ? flashIdx : -1
}

function buildStage() {
  const floor = engine.addEntity()
  Transform.create(floor, {
    position: Vector3.create(8, 0.1, 8),
    scale: Vector3.create(13, 0.2, 13)
  })
  MeshRenderer.setCylinder(floor)
  MeshCollider.setCylinder(floor)
  Material.setPbrMaterial(floor, { albedoColor: Color4.fromHexString('#14121F'), roughness: 1 })

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

function syncPillars() {
  const on = highlight()
  pillars.forEach((pillar, i) => {
    const shouldBeLit = i === on
    if (pillar.lit === shouldBeLit) return
    pillar.lit = shouldBeLit
    paint(pillar.entity, pillar.hex, shouldBeLit)
  })
}

function onTap(i: number) {
  // A tap can only come from the pad grid, but the index is still an index:
  // resolve it once, and treat an impossible one as no tap at all.
  const emote = EMOTES[i]
  if (!emote) return

  // Skipping is always allowed: a player who wants to start must never be held
  // hostage by someone else's replay.
  if (demoRunning()) stopDemo()

  const result = tap(state, i)
  if (result === 'ignored') return

  played = true
  flashIdx = i
  flashTimer = FLASH

  // The avatar performs the emote, so everyone in the world reads your input
  // without needing any UI of yours. This is the whole social surface.
  if (result !== 'missed') void triggerEmote({ predefinedEmote: emote.id })

  if (result === 'added') {
    authors.push(myId())
    ticker = `${me()} added ${emote.label} — chain is ${state.chain.length}`
    bus.emit('chain', { chain: state.chain, authors, by: me(), label: emote.label })
  } else if (result === 'completed' && state.chain.length > known.record) {
    known = snapshotNow()
    void postRecord(known)
  } else if (result === 'missed') {
    ticker = `${me()} broke the chain at ${state.cursor + 1}`
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
  spikeAvatar() // SPIKE: remove with the file
  clearMobileHud()
  buildStage()
  setupUi({ state, highlight, ticker: () => ticker, onTap })

  watchArrivals()
  void loadRecord() // never awaited: the scene must be playable before this lands

  bus.on(
    'chain',
    (msg: {
      chain: number[]
      authors?: { user: string; name: string }[]
      by: string
      label: string
    }) => {
      if (adopt(state, msg.chain)) {
        // Authors travel with the chain, or the record we later store would
        // credit the wrong people.
        authors = (msg.authors ?? []).slice(0, msg.chain.length)
        ticker = `${msg.by} added ${msg.label} — chain is ${state.chain.length}`
      }
    }
  )

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
      ticker = `Chain broke at ${prevChain}. ${weeklyTarget()}`
    }
    prevChain = state.chain.length
    if (flashTimer > 0) flashTimer -= dt
    syncPillars()
  })
}

// ponytail: the live chain is deliberately NOT persisted — only the record chain is
// (see src/record.ts). Storing the live chain would hand a fresh visitor a 15-long
// chain to repeat from memory, which is a wall, not a welcome.
