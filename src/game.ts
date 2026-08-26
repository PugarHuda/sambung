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
export function litIndex(s: State): number {
  return s.phase === 'showing' ? (s.chain[s.cursor] ?? -1) : -1
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
    while (s.timer >= SHOW_STEP) {
      s.timer -= SHOW_STEP
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
