import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { EMOTES } from './game.ts'
import { PAD_PITCH, MISS_PITCH } from './audio.ts'

// Boots the artifact that actually gets deployed - bin/index.js - inside a stub
// of the scene runtime.
//
// Every other test in this repo exercises a module. None of them can catch the
// class of failure that matters most on judging day: the bundle throwing on
// load, or asking the host for something the host does not have. The scene
// cannot be run headlessly in a real client, but the host side of it is a small
// set of RPC modules, and those can be stood up here. What is faked is the
// platform, never our code: the bundle under test is byte-for-byte the one that
// goes to the content server.

const BUNDLE = 'bin/index.js'

type Host = {
  crdtCalls: number
  /** Every byte the scene ever sent to the renderer, in order. */
  frames: Uint8Array[]
  emotes: string[]
  fetched: string[]
  realmAsked: number
  errors: string[]
}
type Scene = { onStart?: () => Promise<void>; onUpdate?: (dt: number) => Promise<void> }
type Realm = { realmName: string; isPreview?: boolean }
type Rect = { top: number; right: number; bottom: number; left: number }
/** What the renderer would report about the screen, if anything. */
type Canvas = { width: number; height: number; screenInsetArea?: Rect; interactableArea?: Rect }

/**
 * Nothing on the wire, unless a canvas is given: then the first reply from the
 * renderer carries UiCanvasInformation, exactly as a client would send it.
 */
function boot(realm: Realm, canvas?: Canvas): { scene: Scene; host: Host } {
  const host: Host = {
    crdtCalls: 0,
    frames: [],
    emotes: [],
    fetched: [],
    realmAsked: 0,
    errors: []
  }
  const empty = { data: [] as Uint8Array[] }
  // Sent once, on the first frame, then never again - a renderer only repeats
  // it when the canvas changes. Filled in once the vm context exists, because
  // the bytes have to be born inside it (see below).
  let pending: Uint8Array[] = []

  const systems: Record<string, unknown> = {
    '~system/EngineApi': {
      // Plain promises rather than async functions: nothing here awaits, and a
      // stub that pretends to is just noise the linter has to read past.
      crdtSendToRenderer: ({ data }: { data: Uint8Array }) => {
        host.crdtCalls++
        // Copied into this realm: a Uint8Array born inside the vm context fails
        // instanceof checks out here, and protobufjs answers "illegal buffer".
        host.frames.push(new Uint8Array(data))
        const reply = { data: pending }
        pending = []
        return Promise.resolve(reply)
      },
      crdtGetState: () => Promise.resolve({ ...empty, hasEntities: false }),
      subscribe: () => Promise.resolve({}),
      sendBatch: () => Promise.resolve({ events: [] })
    },
    '~system/CommunicationsController': {
      send: () => Promise.resolve({}),
      sendBinary: () => Promise.resolve(empty)
    },
    '~system/RestrictedActions': {
      triggerEmote: ({ predefinedEmote }: { predefinedEmote: string }) => {
        host.emotes.push(predefinedEmote)
        return Promise.resolve({})
      }
    },
    '~system/Runtime': {
      getRealm: () => {
        host.realmAsked++
        return Promise.resolve({ realmInfo: realm })
      },
      getSceneInformation: () =>
        Promise.resolve({ urn: 'test', content: [], metadataJson: '{}', baseUrl: '' }),
      getExplorerInformation: () =>
        Promise.resolve({ agent: 'test', platform: 'mobile', configurations: {} }),
      // Not called by the scene; present because a real host has it.
      getWorldTime: () => Promise.resolve({ seconds: 0 })
    },
    '~system/Players': {
      getPlayersInScene: () => Promise.resolve({ players: [] }),
      getConnectedPlayers: () => Promise.resolve({ players: [] })
    }
  }

  const module = { exports: {} as Scene }
  const sandbox = {
    module,
    exports: module.exports,
    require: (name: string) => {
      const found = systems[name]
      if (!found) throw new Error(`the scene asked the host for ${name}, which it does not provide`)
      return found
    },
    console: {
      log: () => undefined,
      error: (...args: unknown[]) => host.errors.push(args.map(String).join(' '))
    },
    fetch: (url: string) => {
      host.fetched.push(url)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ record: 0, chain: [], week: { record: 0, chain: [] } })
      })
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    TextDecoder,
    URL,
    Math,
    Date,
    JSON,
    globalThis: undefined as unknown
  }
  const context = createContext(sandbox)
  ;(sandbox as { globalThis: unknown }).globalThis = context
  if (canvas) {
    // The same realm rule in the other direction: a Uint8Array from this realm
    // fails instanceof inside the vm, so the message is rebuilt with the vm's
    // own constructor before the scene ever sees it.
    const VmU8 = runInContext('Uint8Array', context) as typeof Uint8Array
    pending = [new VmU8(canvasMessage(canvas))]
  }

  runInContext(readFileSync(BUNDLE, 'utf8'), context, { filename: BUNDLE })
  // The host object is handed back by reference, not copied: the counters are
  // written by the stubs long after boot returns.
  return { scene: module.exports, host }
}

