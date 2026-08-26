// Retry policy for the record endpoint. No DCL imports, so it is unit-testable
// with the clock passed in rather than waited on.
//
// The scene's fetch is not the web one: RequestInit here accepts only body,
// headers, method, redirect and a DCL-specific `timeout`, and there is no
// AbortController. So the timeout below is handed to fetch itself, and the retry
// loop lives here.

/**
 * How long a single attempt may take.
 *
 * Long enough to survive a serverless cold start, which was measured at about
 * 2.5s on this endpoint, and short enough that three attempts cannot outlast a
 * visitor's patience.
 */
export const REQUEST_TIMEOUT_MS = 8000

export const MAX_ATTEMPTS = 3

/** Longest a backoff will ever wait, so a bad network cannot stall a queue. */
export const MAX_BACKOFF_MS = 4000

/**
 * How long to wait before attempt `attempt + 1`, given `attempt` just failed.
 * Exponential from 500ms, capped, so a flapping endpoint is not hammered.
 */
export function backoffDelay(attempt: number): number {
  if (attempt < 1) throw new Error(`attempt is 1-based, got ${attempt}`)
  return Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS)
}

/**
 * Run `task` until it resolves or the attempts run out, sleeping between tries.
 *
 * `sleep` is a parameter rather than a global timer so tests can drive the clock
 * instead of waiting on it. Retrying is only safe because the endpoint is
 * monotonic: re-sending the same record is a no-op, which the end-to-end suite
 * asserts under the name "a double submit must change nothing".
 */
export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  attempts: number = MAX_ATTEMPTS
): Promise<T> {
  if (attempts < 1) throw new Error(`attempts must be at least 1, got ${attempts}`)
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task(attempt)
    } catch (err) {
      last = err
      // No sleep after the final attempt: nothing follows it to wait for.
      if (attempt < attempts) await sleep(backoffDelay(attempt))
    }
  }
  throw last
}
