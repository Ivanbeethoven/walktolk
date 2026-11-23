import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeAdpcm, wav } from '../lib/adpcm.mjs';
import { DeckVoice } from '../lib/voice.mjs';

/** One channel-7 report carrying `body`. */
const voiceReport = (body) => Uint8Array.from([6, 7, body.length, ...body]);
const startFrame = (stream) => [0x01, stream, 1, 16, 20];
const audioFrame = (stream, sequence, data) => [0x02, stream, sequence, 0, 0, 40, ...data];
const endFrame = (stream, nextSequence, reason = 0) => [0x03, stream, nextSequence, reason];

function wavSamples(file) {
  const pcm = file.subarray(44);
  return Array.from({ length: pcm.length / 2 }, (_, index) => pcm.readInt16LE(index * 2));
}

function samplesFromFrame(frame) {
  return [...decodeAdpcm(Buffer.from(frame.slice(6)), 0, 40).samples];
}

test('silence decodes to silence', () => {
  const { samples } = decodeAdpcm(Buffer.alloc(16, 0x00), 0, 0);
  assert.equal(samples.length, 32);
  assert.ok(samples.every((sample) => sample === 0));
});

test('two samples come out of every byte, low nibble first', () => {
  const { samples } = decodeAdpcm(Buffer.from([0x70]), 0, 40);
  assert.equal(samples.length, 2);
  // 7 is the loudest positive nibble: both samples must move upward.
  assert.ok(samples[0] > 0);
  assert.ok(samples[1] > samples[0]);
});

test('the decoder keeps its predictor and index in range', () => {
  const data = Buffer.alloc(64, 0xff);
  const { samples, predictor, index } = decodeAdpcm(data, 32767, 88);
  assert.ok(samples.every((sample) => sample >= -32768 && sample <= 32767));
  assert.ok(predictor >= -32768 && predictor <= 32767);
  assert.ok(index >= 0 && index <= 88);
});

test('a wav wraps mono 16-bit pcm at the given rate', () => {
  const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
  const file = wav(pcm, 16_000);
  assert.equal(file.subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(file.subarray(8, 12).toString('latin1'), 'WAVE');
  assert.equal(file.readUInt32LE(4), 36 + pcm.byteLength);
  assert.equal(file.readUInt16LE(22), 1);
  assert.equal(file.readUInt32LE(24), 16_000);
  assert.equal(file.readUInt16LE(34), 16);
  assert.equal(file.readUInt32LE(40), pcm.byteLength);
  assert.equal(file.length, 44 + pcm.byteLength);
});


/** A voice link wired to a fake recognizer and a recorder. */
function bench(text) {
  const sent = [];
  const raw = [];
  const delivered = [];
  const transcribed = [];
  const voice = new DeckVoice({
    sendRaw: async (channel, payload) => { raw.push({ channel, payload }); },
    send: async (message) => { sent.push(message); },
    transcribe: async (audio) => { transcribed.push(Buffer.from(audio)); return text; },
    onText: (slot, words) => { delivered.push({ slot, words }); },
    log: () => {},
  });
  return { voice, sent, raw, delivered, transcribed };
}

test('a press, some frames and a release answer the deck with one final transcript', async () => {
  const { voice, sent, raw, delivered } = bench('open the last pull request');
  voice.press({ agent: 2, p: 7 });
  assert.equal(raw.at(-1).payload[0], 0x11, 'LISTEN goes out when the button is pressed');
  voice.onReport(voiceReport([0x01, 1, 1, 16, 20]));
  voice.onReport(voiceReport([0x02, 1, 0, 0, 0, 40, 0x11, 0x22]));
  voice.onReport(voiceReport([0x03, 1, 1, 0]));

  await voice.release({ agent: 2, p: 7 });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].m, 'transcript');
  assert.equal(sent[0].text, 'open the last pull request');
  assert.equal(sent[0].final, 1);
  assert.equal(sent[0].p, 7, 'the press identity is echoed back');
  assert.deepEqual(delivered, [{ slot: 2, words: 'open the last pull request' }]);
});

test('a press with no audio closes the overlay as failed instead of hanging', async () => {
  const { voice, sent, delivered, transcribed } = bench('');
  voice.press({ agent: 1, p: 3 });
  await voice.release({ agent: 1, p: 3 });

  assert.deepEqual(sent, [{
    m: 'transcript',
    agent: 1,
    text: '',
    failed: 1,
    final: 1,
    p: 3,
  }]);
  assert.equal(transcribed.length, 0);
  assert.deepEqual(delivered, []);
});

test('a cancelled press sends no words', async () => {
  const { voice, sent, delivered, transcribed } = bench('should not be sent');
  voice.press({ agent: 1, p: 4 });
  voice.onReport(voiceReport([0x02, 1, 0, 0, 0, 40, 0x11]));
  await voice.release({ agent: 1, p: 4, abort: 1 });

  assert.deepEqual(sent, [{
    m: 'transcript',
    agent: 1,
    text: '',
    failed: 1,
    final: 1,
    p: 4,
  }]);
  assert.equal(transcribed.length, 0);
  assert.deepEqual(delivered, []);
});

