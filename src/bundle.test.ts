import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

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
  emotes: string[]
  fetched: string[]
  realmAsked: number
  errors: string[]
}
type Scene = { onStart?: () => Promise<void>; onUpdate?: (dt: number) => Promise<void> }

/** Nothing on the wire: the stub answers every RPC with an empty payload. */
function boot(realm: { realmName: string; isPreview?: boolean }): { scene: Scene; host: Host } {
  const host: Host = {
    crdtCalls: 0,
    emotes: [],
    fetched: [],
    realmAsked: 0,
    errors: []
  }
  const empty = { data: [] as Uint8Array[] }

  const systems: Record<string, unknown> = {
    '~system/EngineApi': {
      // Plain promises rather than async functions: nothing here awaits, and a
      // stub that pretends to is just noise the linter has to read past.
      crdtSendToRenderer: () => {
        host.crdtCalls++
        return Promise.resolve(empty)
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

  runInContext(readFileSync(BUNDLE, 'utf8'), context, { filename: BUNDLE })
  // The host object is handed back by reference, not copied: the counters are
  // written by the stubs long after boot returns.
  return { scene: module.exports, host }
}

/** Boot, then run a second of frames so the async work has somewhere to land. */
async function run(realm: { realmName: string; isPreview?: boolean }): Promise<Host> {
  const { scene, host } = boot(realm)
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
