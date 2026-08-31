// The builders of the record, standing on the stage and performing their own
// links.
//
// A judge visits alone - the buildathon says so - yet Social Value is scored.
// The chain is a shared object built by many people over time, and until now the
// only trace of that on screen was a line of text. These are those people: one
// avatar per builder, each performing the link they actually added.
//
// Two facts the 2026-08-31 spike paid for, both of which this file depends on:
//
//   1. AvatarShape DOES render inside a normal scene. The proto comment saying
//      it "is only actually used in the global Avatar Scene" is wrong.
//   2. expressionTriggerId must be a FULL URN. The short id that triggerEmote()
//      takes - 'robot' - renders a frozen avatar in the rest pose, silently. The
//      two APIs disagree about the same argument, so EMOTE_URN is the only place
//      an emote name is built for an avatar.
//
// Wearables are passed explicitly for the same reason: the proto documents a
// default for every unfilled slot, and the client ignored it and drew a naked
// body. A naked mannequin on stage would be worse than no ghost at all.

// No DCL imports, so the placement arithmetic is unit-testable with plain
// `node --test` - the same split layout.ts keeps. The entities themselves are
// built in index.ts, beside the rest of the stage.
import type { Link } from './record.ts'

/** Emote ids become URNs for an avatar, and stay bare for triggerEmote(). */
export const EMOTE_URN = 'urn:decentraland:off-chain:base-emotes:'

/**
 * The per-slot wearables the proto promises as defaults and the client did not
 * supply. Explicit, because undressed is the failure mode.
 */
export const WEARABLES = [
  'urn:decentraland:off-chain:base-avatars:f_eyes_00',
  'urn:decentraland:off-chain:base-avatars:f_eyebrows_00',
  'urn:decentraland:off-chain:base-avatars:f_mouth_00',
  'urn:decentraland:off-chain:base-avatars:standard_hair',
  'urn:decentraland:off-chain:base-avatars:f_simple_yellow_tshirt',
  'urn:decentraland:off-chain:base-avatars:f_brown_trousers',
  'urn:decentraland:off-chain:base-avatars:bun_shoes'
]

/**
 * How many builders can stand on the stage.
 *
 * ponytail: a semicircle of six reads as a crowd; past that they overlap and
 * each one costs the client an avatar to skin. Raise it if a record ever has
 * more builders than this and the stage still looks empty.
 */
export const MAX_GHOSTS = 6

/** The far arc, in radians: sin is positive, so every ghost stands at z > centre. */
const ARC_FROM = Math.PI * 0.18
const ARC_TO = Math.PI * 0.82

export type GhostSlot = { user: string; name: string; x: number; z: number }

/**
 * Who stands where.
 *
 * Distinct builders in the order they first appear in the chain, so the person
 * who started the record stands at one end and the story reads along the arc.
 * Pure, so the arithmetic is unit-tested without a renderer.
 */
export function ghostPlan(
  chain: Link[],
  max = MAX_GHOSTS,
  center = { x: 8, z: 8 },
  radius = 3.8
): GhostSlot[] {
  const seen = new Map<string, string>()
  for (const link of chain) {
    if (!link.user || seen.has(link.user)) continue
    seen.set(link.user, link.name)
    if (seen.size >= max) break
  }
  const people = [...seen].map(([user, name]) => ({ user, name }))
  return people.map((p, i) => {
    // One builder stands centre stage rather than at the end of an arc of one.
    const t = people.length > 1 ? i / (people.length - 1) : 0.5
    const angle = ARC_FROM + (ARC_TO - ARC_FROM) * t
    return {
      ...p,
      x: center.x + Math.cos(angle) * radius,
      z: center.z + Math.sin(angle) * radius
    }
  })
}
