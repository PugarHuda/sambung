// Sambung's record store: one snapshot per world.
//
// Two records live here. The all-time best never resets — blanking it could empty
// a world in the middle of a judging window. The weekly best resets on the ISO
// week boundary and is the number worth coming back for. The clock is the
// server's alone: a scene could claim any week it liked.
//
// ponytail: no signature check. A determined forger can POST a fake record once
// (size-capped, so not an infinite one). Verifying the DCL auth chain via
// signedFetch is the upgrade path — worth doing only if the record actually gets
// vandalised during judging, not before.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { put, list, del } from '@vercel/blob'

const KEY_PREFIX = 'sambung-'
const MAX_EMOTE = 8
const MAX_CHAIN = 200
const MAX_NAME = 40
const DEFAULT_WORLD = 'rainbowroad.dcl.eth'

type Link = { emote: number; user: string; name: string }
type Stint = { record: number; chain: Link[] }
type Stored = Stint & { season: string; week: Stint }
type Reply = Stint & { week: Stint }

const NO_STINT: Stint = { record: 0, chain: [] }

/**
 * The ISO-8601 week of a moment, as "YYYY-Www". Weeks start on Monday and belong
 * to the year holding their Thursday. Mirrored from src/record.ts, where it is
 * unit-tested against the year boundaries; src/contract.test.ts holds the two
 * copies to the same shape.
 */
function isoWeek(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
  const dayFromMonday = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - dayFromMonday + 3)
  const thursdayYear = d.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(thursdayYear, 0, 4))
  const firstDayFromMonday = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayFromMonday + 3)
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000))
  return `${thursdayYear}-W${String(week).padStart(2, '0')}`
}

// Mirrors src/record.ts. Deliberately duplicated rather than shared: the scene
// and the endpoint deploy separately, and a validator you cannot see from the
// server is a validator you cannot trust.
function parseStint(raw: unknown): Stint | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.chain) || o.chain.length > MAX_CHAIN) return null
  if (typeof o.record !== 'number' || !Number.isInteger(o.record)) return null
  if (o.record !== o.chain.length) return null
  const chain: Link[] = []
  for (const v of o.chain) {
    if (typeof v !== 'object' || v === null) return null
    const l = v as Record<string, unknown>
    if (typeof l.emote !== 'number' || !Number.isInteger(l.emote)) return null
    if (l.emote < 0 || l.emote >= MAX_EMOTE) return null
    if (typeof l.user !== 'string' || typeof l.name !== 'string') return null
    chain.push({
      emote: l.emote,
      user: l.user.slice(0, MAX_NAME),
      name: l.name.slice(0, MAX_NAME)
    })
  }
  return { record: o.record, chain }
}

function parseStored(raw: unknown, now: Date): Stored | null {
  const all = parseStint(raw)
  if (!all) return null
  const o = raw as Record<string, unknown>
  const season = typeof o.season === 'string' ? o.season : isoWeek(now)
  const week = parseStint(o.week) ?? NO_STINT
  return { ...all, season, week }
}

/** World names come from the query string, so they are untrusted key material. */
function keyFor(world: unknown): string {
  const w = typeof world === 'string' && world ? world : DEFAULT_WORLD
  // No extension: versions live under this as a folder, and addRandomSuffix
  // inserts its suffix into the basename, so a key ending in .json would push
  // the random part outside the prefix we later list by.
  return (
    KEY_PREFIX +
    w
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, '')
      .slice(0, 64)
  )
}

