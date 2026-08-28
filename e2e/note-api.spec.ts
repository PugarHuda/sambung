import { test, expect } from '@playwright/test'
import { API, urlFor, onOrigin, call } from './helpers.ts'

// The beacon endpoint, from a browser page: the scene's console made reachable.
// Same rules as the record: cross-origin, so CORS is enforced by the engine
// running the test, and every write lands in the real store under a world
// keyed to this test and retry.

const NOTE = API.replace(/\/api\/chain$/, '/api/note')
const noteUrl = (u: string) => u.replace(API, NOTE)

const post = (payload: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
})

type Note = { at: string; kind: string; platform: string; detail?: string }
const notesOf = (body: unknown) => (body as { notes: Note[] }).notes

test.describe('beacon endpoint', () => {
  test('a world with nothing reported reads as empty', async ({ page }, testInfo) => {
    await onOrigin(page)
    const r = await call(page, noteUrl(urlFor(testInfo, 'note-empty')))
    expect(r.error, 'a CORS rejection would surface here').toBeUndefined()
    expect(r.status).toBe(200)
    expect(notesOf(r.body)).toEqual([])
  })

  test('what a scene reports comes back newest first, and only the allowed shape', async ({
    page
  }, testInfo) => {
    await onOrigin(page)
    const url = noteUrl(urlFor(testInfo, 'note-life'))

    const arrive = await call(page, url, post({ kind: 'arrive', platform: 'mobile' }))
    expect(arrive.status).toBe(200)
    expect((arrive.body as { stored: boolean }).stored).toBe(true)

    const err = await call(
      page,
      url,
      post({ kind: 'error', platform: 'mobile', detail: 'x'.repeat(500) })
    )
    expect(err.status).toBe(200)

    const read = await call(page, url)
    const notes = notesOf(read.body)
    expect(notes.length).toBe(2)
    expect(notes[0]?.kind, 'newest first').toBe('error')
    expect(notes[0]?.detail?.length, 'detail is clamped, not refused').toBe(160)
    expect(notes[1]?.kind).toBe('arrive')
    expect(notes[1]?.platform).toBe('mobile')
    for (const n of notes) {
      expect(Object.keys(n).sort()).toEqual(
        expect.arrayContaining(['at', 'kind', 'platform'].sort())
      )
      expect(n).not.toHaveProperty('user')
      expect(n).not.toHaveProperty('ip')
    }
  })

  test('anything off the allow-list is refused, never stored', async ({ page }, testInfo) => {
    await onOrigin(page)
    const url = noteUrl(urlFor(testInfo, 'note-bad'))
    for (const payload of [
      { kind: 'pageview', platform: 'mobile' },
      { kind: 42 },
      { platform: 'mobile' },
      null,
      'arrive'
    ]) {
      const r = await call(page, url, post(payload))
      expect(r.status, `${JSON.stringify(payload)} must be refused`).toBe(400)
    }
    expect(notesOf((await call(page, url)).body)).toEqual([])
  })

  test('a player who was never asked for a name is never recorded by one', async ({
    page
  }, testInfo) => {
    await onOrigin(page)
    const url = noteUrl(urlFor(testInfo, 'note-privacy'))
    // Extra fields a buggy or hostile client might send are dropped on the floor.
    const r = await call(
      page,
      url,
      post({ kind: 'first_tap', platform: 'mobile', user: '0xabc', name: 'Lynx', ip: '1.2.3.4' })
    )
    expect(r.status).toBe(200)
    const [n] = notesOf((await call(page, url)).body)
    expect(n).toBeTruthy()
    expect(JSON.stringify(n)).not.toMatch(/0xabc|Lynx|1\.2\.3\.4/)
  })
})
