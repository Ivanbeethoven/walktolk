/**
 * Push-to-talk: what the deck needs from a host to turn a held button into text.
 *
 * The button alone sends a `ptt` line and lights the LISTENING overlay; the
 * audio rides the cable on channel 7 and only exists at all while a host is
 * listening. Without this module the deck sits on "transcribing" forever, which
 * is exactly what a host that never answers looks like.
 *
 * The sequence is fixed by the firmware:
 *   press   -> host is already listening; the deck sends START, then AUDIO
 *              frames every 20 ms (IMA ADPCM, 16 kHz mono), then END
 *   release -> host decodes the frames, transcribes, and answers on channel 5
 *              with one `transcript` line carrying `final:1` (and `failed:1` if
 *              the words never arrived). The overlay closes on that line.
 *
 * @module dsh-deck/voice
 */

import { decodeAdpcm, wav } from './adpcm.mjs';
import { cut } from './protocol.mjs';

/** Report id and channel of the voice link. */
const REPORT_ID = 6;
const VOICE_CHANNEL = 7;

const KIND_START = 0x01;
const KIND_AUDIO = 0x02;
const KIND_END = 0x03;
const KIND_LISTEN = 0x11;

/** 16 kHz mono PCM16: the only shape the recognizer accepts. */
const SAMPLE_RATE = 16_000;

/**
 * One PTT utterance, decoded and handed to the recognizer.
 */
export class DeckVoice {
  /**
   * @param {object} options
   * @param {(channel: number, payload: Uint8Array) => Promise<void>} options.sendRaw
   * @param {(message: object) => Promise<void>} options.send deck messages
   * @param {(audio: Buffer, signal: AbortSignal) => Promise<string>} options.transcribe
   *   returns the recognised text, or '' when nothing was said.
   * @param {(slot: number, text: string) => void} options.onText deliver the text.
   * @param {(message: string) => void} options.log
   */
  constructor(options) {
    this.sendRaw = options.sendRaw;
    this.send = options.send;
    this.transcribe = options.transcribe;
    this.onText = options.onText;
    this.log = options.log;
    /** Frames of the utterance being recorded. @type {Int16Array[]} */
    this.frames = [];
    /** The `ptt act:1` line this utterance belongs to, if any. */
    this.activePress = null;
    this.abort = null;
    this.recording = false;
    this.streamId = null;
    this.finishDrain = null;
  }

  /** Start listening on the cable. Idempotent; the deck only captures while it is on. */
  async listen() {
    try {
      await this.sendRaw(VOICE_CHANNEL, Uint8Array.from([KIND_LISTEN, 1]));
    } catch (error) {
      this.log(`voice: LISTEN failed: ${error?.message ?? error}`);
    }
  }

  reset() {
    if (this.activePress || this.finishDrain) {
      this.log(`voice: recording interrupted after ${this.frames.length} audio frames`);
    }
    this.finishDrain?.();
    this.streamId = null;
    this.abort?.abort();
    this.abort = null;
    this.activePress = null;
    this.frames = [];
    this.recording = false;
  }

  /** Stop listening, e.g. when the plugin unloads. */
  async mute() {
    try {
      await this.sendRaw(VOICE_CHANNEL, Uint8Array.from([KIND_LISTEN, 0]));
    } catch {
      // The link is going away anyway.
    }
  }