function store() {
  // Injected by Vercel once the blob store is connected to this project.
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null
  return {
    async get(key: string, now: Date): Promise<Stored> {
      const fresh: Stored = { ...NO_STINT, season: isoWeek(now), week: NO_STINT }
      try {
        // Every write is a new immutable object, so the newest upload is the
        // truth. Overwriting one stable pathname was measured stale on 5 of 8
        // reads even with cache busting - object stores do not promise
        // read-after-write on replace, only on create.
        const found = await list({ prefix: `${key}/` })
        const newest = found.blobs.reduce<(typeof found.blobs)[number] | null>(
          (best, b) => (!best || b.uploadedAt > best.uploadedAt ? b : best),
          null
        )
        if (!newest) return fresh
        const r = await fetch(newest.url, { cache: 'no-store' })
        if (!r.ok) return fresh
        const parsed = parseStored(await r.json(), now) ?? fresh
        // Older versions are litter; dropping them keeps the listing small and
        // the next read cheap. Best effort - a failed cleanup must not fail a read.
        const stale = found.blobs.filter((b) => b.url !== newest.url).map((b) => b.url)
        if (stale.length) void del(stale).catch(() => undefined)
        return parsed
      } catch {
        // An unreachable or corrupt store reads as an empty world rather than a
        // 500, so the scene keeps playing on its local record.
        return fresh
      }
    },
    async set(key: string, value: Stored): Promise<void> {
      // A random suffix under the key's folder: never replacing an object is what
      // makes the next read consistent.
      await put(`${key}/v.json`, JSON.stringify(value), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: true,
        cacheControlMaxAge: 0
      })
    }
  }
}

/** What a caller sees: the all-time record, plus this week's target. */
function reply(stored: Stored, now: Date): Reply {
  const season = isoWeek(now)
  return {
    record: stored.record,
    chain: stored.chain,
    // A week that has rolled over reports empty without touching the all-time run.
    week: stored.season === season ? stored.week : NO_STINT
  }
}

/** Body is untrusted in size as well as shape, so cap it before buffering. */
const MAX_BODY = 64 * 1024

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    // Collected as bytes and decoded once at the end. Appending each chunk to a
    // string would decode at arbitrary byte boundaries, and a multi-byte name -
    // an emoji, kana, an accent - split across two chunks would come out corrupt.
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// Written against the Node function runtime: it hands you (req, res) and ignores
// any returned value. The edge runtime would allow web Request/Response instead,
// but @vercel/blob is not edge-compatible, so this is the signature that fits.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // The scene fetches cross-origin, so CORS is not optional here.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Content-Type', 'application/json')

  const send = (status: number, body: unknown) => {
    res.statusCode = status
    res.end(JSON.stringify(body))
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  const now = new Date()
  // req.url arrives relative ("/api/chain?world=..."), which new URL() rejects.
  // The base is a throwaway: it is ignored whenever the URL is already absolute.
  const key = keyFor(new URL(req.url ?? '/', 'http://sambung.local').searchParams.get('world'))
  const kv = store()
  // No store configured yet: behave like an empty world instead of 500ing, so
  // the scene degrades to local-only play rather than showing an error.
  if (!kv) return send(200, { ...NO_STINT, week: NO_STINT })

  if (req.method === 'GET') return send(200, reply(await kv.get(key, now), now))

  if (req.method === 'POST') {
    let incoming: Stint | null
    try {
      incoming = parseStint(JSON.parse(await readBody(req)))
    } catch {
      // Unreadable body or invalid JSON is the same answer as an invalid shape.
      incoming = null
    }
    if (!incoming) return send(400, { error: 'malformed snapshot' })

    const season = isoWeek(now)
    const current = await kv.get(key, now)
    // A rolled-over week starts from nothing, so the first run of a new week wins
    // it outright; within a week the target can only be beaten, never lowered.
    const weekBase = current.season === season ? current.week : NO_STINT

    const beatsAllTime = incoming.record > current.record
    const beatsWeek = incoming.record > weekBase.record
    if (!beatsAllTime && !beatsWeek) return send(200, reply(current, now))

    const next: Stored = {
      record: beatsAllTime ? incoming.record : current.record,
      chain: beatsAllTime ? incoming.chain : current.chain,
      season,
      week: beatsWeek ? incoming : weekBase
    }
    await kv.set(key, next)
    return send(200, reply(next, now))
  }

  return send(405, { error: 'method not allowed' })
}
