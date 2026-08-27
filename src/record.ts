// The persisted half of Sambung: the record chain and who built it.
// No DCL or network imports on purpose — plain `node --test` covers this file,
// and the trust-boundary parsing below is the reason it must be covered.

/** One emote in a chain, plus the player who added it (the future ghost). */
export type Link = { emote: number; user: string; name: string }

/** A run of the game: a chain and its length. */
export type Stint = { record: number; chain: Link[] }

/**
 * What a world reports. `record`/`chain` are the all-time best and never reset -
 * blanking them could empty the world in the middle of a judging window. `week`
 * is the best of the current ISO week, which is the target worth coming back for.
 */
export type Snapshot = Stint & { week?: Stint }

export const EMPTY: Snapshot = { record: 0, chain: [] }

import { EMOTES } from './game.ts'

/**
 * Emote indexes are positions in EMOTES. Derived, never hardcoded: a literal here
 * would drift the moment a pad is added and let an out-of-range index reach
 * EMOTES[...] in the scene.
 */
const MAX_EMOTE = EMOTES.length
/** A chain nobody could ever repeat is a sign of a forged payload, not a hero. */
const MAX_CHAIN = 200
const MAX_NAME = 40

function isLink(v: unknown): v is Link {
  if (typeof v !== 'object' || v === null) return false
  const l = v as Record<string, unknown>
  return (
    typeof l.emote === 'number' &&
    Number.isInteger(l.emote) &&
    l.emote >= 0 &&
    l.emote < MAX_EMOTE &&
    typeof l.user === 'string' &&
    typeof l.name === 'string'
  )
}

/**
 * Trust boundary. The scene talks to a public endpoint, so a response is
 * untrusted input until proven otherwise — returns null rather than throwing,
 * because a bad snapshot must degrade to "no record yet", never to a crash.
 */
function parseStint(raw: unknown): Stint | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.chain)) return null
  if (o.chain.length > MAX_CHAIN) return null
  if (!o.chain.every(isLink)) return null
  if (typeof o.record !== 'number' || !Number.isInteger(o.record)) return null
  // The record IS the chain's length; a mismatch means someone edited one half.
  if (o.record !== o.chain.length) return null
  return {
    record: o.record,
    chain: o.chain.map((l) => ({
      emote: l.emote,
      user: l.user.slice(0, MAX_NAME),
      name: l.name.slice(0, MAX_NAME)
    }))
  }
}

export function parseSnapshot(raw: unknown): Snapshot | null {
  const all = parseStint(raw)
  if (!all) return null
  // A malformed weekly block is dropped rather than failing the whole payload:
  // the all-time record is what the scene cannot do without.
  const week = parseStint((raw as Record<string, unknown>).week)
  return week ? { ...all, week } : all
}

/**
 * Keep whichever snapshot is the longer run. Ties keep what we already had.
 *
 * The weekly block is not merged by length: the endpoint owns the calendar, and
 * a week that has just rolled over correctly reports zero. Taking the maximum
 * would pin last week's target on the ticker forever. So the week always comes
 * from the newer side when it has one - a locally built snapshot has none, and
 * must not erase what the endpoint last said.
 */
export function betterOf(mine: Snapshot, theirs: Snapshot): Snapshot {
  const best = theirs.record > mine.record ? theirs : mine
  const week = theirs.week ?? mine.week
  const merged: Snapshot = { record: best.record, chain: best.chain }
  return week ? { ...merged, week } : merged
}

/**
 * The record key for the world the scene is actually running in.
 *
 * Hardcoding it meant two silent failures waiting to happen: a local preview
 * wrote its practice runs straight into the live world's record, and the day the
 * organiser moves the scene to another World the scene would keep reading the
 * old one. The realm knows both answers, so ask it.
 */
export function worldKey(
  realm: { realmName?: string; isPreview?: boolean } | undefined,
  fallback: string
): string {
  const name = (realm?.realmName ?? '').trim() || fallback
  return realm?.isPreview ? `preview-${name.toLowerCase()}` : name.toLowerCase()
}

/**
 * Text that arrived from another player, cut to something a UI line can hold.
 *
 * Names and labels ride the MessageBus, which anyone in the world can write to,
 * and they land directly in the ticker.
 */
export function clampText(raw: unknown, max = MAX_NAME): string {
  return typeof raw === 'string' ? raw.slice(0, max) : ''
}

/** Authors travelling beside a chain, trimmed to the chain they describe. */
export function parseAuthors(raw: unknown, len: number): { user: string; name: string }[] {
  const list: unknown[] = Array.isArray(raw) ? (raw as unknown[]) : []
  const out: { user: string; name: string }[] = []
  for (let i = 0; i < len; i++) {
    const v = list[i]
    const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
    out.push({ user: clampText(o.user) || 'anon', name: clampText(o.name) || 'Someone' })
  }
  return out
}

/** Distinct contributors, for "built by 9 players". */
export function builders(s: Snapshot): number {
  return new Set(s.chain.map((l) => l.user)).size
}

/**
 * Step the opening record playback. Returns the next index to light, or -1 when
 * the playback is over. `max` caps how much of a long record is replayed.
 */
export function demoAdvance(idx: number, chainLen: number, max: number): number {
  const next = idx + 1
  return next >= Math.min(chainLen, max) ? -1 : next
}

/**
 * Whether the arrival replay may start. The record arrives over the network, so
 * it can land seconds after the player already began — replaying then would seize
 * the pads mid-game and look like a freeze. A replay is a welcome or it is nothing.
 */
export function shouldPlayDemo(record: number, played: boolean, chainLen: number): boolean {
  return record > 0 && !played && chainLen === 0
}

/**
 * The ISO-8601 week a moment falls in, as "YYYY-Www".
 *
 * ISO weeks start on Monday and belong to the year containing their Thursday,
 * which is why the first days of January can belong to the previous year's last
 * week. The endpoint stamps records with this so a weekly target can reset while
 * the all-time record stays untouched.
 */
export function isoWeek(at: Date): string {
  // Work on a UTC copy shifted to the Thursday of the same week; that Thursday
  // decides both the year and the week number.
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
