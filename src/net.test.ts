import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backoffDelay, withRetry, MAX_ATTEMPTS, MAX_BACKOFF_MS } from './net.ts'

/** Records what was slept for instead of actually waiting. */
function clock() {
  const waits: number[] = []
  return {
    waits,
    sleep: (ms: number) => {
      waits.push(ms)
      return Promise.resolve()
    }
  }
}

test('backoff grows exponentially and then stops growing', () => {
  assert.equal(backoffDelay(1), 500)
  assert.equal(backoffDelay(2), 1000)
  assert.equal(backoffDelay(3), 2000)
  assert.equal(backoffDelay(4), 4000)
  assert.equal(backoffDelay(5), MAX_BACKOFF_MS, 'the cap holds')
  assert.equal(backoffDelay(50), MAX_BACKOFF_MS)
})

test('backoff rejects an attempt number that is not 1-based', () => {
  assert.throws(() => backoffDelay(0), /1-based/)
  assert.throws(() => backoffDelay(-1), /1-based/)
})

test('a task that succeeds first time is never retried and never sleeps', async () => {
  const c = clock()
  let calls = 0
  const result = await withRetry(() => {
    calls++
    return Promise.resolve('ok')
  }, c.sleep)
  assert.equal(result, 'ok')
  assert.equal(calls, 1)
  assert.deepEqual(c.waits, [], 'a healthy call must not delay the scene')
})

test('a task that recovers is retried with growing pauses', async () => {
  const c = clock()
  const seen: number[] = []
  const result = await withRetry((attempt) => {
    seen.push(attempt)
    return attempt < 3 ? Promise.reject(new Error('flaky')) : Promise.resolve('ok')
  }, c.sleep)
  assert.equal(result, 'ok')
  assert.deepEqual(seen, [1, 2, 3], 'the attempt number is passed through')
  assert.deepEqual(c.waits, [500, 1000])
})

test('a task that never recovers throws the last error after the final attempt', async () => {
  const c = clock()
  let calls = 0
  await assert.rejects(
    withRetry(() => {
      calls++
      return Promise.reject(new Error(`down ${calls}`))
    }, c.sleep),
    /down 3/,
    'the surfaced error must be the most recent one'
  )
  assert.equal(calls, MAX_ATTEMPTS)
  assert.equal(c.waits.length, MAX_ATTEMPTS - 1, 'no sleep after the last attempt')
})

test('a single-attempt policy never sleeps', async () => {
  const c = clock()
  await assert.rejects(
    withRetry(() => Promise.reject(new Error('nope')), c.sleep, 1),
    /nope/
  )
  assert.deepEqual(c.waits, [])
})

test('an attempt budget below one is refused rather than silently skipped', async () => {
  const c = clock()
  await assert.rejects(
    withRetry(() => Promise.resolve(1), c.sleep, 0),
    /at least 1/
  )
})

test('a task rejecting with a non-Error still surfaces', async () => {
  const c = clock()
  // Rejecting with a non-Error is the condition under test: a runtime that throws
  // a bare string must not be swallowed by the retry loop.
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberate: see above
    withRetry(() => Promise.reject('a bare string'), c.sleep, 1),
    (err: unknown) => err === 'a bare string'
  )
})
