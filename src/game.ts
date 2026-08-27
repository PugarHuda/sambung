// Pure game state. No DCL imports here on purpose — this file is unit-testable
// with plain `node --test` (see game.test.ts).

export const EMOTES = [
  { id: 'wave', label: 'WAVE', hex: '#E63946' },
  { id: 'clap', label: 'CLAP', hex: '#F4A261' },
  { id: 'dab', label: 'DAB', hex: '#E9C46A' },
  { id: 'robot', label: 'ROBOT', hex: '#2A9D8F' },
  { id: 'shrug', label: 'SHRUG', hex: '#457B9D' },
  { id: 'kiss', label: 'KISS', hex: '#C77DFF' },
  { id: 'money', label: 'MONEY', hex: '#90BE6D' },
  { id: 'headexplode', label: 'BOOM', hex: '#F72585' }
] as const

export const SHOW_STEP = 0.75 // seconds each emote stays lit during playback
/** Below this the pads blur together and the chain stops being readable. */
export const MIN_SHOW_STEP = 0.32
/**
 * How much of each playback step the pad is actually lit for.
 *
 * The rest is dark on purpose. Without a gap, the same pad twice in a row -
 * [3, 3] - showed as one long light and one note, and a player who repeated it
 * once was told they missed. Simon has always had this gap; it is what makes a
 * repeated note countable.
 */
export const LIT_FRACTION = 0.65
/**
 * What the whole world does when somebody beats the record.
 *
 * Verified against the catalyst as a real base emote by the live-world suite: a
 * predefinedEmote that does not exist is not an error, the avatar just stands
 * there. Everyone present sees this, which is the point - the payoff for beating
 * a record should be visible to the room, not printed in your own ticker.
 */
export const CHEER_EMOTE = 'handsair'
export const FAIL_HOLD = 1.4 // seconds the "missed" state is held before retry
export const LIVES = 3 // misses a chain survives before its season closes

export type Phase = 'showing' | 'input' | 'choosing' | 'failed'

export type State = {
  phase: Phase
  chain: number[]
  /** showing: index being displayed. input: index expected next. */
  cursor: number
  timer: number
  /** Misses left before the season closes. */
  lives: number
  /** Longest chain ever successfully repeated. Outlives every season. */
  record: number
}

export function newState(): State {
  return { phase: 'choosing', chain: [], cursor: 0, timer: 0, lives: LIVES, record: 0 }
}

/** Emote index currently lit by the game itself, or -1. */
/**
 * How long each emote is held during playback, for a chain of this length.
 *
 * Simon's escalation, and the reason a long chain stays a game rather than a
 * memory exam: the sequence gets longer and faster at once. It also keeps the
 * record replay watchable - a twenty-link record at the opening speed is fifteen
 * seconds of cutscene before a visitor may touch anything.
 */
export function showStep(chainLength: number): number {
  return Math.max(MIN_SHOW_STEP, SHOW_STEP - 0.03 * (chainLength - 1))
}

export function litIndex(s: State): number {
  if (s.phase !== 'showing') return -1
  if (s.timer >= showStep(s.chain.length) * LIT_FRACTION) return -1
  return s.chain[s.cursor] ?? -1
}

export type TapResult = 'ignored' | 'correct' | 'completed' | 'added' | 'missed'

export function tap(s: State, i: number): TapResult {
  if (s.phase === 'choosing') {
    s.chain.push(i)
    s.phase = 'showing'
    s.cursor = 0
    s.timer = 0
    return 'added'
  }
  if (s.phase !== 'input') return 'ignored'

  if (s.chain[s.cursor] !== i) {
    s.phase = 'failed'
    s.timer = 0
    s.lives--
    return 'missed'
  }

  s.cursor++
  if (s.cursor < s.chain.length) return 'correct'

  // Whole chain repeated: you earn the right to extend it.
  // Only a chain you actually repeated counts as the record.
  s.record = Math.max(s.record, s.chain.length)
  s.phase = 'choosing'
  s.timer = 0
  return 'completed'
}

export function tick(s: State, dt: number): void {
  s.timer += dt

  if (s.phase === 'showing') {
    const step = showStep(s.chain.length)
    while (s.timer >= step) {
      s.timer -= step
      s.cursor++
      if (s.cursor >= s.chain.length) {
        s.phase = 'input'
        s.cursor = 0
        s.timer = 0
        return
      }
    }
    return
  }

  if (s.phase === 'failed' && s.timer >= FAIL_HOLD) {
    s.cursor = 0
    s.timer = 0
    if (s.lives > 0) {
      // Friendlier than classic Simon: the chain survives, you just replay it.
      s.phase = 'showing'
      return
    }
    // Out of lives: the season closes. The chain dies, the record does not —
    // that surviving number is the reason to come back tomorrow.
    s.chain = []
    s.lives = LIVES
    s.phase = 'choosing'
  }
}

/**
 * Merge a chain broadcast by another player. Longest chain wins, which is enough
 * to converge without any turn arbitration.
 * ponytail: last-write-wins on equal length; add a server tiebreak only if
 * simultaneous extensions actually show up in playtests.
 */
export function adopt(s: State, incoming: number[]): boolean {
  if (incoming.length <= s.chain.length) return false
  s.chain = incoming.slice()
  s.phase = 'showing'
  s.cursor = 0
  s.timer = 0
  return true
}

/**
 * Longest live chain a peer may broadcast. Far above anything human hands could
 * repeat, low enough that a forged payload cannot make the stage unplayable.
 */
export const MAX_LIVE_CHAIN = 200

/**
 * A chain arriving over MessageBus, or null if it is not one.
 *
 * Comms is a trust boundary exactly like the record endpoint: anyone in the
 * world can emit on the bus, and the payload lands straight in state.chain,
 * which then indexes EMOTES and drives the pads. An out-of-range index would
 * light nothing and never be tappable - the round would simply hang - and a
 * hundred-thousand-long array would freeze the stage.
 */
export function parseChain(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_LIVE_CHAIN) return null
  const out: number[] = []
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= EMOTES.length) return null
    out.push(v)
  }
  return out
}
