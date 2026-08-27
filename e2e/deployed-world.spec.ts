import { test, expect, APIRequestContext, APIResponse } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { Scene } from '@dcl/schemas'

// Checks the World as a visitor's client sees it, not as the repo hopes it is.
//
// This is the only suite that can catch a deploy that never happened, a deploy
// that shipped the wrong bundle, or a credential leaked into the public content
// server. It found the first one for real: on 2026-08-27 the live scene was
// still the build from three days earlier, so the night skybox, the readable pad
// labels and the safe-area UI were all sitting in git and nowhere else.
//
// Not part of `npm run test:e2e` and not in CI: it asserts things about
// production that are only true after a deploy. Run it with `npm run verify` as
// the last step of deploying.

const WORLD = 'rainbowroad.dcl.eth'
const WALLET = '0x39d2bae5eaeda9283535ddc98f1991c81ed5cd7e'
const CONTENT = 'https://worlds-content-server.decentraland.org'
const CATALYST = 'https://peer.decentraland.org'
const PLACES = 'https://places.decentraland.org/api'

const scene = JSON.parse(readFileSync('scene.json', 'utf8')) as Scene

/** Exactly what a scene deploy is allowed to publish. Anything else is a leak. */
const SHIPPED = ['LICENSE', 'bin/index.js', 'images/thumbnail.png', 'scene.json', 'sounds/pad.wav']
/** Written by the SDK, sometimes empty, so it is allowed but not required. */
const OPTIONAL = ['main.crdt']

type ContentFile = { file: string; hash: string }
type DeployedEntity = { content: ContentFile[]; metadata: Scene }
type Permissions = { permissions: { deployment: { wallets: string[] }; access: { type: string } } }
type PlaceRow = {
  world_name?: string
  show_in_places?: boolean
  title?: string
  description?: string
  categories?: string[]
}

/** Every response here is untyped JSON off a public API; name the shape once. */
async function json<T>(res: APIResponse): Promise<T> {
  expect(res.status(), `${res.url()} did not answer with 200`).toBe(200)
  return (await res.json()) as T
}

async function deployed(request: APIRequestContext): Promise<DeployedEntity> {
  const entities = await json<DeployedEntity[]>(
    await request.post(`${CONTENT}/entities/active`, { data: { pointers: [WORLD] } })
  )
  expect(entities.length, `no scene is deployed to ${WORLD}`).toBe(1)
  return entities[0] as DeployedEntity
}

async function content(request: APIRequestContext, hash: string): Promise<Buffer> {
  const res = await request.get(`${CONTENT}/contents/${hash}`)
  expect(res.status(), `${hash} is in the manifest but not served`).toBe(200)
  return Buffer.from(await res.body())
}

