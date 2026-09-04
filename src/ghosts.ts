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

/**
 * The arc the builders stand on, in radians, measured about the stage centre.
 *
 * Photographed on the deployed World 2026-09-04, the old full-width arc
 * (0.18pi..0.82pi) put a pair of builders at its two extremes - the worst case
 * for the commonest record. One landed behind the pad grid, which is drawn in
 * screen space over the right of the view in landscape, and was 90% hidden.
 *
 * So the arc is now the stage's LEFT rear as the visitor sees it. +X is screen
 * right (the hidden ghost was the +X one), the pad grid owns that side, and the
 * visitor's own avatar stands on the camera axis at the middle - which leaves
 * exactly this wedge free in both orientations.
 */
const ARC_FROM = Math.PI * 0.55
const ARC_TO = Math.PI * 0.95

/**
 * How far apart people stand, in metres, until the wedge runs out of room.
 * Wide enough that the floating names beside each head do not run into one
 * another, which at 1.6 they did.
 */
const SPACING = 2.0

export type GhostSlot = { user: string; name: string; x: number; z: number; yaw: number }

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
  // People stand a fixed distance apart and the group is centred, rather than
  // stretching to fill the wedge however few of them there are. Stretching sent
  // a pair - the commonest record by far - to the two far ends of the arc with
  // nothing between them, which is how one of them ended up out at the edge of
  // the frame. Only a full stage falls back to spreading out.
  const mid = (ARC_FROM + ARC_TO) / 2
  const step = Math.min(SPACING / radius, (ARC_TO - ARC_FROM) / Math.max(people.length - 1, 1))
  return people.map((p, i) => {
    const angle = mid + (i - (people.length - 1) / 2) * step
    return {
      ...p,
      x: center.x + Math.cos(angle) * radius,
      z: center.z + Math.sin(angle) * radius,
      yaw: facing(angle)
    }
  })
}

/**
 * The yaw, in degrees, that turns a ghost inward to face the stage centre - and
 * so the visitor standing on it.
 *
 * Transform carries no rotation until this existed, and identity points an
 * avatar at +Z. The visitor arrives looking along +Z too (scene.json aims the
 * camera at z=12), so every builder stood with their back to the person who
 * came to see them. A wall of backs is the opposite of the thing this feature
 * is for.
 *
 * Decentraland's space is left-handed with Y up, so a yaw of theta points an
 * entity along (sin theta, cos theta); solving that for the inward direction
 * (-cos angle, -sin angle) is the atan2 below.
 */
export function facing(angle: number): number {
  return (Math.atan2(-Math.cos(angle), -Math.sin(angle)) * 180) / Math.PI
}
