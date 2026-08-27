import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { Scene } from '@dcl/schemas'
import { EMOTES } from './game.ts'

// scene.json is the one file in this project with no compiler behind it: a
// misspelt permission, a malformed spawn point or a stray field is accepted by
// the deploy and only shows up as a scene that behaves oddly in the world. The
// validator the content server itself uses ships inside @dcl/schemas, which is
// already installed as part of @dcl/sdk - so the same check runs here, and the
// same types make the rest of this file readable instead of a pile of casts.

const raw: unknown = JSON.parse(readFileSync('scene.json', 'utf8'))
const meta = raw as Scene

/** The stage is a cylinder of radius 6.5 at (8, 8); the pads ring it at 5.5. */
const CENTRE = 8
const RING = 5.5

test('scene.json passes the official Decentraland schema', () => {
  const valid = Scene.validate(raw)
  assert.ok(valid, JSON.stringify(Scene.validate.errors, null, 2))
})

test('the spawn region lands players on the stage, never off it', () => {
  const spawn = meta.spawnPoints?.[0]
  assert.ok(spawn?.default, 'a world with no default spawn point drops judges anywhere')
  const { x, y, z } = spawn.position
  // A range, not a point: a party game that stacks every arrival on one tile
  // looks broken before anyone has touched a pad.
  assert.ok(Array.isArray(x) && Array.isArray(y) && Array.isArray(z), 'spawn is a single point')
  for (const px of x) {
    for (const pz of z) {
      const dist = Math.hypot(px - CENTRE, pz - CENTRE)
      assert.ok(
        dist < RING,
        `spawn corner (${px}, ${pz}) is ${dist.toFixed(2)}m out, past the pads`
      )
    }
  }
  for (const py of y) assert.ok(py >= 0.2, 'spawning below the stage floor')
})

test('every restricted API the scene calls is declared', () => {
  // Normal scenes do not have these enforced today - only portable experiences
  // and smart wearables do - but the field is the scene's own statement of what
  // it touches, and a judge reading the repo should find it true.
  const source = readdirSync('src')
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'))
    .map((f) => readFileSync(join('src', f), 'utf8'))
    .join('\n')

  const needs: [RegExp, string][] = [
    [/\btriggerEmote\s*\(/, 'ALLOW_TO_TRIGGER_AVATAR_EMOTE'],
    [/\bfetch\s*\(/, 'USE_FETCH'],
    [/\bmovePlayerTo\s*\(/, 'ALLOW_TO_MOVE_PLAYER_INSIDE_SCENE'],
    [/\bopenExternalUrl\s*\(/, 'OPEN_EXTERNAL_LINK'],
    [/\bnew WebSocket\s*\(/, 'USE_WEBSOCKET']
  ]
  const declared: string[] = meta.requiredPermissions ?? []

  for (const [pattern, permission] of needs) {
    if (pattern.test(source)) {
      assert.ok(
        declared.includes(permission),
        `the scene calls ${pattern.source}, so it must declare ${permission}`
      )
    } else {
      assert.ok(!declared.includes(permission), `${permission} is declared but nothing needs it`)
    }
  }
})

test('the world stays the one the organiser granted, and the display copy fits', () => {
  assert.equal(meta.worldConfiguration?.name?.toLowerCase(), 'rainbowroad.dcl.eth')
  // The jump card and the Places listing both crop a long description
  // mid-sentence; measured against the real card at 130 characters.
  assert.ok((meta.display?.description ?? '').length <= 100, 'the jump card will truncate this')
  assert.equal(meta.display?.navmapThumbnail, 'images/thumbnail.png')
  assert.equal(meta.main, 'bin/index.js')
})

test('the tags that become the Places categories are the ones we claim', () => {
  // places.decentraland.org indexes a World from these; they are how a player
  // browsing the mobile Places list ever finds the scene at all.
  for (const tag of ['game', 'social', 'mobile', 'party']) {
    assert.ok(meta.tags.includes(tag), `missing tag ${tag}`)
  }
})

test('night is fixed, because the pads only read against a dark stage', () => {
  // Left to the world clock, the emissive pads wash out to flat circles at noon.
  const world = meta.worldConfiguration
  assert.ok(world, 'a World scene with no worldConfiguration deploys nowhere')
  assert.equal(world.skyboxConfig?.fixedTime, 79200)
  assert.equal(world.miniMapConfig?.visible, false)
  assert.equal(EMOTES.length, 8, 'the pad ring and the stage geometry assume eight')
})

test('a deploy would publish exactly these files, and nothing else', async () => {
  // The deploy walks the whole project folder, and .dclignore is the only thing
  // between server/.env.local and a public CDN. e2e/deployed-world.spec.ts
  // asserts the same list against the live World - but that is after the upload,
  // and a leaked credential cannot be un-uploaded. So the same question is asked
  // here, before, using the CLI's own file selection rather than a guess at it.
  const load = createRequire(import.meta.url)
  const { getPublishableFiles } = load('@dcl/sdk-commands/dist/logic/project-files.js') as {
    getPublishableFiles: (
      components: { fs: { readFile: (path: string, encoding: string) => Promise<string> } },
      projectRoot: string
    ) => Promise<string[]>
  }

  const files = await getPublishableFiles(
    { fs: { readFile: (path, encoding) => readFile(path, encoding as BufferEncoding) } },
    process.cwd()
  )
  const shipped = files.map((f) => f.split(sep).join('/')).sort()

  assert.deepEqual(shipped, [
    'LICENSE',
    'bin/index.js',
    'images/thumbnail.png',
    'main.crdt',
    'scene.json',
    'sounds/pad.wav'
  ])
})