/** Boot, then run a second of frames so the async work has somewhere to land. */
async function run(realm: Realm, canvas?: Canvas): Promise<Host> {
  const { scene, host } = boot(realm, canvas)
  assert.ok(typeof scene.onStart === 'function', 'the bundle must export onStart')
  assert.ok(typeof scene.onUpdate === 'function', 'the bundle must export onUpdate')
  await scene.onStart()
  // A second of frames, so the realm lookup and the record call have somewhere
  // to land: both are deliberately started without being awaited.
  for (let frame = 0; frame < 60; frame++) await scene.onUpdate(1 / 60)
  return host
}

test('the deployed bundle boots and drives the engine', { skip: !existsSync(BUNDLE) }, async () => {
  const host = await run({ realmName: 'rainbowroad.dcl.eth' })
  assert.deepEqual(host.errors, [], 'the scene logged an error while starting')
  assert.ok(host.crdtCalls > 0, 'the scene never sent a frame to the renderer')
})

test('a preview never touches the live record', { skip: !existsSync(BUNDLE) }, async () => {
  const host = await run({ realmName: 'rainbowroad.dcl.eth', isPreview: true })
  assert.ok(host.realmAsked > 0, 'the scene must ask the realm before keying a record')
  const calls = host.fetched.filter((u) => u.includes('/api/chain'))
  assert.ok(calls.length > 0, 'the scene never called the record endpoint')
  for (const url of calls) {
    assert.match(url, /world=preview-/, `a preview wrote to the live key: ${url}`)
  }
})

test(
  'the live realm keys the record to the world it is running in',
  {
    skip: !existsSync(BUNDLE)
  },
  async () => {
    const host = await run({ realmName: 'SomeOther.dcl.eth' })
    const calls = host.fetched.filter((u) => u.includes('/api/chain'))
    assert.ok(
      calls.every((u) => u.includes('world=someother.dcl.eth')),
      `the world key ignored the realm: ${calls.join(', ')}`
    )
  }
)

test(
  'the bundle asks the host for nothing it does not declare',
  { skip: !existsSync(BUNDLE) },
  () => {
    // A module the runtime does not provide is a hard crash in the client, and the
    // stub above throws by name so the failure message says which one.
    const source = readFileSync(BUNDLE, 'utf8')
    const asked = new Set(source.match(/~system\/[A-Za-z]+/g) ?? [])
    const known = new Set([
      '~system/EngineApi',
      '~system/CommunicationsController',
      '~system/RestrictedActions',
      '~system/Runtime',
      '~system/Players'
    ])
    for (const module of asked) assert.ok(known.has(module), `unstubbed host module ${module}`)
  }
)

// ---------------------------------------------------------------------------
// What the renderer would actually draw.
//
// The scene talks to the renderer in the CRDT wire protocol, and @dcl/ecs ships
// the reader for it. Decoding the bytes the bundle sent gives the scene's real
// inventory - not the source's intent, the renderer's input - which is the
// nearest thing to a screenshot that exists without a client. The decoder is
// bundled on the fly because @dcl/ecs is published for bundlers, not for Node.

type CrdtMessage = { type: number; entityId?: number; componentId?: number; data?: Uint8Array }
type ByteBuf = { toBinary(): Uint8Array }
type Decoder = {
  ReadWriteByteBuffer: new (buf?: Uint8Array) => ByteBuf
  readMessage: (buf: object) => CrdtMessage | null
  PutComponentOperation: {
    write: (
      entity: number,
      timestamp: number,
      componentId: number,
      data: Uint8Array,
      buf: ByteBuf
    ) => void
  }
  PBUiCanvasInformation: {
    encode: (m: Canvas & { devicePixelRatio: number }) => { finish(): Uint8Array }
  }
  PBUiTransform: {
    decode: (d: Uint8Array) => { parent?: number; width?: number; height?: number }
  }
  PBMeshRenderer: { decode: (d: Uint8Array) => { mesh?: { $case: string } } }
  PBAudioSource: { decode: (d: Uint8Array) => { audioClipUrl: string; pitch?: number } }
  PBUiText: { decode: (d: Uint8Array) => { value: string } }
  PBAvatarShape: { decode: (d: Uint8Array) => { id: string; expressionTriggerId?: string } }
}