test('audio with an empty transcription sends a failed final transcript', async () => {
  const { voice, sent, delivered, transcribed } = bench('');
  const audio = audioFrame(2, 0, [0x11, 0x22]);
  voice.press({ agent: 2, p: 5 });
  voice.onReport(voiceReport(startFrame(2)));
  voice.onReport(voiceReport(audio));
  voice.onReport(voiceReport(endFrame(2, 1)));

  await voice.release({ agent: 2, p: 5 });

  assert.equal(transcribed.length, 1);
  assert.deepEqual(sent, [{
    m: 'transcript',
    agent: 2,
    text: '',
    failed: 1,
    final: 1,
    p: 5,
  }]);
  assert.deepEqual(delivered, []);
});

test('release includes BLE audio and END reports that arrive later in the same tick', async () => {
  const { voice, transcribed } = bench('complete utterance');
  const first = audioFrame(1, 0, [0x11, 0x22]);
  const late = audioFrame(1, 1, [0x77, 0x88]);
  voice.press({ agent: 1, p: 5 });
  voice.onReport(voiceReport(startFrame(1)));
  voice.onReport(voiceReport(first));

  const pending = voice.release({ agent: 1, p: 5 });
  voice.onReport(voiceReport(late));
  voice.onReport(voiceReport(endFrame(1, 2)));
  await pending;

  assert.equal(transcribed.length, 1);
  assert.deepEqual(wavSamples(transcribed[0]), [...samplesFromFrame(first), ...samplesFromFrame(late)]);
});

test('reset while release waits drops the old stream and preserves the next press audio', async () => {
  const { voice, sent, transcribed } = bench('new utterance');
  const oldFrame = audioFrame(1, 0, [0x11, 0x22]);
  const newFrame = audioFrame(2, 0, [0x77, 0x88]);
  const newLateFrame = audioFrame(2, 1, [0x33, 0x44]);
  voice.press({ agent: 1, p: 5 });
  voice.onReport(voiceReport(startFrame(1)));
  voice.onReport(voiceReport(oldFrame));
  const oldRelease = voice.release({ agent: 1, p: 5 });

  voice.reset();
  voice.press({ agent: 2, p: 6 });
  voice.onReport(voiceReport(startFrame(2)));
  voice.onReport(voiceReport(newFrame));
  const newRelease = voice.release({ agent: 2, p: 6 });
  voice.onReport(voiceReport(audioFrame(1, 1, [0x99, 0xaa])));
  voice.onReport(voiceReport(endFrame(1, 2)));
  voice.onReport(voiceReport(newLateFrame));
  voice.onReport(voiceReport(endFrame(2, 2)));
  await Promise.all([oldRelease, newRelease]);

  assert.equal(transcribed.length, 1);
  assert.deepEqual(wavSamples(transcribed[0]), [...samplesFromFrame(newFrame), ...samplesFromFrame(newLateFrame)]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].p, 6);
});

test('a new press while release waits cannot inherit or be ended by the previous stream', async () => {
  const { voice, sent, transcribed } = bench('second utterance');
  const oldFrame = audioFrame(3, 0, [0x11, 0x22]);
  const newFrame = audioFrame(4, 0, [0x77, 0x88]);
  const newLateFrame = audioFrame(4, 1, [0x33, 0x44]);
  voice.press({ agent: 1, p: 7 });
  voice.onReport(voiceReport(startFrame(3)));
  voice.onReport(voiceReport(oldFrame));
  const oldRelease = voice.release({ agent: 1, p: 7 });

  voice.press({ agent: 2, p: 8 });
  voice.onReport(voiceReport(startFrame(4)));
  voice.onReport(voiceReport(newFrame));
  const newRelease = voice.release({ agent: 2, p: 8 });
  voice.onReport(voiceReport(audioFrame(3, 1, [0x99, 0xaa])));
  voice.onReport(voiceReport(endFrame(3, 2)));
  voice.onReport(voiceReport(newLateFrame));
  voice.onReport(voiceReport(endFrame(4, 2)));
  await Promise.all([oldRelease, newRelease]);

  assert.equal(transcribed.length, 1);
  assert.deepEqual(wavSamples(transcribed[0]), [...samplesFromFrame(newFrame), ...samplesFromFrame(newLateFrame)]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].p, 8);
});

test('release without END finishes within the bounded BLE tail wait', async () => {
  const { voice, transcribed } = bench('utterance without END');
  const audio = audioFrame(5, 0, [0x11, 0x22]);
  voice.press({ agent: 1, p: 9 });
  voice.onReport(voiceReport(startFrame(5)));
  voice.onReport(voiceReport(audio));

  const startedAt = Date.now();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('release waited too long for END')), 700);
  });
  try {
    await Promise.race([voice.release({ agent: 1, p: 9 }), deadline]);
  } finally {
    clearTimeout(timer);
  }

  assert.ok(Date.now() - startedAt < 700);
  assert.equal(transcribed.length, 1);
  assert.deepEqual(wavSamples(transcribed[0]), samplesFromFrame(audio));
});
