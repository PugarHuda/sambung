// Sambung's record store: the best chain a world has ever held, and the best of
// the current week.
//
// Backed by Redis, and shaped so that Redis does the hard part. Each record is a
// member of a sorted set scored by its own length, so "the record" is simply the
// top of the set. Two players who finish at the same moment both add a member
// and the higher score wins on its own - no read-modify-write, no lock, and no
// way for a slower write to erase a better one.
//
// The previous store was Vercel Blob, which has no compare-and-set: it needed a
// list of immutable versions merged by maximum on every read. That cost one list
// operation per read, and the project's own end-to-end suite spent the free
// allowance and suspended the store mid-week. This design is one command to read
// and four to write.
//
// ponytail: no signature check. A determined forger can POST a fake record once
// (size-capped, so not an infinite one). Verifying the DCL auth chain via
// signedFetch is the upgrade path - worth doing only if the record actually gets
// vandalised during judging, not before.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Redis } from '@upstash/redis'

const KEY_PREFIX = 'sambung'
const MAX_EMOTE = 8
const MAX_CHAIN = 200
const MAX_NAME = 40
const DEFAULT_WORLD = 'rainbowroad.dcl.eth'

/**
 * How long a week's key lives after it is written.
 *
 * Three weeks rather than one: a key that expired exactly on the boundary would
 * race the clock, and this way an old week simply ages out instead of needing a
 * reset written anywhere. Expiry is the whole of the weekly reset logic.
 */
const WEEK_TTL_SECONDS = 60 * 60 * 24 * 21

type Link = { emote: number; user: string; name: string }
type Stint = { record: number; chain: Link[] }
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

/** World names come from the query string, so they are untrusted key material. */
function keyFor(world: unknown): string {
  const w = typeof world === 'string' && world ? world : DEFAULT_WORLD
  return `${KEY_PREFIX}:${w
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '')
    .slice(0, 64)}`
}

function store(): Redis | null {
  // Injected by the Upstash integration. Both spellings exist depending on how
  // the store was attached, and a missing one is a configuration state rather
  // than an error: the endpoint answers as an empty world and the scene plays on.
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  return new Redis({ url, token })
}

/**
 * The top member of a sorted set, validated.
 *
 * The client parses JSON members on the way out, so a member arrives as an
 * object here and as a string only if that ever changes; both are handled
 * because a store that silently returns the wrong shape must read as "no record
 * yet" rather than take the scene down.
 */
async function top(redis: Redis, key: string): Promise<Stint> {
  const rows = await redis.zrange<unknown[]>(key, 0, 0, { rev: true })
  const raw = rows[0]
  if (raw === undefined) return NO_STINT
  const parsed = typeof raw === 'string' ? safeJson(raw) : raw
  return parseStint(parsed) ?? NO_STINT
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Add a run to a set and keep only the best member in it.
 *
 * Order matters and concurrency does not: whichever writer trims last, the
 * member left standing is the highest-scored one either of them added.
 */
function keepBest(pipeline: ReturnType<Redis['pipeline']>, key: string, run: Stint) {
  pipeline.zadd(key, { score: run.record, member: JSON.stringify(run) })
  pipeline.zremrangebyrank(key, 0, -2)
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
// any returned value. Returning a web Response instead makes the request hang
// until timeout rather than erroring, which is a confusing way to find out.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // The scene fetches cross-origin, so CORS is not optional here.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  // A day of preflight caching: the scene posts rarely, but every post it does
  // make would otherwise pay for an OPTIONS round trip first.
  res.setHeader('Access-Control-Max-Age', '86400')
  res.setHeader('Cache-Control', 'no-store')
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
  const weekKey = `${key}:w:${isoWeek(now)}`
  const redis = store()
  // No store configured: behave like an empty world instead of 500ing, so the
  // scene degrades to local-only play rather than showing an error.
  if (!redis) return send(200, { ...NO_STINT, week: NO_STINT })

  const read = async (): Promise<Reply> => {
    const [all, week] = await Promise.all([top(redis, key), top(redis, weekKey)])
    return { ...all, week }
  }

  if (req.method === 'GET') {
    try {
      return send(200, await read())
    } catch {
      // An unreachable store reads as an empty world rather than a 500: a record
      // nobody can fetch is a smaller problem than a scene that shows an error.
      return send(200, { ...NO_STINT, week: NO_STINT })
    }
  }

  if (req.method === 'POST') {
    let incoming: Stint | null
    try {
      incoming = parseStint(JSON.parse(await readBody(req)))
    } catch {
      // Unreadable body or invalid JSON is the same answer as an invalid shape.
      incoming = null
    }
    if (!incoming) return send(400, { error: 'malformed snapshot' })

    try {
      const pipeline = redis.pipeline()
      keepBest(pipeline, key, incoming)
      keepBest(pipeline, weekKey, incoming)
      // Refreshed on every write, so a week that is still being played stays
      // alive and one that nobody touches ages out on its own.
      pipeline.expire(weekKey, WEEK_TTL_SECONDS)
      await pipeline.exec()
      return send(200, await read())
    } catch {
      // Unlike a read, a failed write is not something to paper over: the scene
      // retries a 5xx, and the player's record is worth one more attempt.
      return send(503, { error: 'record store unavailable' })
    }
  }

  return send(405, { error: 'method not allowed' })
}
