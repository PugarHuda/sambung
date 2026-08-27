#!/usr/bin/env node
// Generates the single audio clip the scene ships: sounds/pad.wav.
//
// One clip, not eight. AudioSource carries a `pitch` multiplier, so the eight
// pads are the same recording played at eight semitone ratios (see PAD_PITCH in
// src/audio.ts) and a miss is the same clip dropped well below it. That keeps
// the whole audio budget at one file of about 13 KB instead of nine files.
//
// It is generated rather than downloaded so the repo owns its assets outright:
// no licence to trace, no CDN to go missing, and the timbre is reproducible from
// this file. Re-run with `npm run sound` after changing anything here.

import { writeFileSync, mkdirSync } from 'node:fs'
import { Buffer } from 'node:buffer'

const RATE = 22050
const SECONDS = 0.3
/** E4. Every pad multiplies this by its own ratio, so the top pad lands near B5. */
const BASE_HZ = 329.63
const OUT = 'sounds/pad.wav'

/**
 * A struck-bar timbre: a fundamental with two quiet harmonics over an
 * exponential decay. A bare sine reads as a phone notification; the harmonics
 * are what make it read as an instrument.
 */
const PARTIALS = [
  { ratio: 1, gain: 1 },
  { ratio: 2, gain: 0.3 },
  { ratio: 3.01, gain: 0.1 }
]

/** 5ms of attack, so the onset is not a click, then an exponential tail. */
function envelope(t) {
  const attack = Math.min(1, t / 0.005)
  return attack * Math.exp(-t * 11)
}

const count = Math.floor(RATE * SECONDS)
const samples = new Float64Array(count)
let peak = 0
for (let i = 0; i < count; i++) {
  const t = i / RATE
  let v = 0
  for (const p of PARTIALS) v += p.gain * Math.sin(2 * Math.PI * BASE_HZ * p.ratio * t)
  v *= envelope(t)
  samples[i] = v
  peak = Math.max(peak, Math.abs(v))
}

// Normalised to 0.8 of full scale: loud enough to hear over a phone speaker,
// with headroom so no sample clips after the client applies its own volume.
const scale = (0.8 / peak) * 0x7fff
const pcm = Buffer.alloc(count * 2)
for (let i = 0; i < count; i++) pcm.writeInt16LE(Math.round((samples[i] ?? 0) * scale), i * 2)

/**
 * Canonical 44-byte RIFF/PCM header: 16-bit, mono.
 * @param {number} bytes length of the PCM payload that follows
 */
function wavHeader(bytes) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + bytes, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16) // PCM header length
  h.writeUInt16LE(1, 20) // format 1 = PCM
  h.writeUInt16LE(1, 22) // channels
  h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28) // byte rate
  h.writeUInt16LE(2, 32) // block align
  h.writeUInt16LE(16, 34) // bits per sample
  h.write('data', 36)
  h.writeUInt32LE(bytes, 40)
  return h
}

mkdirSync('sounds', { recursive: true })
const file = Buffer.concat([wavHeader(pcm.length), pcm])
writeFileSync(OUT, file)
console.log(`${OUT}: ${(file.length / 1024).toFixed(1)} KB, ${SECONDS}s mono @ ${RATE} Hz`)
