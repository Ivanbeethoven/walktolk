/**
 * IMA ADPCM (DVI4) decoding for the deck's voice link, and a WAV writer.
 *
 * The deck sends 16 kHz mono as 4-bit samples, two per byte, low nibble first,
 * with the coder state before each frame's first sample carried in the frame
 * header: a lost frame costs its own 20 ms and nothing after it.
 *
 * Kept apart from `bin/voice.mjs` so tests can import it without running the
 * capture loop.
 *
 * @module dsh-deck/adpcm
 */

/** IMA ADPCM step table, 89 entries. */
const STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];

/** Nibble adjustment to the step index; one entry per nibble value, 0..15. */
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);

/**
 * Decode one frame to 16-bit PCM.
 * @param {Buffer} data nibble-packed samples, two per byte, low nibble first.
 * @param {number} predictor the coder's predictor before the first sample.
 * @param {number} index the coder's step index before the first sample.
 * @returns {{ samples: Int16Array, predictor: number, index: number }}
 */
export function decodeAdpcm(data, predictor, index) {
  const samples = new Int16Array(data.length * 2);
  let at = 0;
  for (const byte of data) {
    for (const nibble of [byte & 0x0f, byte >> 4]) {
      const step = STEP[index];
      let diff = step >> 3;
      if (nibble & 1) diff += step >> 2;
      if (nibble & 2) diff += step >> 1;
      if (nibble & 4) diff += step;
      if (nibble & 8) diff = -diff;
      predictor = clamp(predictor + diff, -32768, 32767);
      index = clamp(index + INDEX[nibble], 0, 88);
      samples[at] = predictor;
      at += 1;
    }
  }
  return { samples: samples.subarray(0, at), predictor, index };
}

/**
 * Wrap 16-bit mono PCM in a RIFF/WAVE header.
 * @param {Int16Array} pcm
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function wav(pcm, sampleRate) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
