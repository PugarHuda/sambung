// Sambung's beacon: the scene's console, but reachable.
//
// Every failure in the scene is deliberately non-fatal and lands in note(),
// which writes to a console nobody can see on a judge's phone. This endpoint
// is where those lines go instead, along with three facts that PRODUCT.md
// says must not be invented: that somebody arrived, that they tapped, and on
// what kind of client. Nothing here identifies a person - no user id, no
// name, no address is stored - only the kind of event, the platform string
// the client reports, and a short detail for errors.
//
// A capped Redis list per world: one LPUSH and one LTRIM per beacon, read
// with `npm run notes`. Two hundred entries is a week of judging.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Redis } from '@upstash/redis'

const KEY_PREFIX = 'sambung'
const DEFAULT_WORLD = 'rainbowroad.dcl.eth'
const KEEP = 200
const KINDS = new Set(['arrive', 'first_tap', 'record', 'invite', 'error'])
const MAX_DETAIL = 160
const MAX_PLATFORM = 24
/** Beacons a single caller may send per minute. A scene sends about three. */
const PER_MINUTE = 60
/** Small on purpose: a beacon is a line, not a payload. */
const MAX_BODY = 2 * 1024

type Beacon = { at: string; kind: string; platform: string; detail?: string }

const calls = new Map<string, { count: number; until: number }>()

function overLimit(ip: string, now: number): boolean {
  const slot = calls.get(ip)
  if (!slot || slot.until <= now) {
    calls.set(ip, { count: 1, until: now + 60_000 })
    for (const [key, v] of calls) if (v.until <= now) calls.delete(key)
    return false
  }
  slot.count++
  return slot.count > PER_MINUTE
}

function callerOf(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for']
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
  return first ?? req.socket.remoteAddress ?? ''
}

function keyFor(world: unknown): string {
  const w = typeof world === 'string' && world ? world : DEFAULT_WORLD
  return `${KEY_PREFIX}:notes:${w
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '')
    .slice(0, 64)}`
}

function store(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  return new Redis({ url, token })
}

/** Shape validation. Anything not on the allow-list is dropped, never coerced. */
function parseBeacon(raw: unknown, now: Date): Beacon | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind)) return null
  const platform =
    typeof o.platform === 'string' ? o.platform.slice(0, MAX_PLATFORM) || 'unknown' : 'unknown'
  const beacon: Beacon = { at: now.toISOString(), kind: o.kind, platform }
  if (typeof o.detail === 'string' && o.detail) beacon.detail = o.detail.slice(0, MAX_DETAIL)
  return beacon
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
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

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
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
  const key = keyFor(new URL(req.url ?? '/', 'http://sambung.local').searchParams.get('world'))
  const redis = store()
  // A beacon nobody can store is not worth an error to the scene.
  if (!redis) return send(200, { stored: false })

  if (req.method === 'GET') {
    // The reader. Newest first, which is how LPUSH leaves them.
    try {
      const notes = await redis.lrange<Beacon>(key, 0, KEEP - 1)
      return send(200, { notes })
    } catch {
      return send(200, { notes: [] })
    }
  }

  if (req.method === 'POST') {
    if (overLimit(callerOf(req), now.getTime())) {
      res.setHeader('Retry-After', '60')
      return send(429, { error: 'too many beacons from one place' })
    }
    let beacon: Beacon | null
    try {
      beacon = parseBeacon(JSON.parse(await readBody(req)), now)
    } catch {
      beacon = null
    }
    if (!beacon) return send(400, { error: 'malformed beacon' })
    try {
      const pipeline = redis.pipeline()
      pipeline.lpush(key, JSON.stringify(beacon))
      pipeline.ltrim(key, 0, KEEP - 1)
      await pipeline.exec()
      return send(200, { stored: true })
    } catch {
      // The scene fires and forgets; a 5xx here is retried once and dropped.
      return send(503, { error: 'store unavailable' })
    }
  }

  return send(405, { error: 'method not allowed' })
}
