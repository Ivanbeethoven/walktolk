/**
 * Capture the deck's microphone over the USB cable and write a WAV.
 *
 *   node bin/voice.mjs                      # 10 s, ./deck-voice.wav
 *   node bin/voice.mjs --seconds 30 --out take.wav
 *   node bin/voice.mjs --probe              # just say whether frames arrive
 *
 * Why this exists: holding PTT on the deck does not produce audio by itself.
 * `src/audio/voice.rs` gates capture on a host *listening* on that link 鈥?the
 * BLE host by subscribing to the mic characteristic, the USB host by sending a
 * LISTEN frame (0x11) on channel 7. Without one the deck captures nothing, so a
 * press looks like it "sent nothing".
 *
 * Frames on channel 7 (one HID report each, `[6, 7, len, kind, 鈥`):
 *   0x01 START  stream, codec (1 = IMA ADPCM), rate kHz, frame ms
 *   0x02 AUDIO  stream, seq, predictor i16 LE, step index, 4-bit samples
 *   0x03 END    stream, next seq, reason (0 release, 1 abort, 2 limit, 3 error)
 *   0x12 INFO   five info bytes (USB only, deck to host)
 *
 * @module dsh-deck/bin/voice
 */

import { writeFileSync } from 'node:fs';

import { decodeAdpcm, wav } from '../lib/adpcm.mjs';
import { REPORT_BYTES, listDecks, openDeck } from '../lib/transport/hid-win.mjs';

const REPORT_ID = 6;
const VOICE_CHANNEL = 7;

const KIND_START = 0x01;
const KIND_AUDIO = 0x02;
const KIND_END = 0x03;
const KIND_LISTEN = 0x11;
const KIND_INFO = 0x12;

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const seconds = Number(flag('--seconds') ?? 10);
const out = flag('--out') ?? 'deck-voice.wav';
const probeOnly = argv.includes('--probe');

if (listDecks().length === 0) {
  process.stderr.write('voice: no deck on USB (VID 1209 / PID 5754)\n');
  process.exit(1);
}

const transport = await openDeck({ log: (message) => process.stderr.write(`transport: ${message}\n`) });
const pcm = [];
let rate = 16_000;
let frames = 0;
let bytes = 0;
let ended = null;

/** Send one channel-7 frame. */
async function sendVoice(payload) {
  const report = Buffer.alloc(REPORT_BYTES);
  report[0] = REPORT_ID;
  report[1] = VOICE_CHANNEL;
  report[2] = payload.length;
  Buffer.from(payload).copy(report, 3);
  await transport.write(report);
}

await transport.start((report) => {
  if (!report || report[0] !== REPORT_ID || report[1] !== VOICE_CHANNEL) return;
  const len = report[2];
  if (len < 1) return;
  const body = Buffer.from(report.subarray(3, 3 + len));
  const kind = body[0];
  if (kind === KIND_START) {
    rate = (body[3] || 16) * 1000;
    process.stdout.write(`voice: START codec ${body[2]} rate ${rate} Hz frame ${body[4]} ms\n`);
  } else if (kind === KIND_AUDIO) {
    frames += 1;
    bytes += body.length - 6;
    const predictor = body.readInt16LE(3);
    const index = body[5];
    const { samples } = decodeAdpcm(body.subarray(6), predictor, index);
    pcm.push(samples);
    if (frames % 25 === 0 && !probeOnly) process.stdout.write(`voice: ${frames} frames, ${bytes} B\n`);
  } else if (kind === KIND_END) {
    ended = body[3];
    const reasons = ['release', 'abort', 'limit', 'error'];
    process.stdout.write(`voice: END (${reasons[ended] ?? ended}) after ${frames} frames\n`);
  } else if (kind === KIND_INFO) {
    process.stdout.write(`voice: INFO ${[...body.subarray(1)].join(' ')}\n`);
  }
});

// The deck only captures while a host is listening: this is the request.
await sendVoice([KIND_LISTEN, 1]);
process.stdout.write(`voice: LISTEN sent; press and hold PTT within ${seconds}s\n`);

const started = Date.now();
const done = new Promise((resolve) => setTimeout(resolve, seconds * 1000));
await done;

await sendVoice([KIND_LISTEN, 0]);
await transport.stop();

if (frames === 0) {
  process.stdout.write('voice: no audio frames arrived 鈥?the press never reached a listening host, or the deck has no microphone fitted\n');
  process.exit(0);
}

const total = pcm.reduce((sum, chunk) => sum + chunk.length, 0);
const merged = new Int16Array(total);
let at = 0;
for (const chunk of pcm) {
  merged.set(chunk, at);
  at += chunk.length;
}
writeFileSync(out, wav(merged, rate));
process.stdout.write(`voice: ${frames} frames, ${(total / rate).toFixed(2)} s, ${bytes} ADPCM bytes -> ${out}\n`);
process.exit(0);