test.describe('the live world', () => {
  test('every pad plays an emote the platform actually has', async ({ request }) => {
    // triggerEmote takes a bare string. A typo in one of these ids is not an
    // error anywhere - the avatar simply stands still - so the ids are checked
    // against the catalyst that serves them, which is the only authority.
    const source = readFileSync('src/game.ts', 'utf8')
    const ids = [...source.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1])
    expect(ids.length, 'no emote ids found in src/game.ts').toBe(8)

    const emotes = await json<{ metadata?: { name?: string } }[]>(
      await request.post(`${CATALYST}/content/entities/active`, {
        data: { pointers: ids.map((id) => `urn:decentraland:off-chain:base-emotes:${id}`) }
      })
    )
    const found = emotes.map((e) => e.metadata?.name)
    for (const id of ids) {
      expect(found, `"${id}" is not a base emote - the pad would do nothing`).toContain(id)
    }
  })

  test('the organiser still lets this wallet deploy, and visitors still get in', async ({
    request
  }) => {
    // Both halves are judging-critical and both belong to someone else: the World
    // is borrowed, and its owner can change either at any time.
    const { permissions } = await json<Permissions>(
      await request.get(`${CONTENT}/world/${WORLD}/permissions`)
    )
    expect(permissions.deployment.wallets.map((w) => w.toLowerCase())).toContain(WALLET)
    expect(permissions.access.type, 'a restricted world cannot be judged').toBe('unrestricted')
  })

  test('the deployed scene is the one in this repo', async ({ request }) => {
    const { metadata } = await deployed(request)

    expect(metadata.display?.title).toBe(scene.display?.title)
    expect(metadata.display?.description, 'the deployed description is stale - redeploy').toBe(
      scene.display?.description
    )
    expect(metadata.requiredPermissions ?? []).toEqual(scene.requiredPermissions)
    expect(
      metadata.worldConfiguration?.skyboxConfig?.fixedTime,
      'the world is not fixed to night'
    ).toBe(scene.worldConfiguration?.skyboxConfig?.fixedTime)
    expect(metadata.worldConfiguration?.miniMapConfig?.visible).toBe(false)
    expect(metadata.spawnPoints, 'the spawn region is stale').toEqual(scene.spawnPoints)
    expect(metadata.tags).toEqual(scene.tags)
  })

  test('the deployed bundle is byte-for-byte the one that was built here', async ({ request }) => {
    const entity = await deployed(request)
    const bundle = entity.content.find((f) => f.file === 'bin/index.js')
    if (!bundle) throw new Error('no bundle in the deployed manifest')

    const live = await content(request, bundle.hash)
    const local = readFileSync('bin/index.js')
    // Compared by length first: a mismatch message with two 400 KB strings in it
    // is unreadable, and the length alone already names the problem.
    expect(live.length, 'the deployed bundle is a different build - redeploy').toBe(local.length)
    expect(live.equals(local), 'the deployed bundle differs from the local build').toBe(true)
  })

  test('nothing private ever reached the public content server', async ({ request }) => {
    const entity = await deployed(request)
    const files = entity.content.map((f) => f.file)

    // The endpoint's blob token lives in server/.env.local, and the whole project
    // folder is what a deploy walks. .dclignore is the only thing standing between
    // that token and a public CDN, so the guard is asserted against production.
    for (const file of files) {
      expect(file, `${file} should never have been deployed`).not.toMatch(
        /^(server|src|e2e|node_modules|scripts)\/|\.env|\.vercel|\.ts$|\.mjs$|tsconfig|composite/
      )
      expect([...SHIPPED, ...OPTIONAL], `unexpected file in the deploy: ${file}`).toContain(file)
    }
    for (const required of SHIPPED) {
      expect(files, `${required} is missing from the deploy`).toContain(required)
    }
  })

  test('the audio clip the scene plays is actually served', async ({ request }) => {
    const entity = await deployed(request)
    const clip = entity.content.find((f) => f.file === 'sounds/pad.wav')
    if (!clip) throw new Error('the pads have no sound in the deployed world')

    const body = await content(request, clip.hash)
    // A file that is served but is not a RIFF/WAVE stream plays as silence, and
    // the client says nothing about it.
    expect(body.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(body.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(body.equals(readFileSync('sounds/pad.wav'))).toBe(true)
  })

  test('the world is findable in Places, with the copy we wrote', async ({ request }) => {
    // Places is how a phone player browsing Decentraland ever arrives here, and
    // it indexes from the deploy - so a stale deploy is also a stale listing.
    const { data } = await json<{ data: PlaceRow[] }>(
      await request.get(`${PLACES}/worlds?search=rainbowroad&limit=5`)
    )
    const place = data.find((p) => p.world_name?.toLowerCase() === WORLD)
    expect(place, 'the world is not indexed in Places').toBeTruthy()
    expect(place?.show_in_places, 'the world is hidden from Places').toBe(true)
    expect(place?.title).toBe(scene.display?.title)
    expect(place?.description, 'the Places listing is stale - redeploy').toBe(
      scene.display?.description
    )
    expect(place?.categories).toEqual(expect.arrayContaining(scene.tags ?? []))
  })
})
