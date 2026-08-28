#!/usr/bin/env node
// Runs the record endpoint on localhost, against the real store.
//
// Vercel's free plan caps deployments per day, and this project has hit that cap
// twice at exactly the wrong moment. The handler is a plain (req, res) Node
// function, so it needs no platform to run - which means the end-to-end suite
// can be pointed at it with SAMBUNG_API and every semantic can be proven before
// a deployment slot is spent on it.
//
//   node scripts/serve-endpoint.mjs
//   SAMBUNG_API=http://127.0.0.1:8787/api/chain npx playwright test --project=chromium
//
// It also serves a blank page on the next port up, and the suite loads that page
// to call from. Chrome refuses a request to the loopback address space unless
// the caller is genuinely there too, and a page Playwright fulfils out of thin
// air does not count - every call comes back "Failed to fetch" with the real
// reason only visible in the browser console.
//
// It reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN from the
// environment, exactly as the deployed function does. With neither set it still
// serves, answering as an empty world - which is itself worth being able to try.

import { createServer } from 'node:http'
import chain from '../server/api/chain.ts'
import note from '../server/api/note.ts'

const port = Number(process.env.PORT ?? 8787)

const server = createServer((req, res) => {
  // Anything that escapes the handler would otherwise hang the socket until the
  // client gives up, which reads as a network fault rather than a bug.
  // The same two routes Vercel serves from server/api.
  const handler = (req.url ?? '').startsWith('/api/note') ? note : chain
  Promise.resolve(handler(req, res)).catch((err) => {
    console.error('handler threw:', err)
    if (!res.headersSent) res.statusCode = 500
    res.end(JSON.stringify({ error: 'handler threw' }))
  })
})

/** A real page on a real loopback origin, so the browser will let it call the API. */
const pagePort = port + 1
const page = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end('<!doctype html><title>sambung e2e</title>')
})
page.listen(pagePort)

server.listen(port, () => {
  const configured = Boolean(
    (process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL) &&
    (process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN)
  )
  console.log(`record endpoint on http://127.0.0.1:${port}/api/chain`)
  console.log(`caller page on     http://127.0.0.1:${pagePort}/`)
  console.log(configured ? 'store: configured' : 'store: none - answering as an empty world')
})