/** Component ids from @dcl/ecs component-names.gen: the wire protocol's vocabulary. */
const MESH_RENDERER = 1018
const AUDIO_SOURCE = 1020
const UI_TEXT = 1052
const AVATAR_SHAPE = 1080
const POINTER_EVENTS = 1062
const UI_TRANSFORM = 1050
const UI_CANVAS_INFORMATION = 1054
const PUT_COMPONENT = 1
const ROOT_ENTITY = 0

let cached: Decoder | undefined
function decoder(): Decoder {
  if (cached) return cached
  // Written to disk and required, rather than evaluated from a string: the
  // same result with no eval anywhere in the test suite.
  const outfile = join(tmpdir(), `sambung-crdt-decoder-${process.pid}.cjs`)
  buildSync({
    stdin: {
      contents: `
        export { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
        export { readMessage } from '@dcl/ecs/dist/serialization/crdt/message'
        export { PutComponentOperation } from '@dcl/ecs/dist/serialization/crdt/putComponent'
        export { PBUiCanvasInformation } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_canvas_information.gen'
        export { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'
        export { PBMeshRenderer } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/mesh_renderer.gen'
        export { PBAudioSource } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/audio_source.gen'
        export { PBUiText } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_text.gen'
        export { PBAvatarShape } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/avatar_shape.gen'
      `,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile,
    logLevel: 'silent'
  })
  cached = createRequire(import.meta.url)(outfile) as Decoder
  return cached
}

/** UiCanvasInformation on the root entity, framed exactly as the renderer frames it. */
function canvasMessage(canvas: Canvas): Uint8Array {
  const d = decoder()
  const body = d.PBUiCanvasInformation.encode({ devicePixelRatio: 2, ...canvas }).finish()
  const buf = new d.ReadWriteByteBuffer()
  d.PutComponentOperation.write(ROOT_ENTITY, 1, UI_CANVAS_INFORMATION, body, buf)
  return buf.toBinary()
}

/** The last value of each (entity, component) the scene put, grouped by component. */
function inventory(frames: Uint8Array[], d: Decoder): Map<number, Map<number, Uint8Array>> {
  const byComponent = new Map<number, Map<number, Uint8Array>>()
  for (const frame of frames) {
    const buf = new d.ReadWriteByteBuffer(frame)
    for (;;) {
      const msg = d.readMessage(buf)
      if (!msg) break
      if (msg.type !== PUT_COMPONENT) continue
      if (msg.componentId === undefined || msg.entityId === undefined || !msg.data) continue
      const perEntity = byComponent.get(msg.componentId) ?? new Map<number, Uint8Array>()
      perEntity.set(msg.entityId, msg.data)
      byComponent.set(msg.componentId, perEntity)
    }
  }
  return byComponent
}

function decoded<T>(
  put: Map<number, Map<number, Uint8Array>>,
  id: number,
  decode: (d: Uint8Array) => T
): T[] {
  return [...(put.get(id)?.values() ?? [])].map(decode)
}

test(
  'the renderer is handed exactly the stage the budget was counted for',
  { skip: !existsSync(BUNDLE) },
  async () => {
    const host = await run({ realmName: 'rainbowroad.dcl.eth' })
    const d = decoder()
    const meshes = decoded(
      inventory(host.frames, d),
      MESH_RENDERER,
      (b) => d.PBMeshRenderer.decode(b).mesh?.$case
    )
    // One stage cylinder and one box per pad: the same nine primitives that
    // scripts/scene-budget.mjs prices at 192 triangles.
    assert.equal(meshes.filter((m) => m === 'cylinder').length, 1)
    assert.equal(meshes.filter((m) => m === 'box').length, EMOTES.length)
    assert.equal(meshes.length, EMOTES.length + 1, `unexpected meshes: ${meshes.join(',')}`)
    // Every pillar is tappable in the world, not only from the UI grid: a
    // collider with no pointer event is a wall, and that is what they were.
    // Counted by intersection: the UI grid's pads carry pointer events too, so
    // the bare count is the pillars plus the whole thumb zone.
    const put = inventory(host.frames, d)
    const meshEntities = new Set(put.get(MESH_RENDERER)?.keys() ?? [])
    const tappable = [...(put.get(POINTER_EVENTS)?.keys() ?? [])].filter((e) => meshEntities.has(e))
    assert.equal(tappable.length, EMOTES.length, `${tappable.length} pillars answer a tap`)
  }
)

test(
  'every pad has a voice at its own pitch, and the stage has the miss',
  { skip: !existsSync(BUNDLE) },
  async () => {
    const host = await run({ realmName: 'rainbowroad.dcl.eth' })
    const d = decoder()
    const sources = decoded(inventory(host.frames, d), AUDIO_SOURCE, (b) =>
      d.PBAudioSource.decode(b)
    )
    assert.equal(sources.length, EMOTES.length + 1)
    for (const s of sources) assert.equal(s.audioClipUrl, 'sounds/pad.wav')
    const pitches = sources.map((s) => s.pitch ?? 1).sort((a, b) => a - b)
    const expected = [MISS_PITCH, ...PAD_PITCH].sort((a, b) => a - b)
    for (let i = 0; i < expected.length; i++) {
      assert.ok(
        Math.abs((pitches[i] ?? 0) - (expected[i] ?? 0)) < 1e-5,
        `pitch ${i}: renderer got ${pitches[i]}, the audio table says ${expected[i]}`
      )
    }
  }
)

test(
  'the UI the renderer receives has a pad per emote, and the invite',
  { skip: !existsSync(BUNDLE) },
  async () => {
    const host = await run({ realmName: 'rainbowroad.dcl.eth' })
    const d = decoder()
    const labels = decoded(inventory(host.frames, d), UI_TEXT, (b) => d.PBUiText.decode(b).value)
    for (const e of EMOTES) assert.ok(labels.includes(e.label), `no pad labelled ${e.label}`)
    // Offered only while a tap is not a move, which the opening state is.
    assert.ok(labels.includes('INVITE'), 'the invite pad never reached the renderer')
    assert.ok(labels.includes('SAMBUNG'), 'the product name is nowhere on screen')
    assert.ok(
      labels.some((l) => l.startsWith('TAP A PAD')),
      `the opening prompt is missing; labels were ${labels.join(' | ')}`
    )
  }
)

test(
  'no AvatarShape reaches the renderer, because the ghost idea was not taken',
  { skip: !existsSync(BUNDLE) },
  async () => {
    // The spike passed its 2026-08-28 cutoff without an answer, so the agreed
    // fallback ships. What this guards is the debug artefact: an avatar named
    // GHOST parked in front of the spawn point, which would be the first thing
    // a judge sees. The decoder stays so the absence is proven, not assumed.
    const host = await run({ realmName: 'rainbowroad.dcl.eth' })
    const d = decoder()
    const ghosts = decoded(inventory(host.frames, d), AVATAR_SHAPE, (b) =>
      d.PBAvatarShape.decode(b)
    )
    assert.deepEqual(ghosts, [])
  }
)

test(
  'the pad grid follows the canvas the renderer reports: a band in portrait, a column on its side',
  { skip: !existsSync(BUNDLE) },
  async () => {
    // The renderer reserves the left edge for its own chat, profile and emote
    // buttons on mobile, and reports it in interactableArea. A layout that only
    // honoured the device inset drew the pads underneath those buttons.
    const portrait = await run(
      { realmName: 'rainbowroad.dcl.eth' },
      { width: 390, height: 844, screenInsetArea: { top: 47, right: 0, bottom: 34, left: 0 } }
    )
    const landscape = await run(
      { realmName: 'rainbowroad.dcl.eth' },
      {
        width: 844,
        height: 390,
        screenInsetArea: { top: 0, right: 47, bottom: 0, left: 47 },
        interactableArea: { top: 0, right: 0, bottom: 30, left: 120 }
      }
    )
    const d = decoder()
    const padWidths = (host: Host) => {
      const put = inventory(host.frames, d)
      const labels = put.get(UI_TEXT) ?? new Map<number, Uint8Array>()
      // A pad is the parent of one of the eight labels, and every UiTransform
      // names its parent on the wire - so the label leads to the pad, with no
      // guessing about how react-ecs numbers entities.
      const padLabelEntities = [...labels]
        .filter(([, b]) => EMOTES.some((e) => e.label === d.PBUiText.decode(b).value))
        .map(([e]) => e)
      const transforms = put.get(UI_TRANSFORM) ?? new Map<number, Uint8Array>()
      const widths = new Set<number>()
      for (const e of padLabelEntities) {
        const own = transforms.get(e)
        const parentId = own ? d.PBUiTransform.decode(own).parent : undefined
        const pad = parentId === undefined ? undefined : transforms.get(parentId)
        if (pad) widths.add(d.PBUiTransform.decode(pad).width ?? -1)
      }
      return widths
    }
    const p = padWidths(portrait)
    const l = padWidths(landscape)
    assert.equal(p.size, 1, `portrait pads should share one width, got ${[...p].join(',')}`)
    assert.equal(l.size, 1, `landscape pads should share one width, got ${[...l].join(',')}`)
    assert.notDeepEqual([...p], [...l], 'the grid did not change shape with the canvas')
  }
)