  /**
   * Feed one input report; anything that is not a voice frame is ignored.
   * @param {Uint8Array} report
   */
  onReport(report) {
    if (!report || report[0] !== REPORT_ID || report[1] !== VOICE_CHANNEL) return;
    const len = report[2];
    if (len < 1 || len > report.length - 3) return;
    const body = Buffer.from(report.subarray(3, 3 + len));
    if (body[0] !== KIND_START && this.streamId !== null && body[1] !== this.streamId) return;
    switch (body[0]) {
      case KIND_START:
        if (body.length < 5) return;
        this.streamId = body[1];
        this.recording = true;
        this.log(`voice: START codec ${body[2]} ${body[3]} kHz`);
        return;
      case KIND_AUDIO: {
        if (!this.recording || body.length <= 6) return;
        const predictor = body.readInt16LE(3);
        const index = body[5];
        const { samples } = decodeAdpcm(body.subarray(6), predictor, index);
        this.frames.push(samples);
        if (this.frames.length === 1) {
          this.log(`voice: first AUDIO stream ${body[1]} seq ${body[2]}, ${samples.length} samples`);
        }
        return;
      }
      case KIND_END:
        this.recording = false;
        this.log(`voice: END (${['release', 'abort', 'limit', 'error'][body[3]] ?? body[3]}) after ${this.frames.length} frames`);
        this.finishDrain?.();
        return;
      default:
        return;
    }
  }

  /**
   * The button went down: begin collecting.
   * @param {{ agent?: number, ctx?: string, card?: number, p?: number }} message
   */
  press(message) {
    this.finishDrain?.();
    this.streamId = null;
    this.activePress = message;
    this.frames = [];
    this.recording = true;
    this.abort?.abort();
    this.abort = null;
    // Listening is per link and stays on; re-assert it in case the deck forgot
    // after a reconnect.
    void this.listen();
  }

  /**
   * The button came up: transcribe what arrived and answer the deck.
   * @param {{ agent?: number, ctx?: string, card?: number, p?: number, abort?: number }} message
   */
  async release(message) {
    if (this.finishDrain) return;
    if (this.activePress?.p !== undefined && message.p !== undefined && this.activePress.p !== message.p) return;
    const press = this.activePress ?? message;
    this.activePress = null;
    const frames = this.frames;
    const slot = press.agent ?? 0;
    const pressId = press.p;
    const aborted = message.abort === 1;
    // The control and microphone notifications can arrive in either order.
    if (!aborted && this.recording) {
      await new Promise(resolve => {
        const finish = () => {
          clearTimeout(timer);
          this.finishDrain = null;
          resolve();
        };
        const timer = setTimeout(finish, 240);
        this.finishDrain = finish;
      });
      if (this.frames !== frames) return;
    }
    this.recording = false;
    this.frames = [];

    if (aborted || frames.length === 0) {
      await this.fail(slot, pressId, aborted ? 'aborted' : 'no audio');
      return;
    }

    const total = frames.reduce((sum, chunk) => sum + chunk.length, 0);
    const pcm = new Int16Array(total);
    let at = 0;
    for (const chunk of frames) {
      pcm.set(chunk, at);
      at += chunk.length;
    }
    const seconds = total / SAMPLE_RATE;
    this.log(`voice: ${frames.length} frames, ${seconds.toFixed(2)} s of audio`);

    const controller = new AbortController();
    this.abort = controller;
    let text = '';
    try {
      text = await this.transcribe(wav(pcm, SAMPLE_RATE), controller.signal);
    } catch (error) {
      this.log(`voice: transcription failed: ${error?.message ?? error}`);
    } finally {
      if (this.abort === controller) this.abort = null;
    }

    if (controller.signal.aborted) return;
    if (!text) {
      await this.fail(slot, pressId, 'nothing recognised');
      return;
    }

    this.log(`voice: "${text}"`);
    await this.send({
      m: 'transcript',
      agent: slot,
      text: cut(text, 190),
      final: 1,
      ...(pressId === undefined ? {} : { p: pressId }),
    });
    this.onText(slot, text, press);
  }

  /** Close the overlay without text. */
  async fail(slot, pressId, why) {
    this.log(`voice: nothing to send (${why})`);
    await this.send({
      m: 'transcript',
      ...(slot ? { agent: slot } : {}),
      text: '',
      failed: 1,
      final: 1,
      ...(pressId === undefined ? {} : { p: pressId }),
    });
  }
}

