/**
 * The deck link: session handshake, heartbeat, pacing and event dispatch.
 *
 * Implements the session rules from openwalkietalkie/docs/deck-protocol.md:
 *   - send `hello` on open and every 5 s;
 *   - the device's reply carries the `sid` it holds complete state for, and 0
 *     after boot, a link drop or a new sid, so anything but our own sid means
 *     "push the whole state, then `synced`";
 *   - no hello for 15 s makes the device show the host offline, so the
 *     heartbeat must survive a slow render, not be a one-shot;
 *   - at most one output report every 8 ms, or the link drops.
 *
 * @module dsh-deck/link
 */

import { EventEmitter } from 'node:events';
import { capabilities } from './caps.mjs';
import {
  CHUNK_BYTES, LineAssembler, REPORT_BYTES, REPORT_ID, clock, encode, frame, hello,
} from './protocol.mjs';

/** How often a hello is sent while the link is up. */
export const HEARTBEAT_MS = 5000;
/** How often the first, unanswered hello is repeated while the deck is asleep. */
export const WAKE_MS = 1200;
/** Gap between the last row of a sync and its `synced`. */
export const SETTLE_MS = 250;
/** Gap before repeating synced, in case the first one was lost. */
export const SYNCED_AGAIN_MS = 400;
/** Minimum gap between output reports. */
export const PACE_MS = 8;

/**
 * One deck connection over an arbitrary transport.
 *
 * @extends EventEmitter
 */
export class DeckLink extends EventEmitter {
  /**
   * @param {{ start: (onReport: (report: Uint8Array) => void) => Promise<void>|void,
   *           write: (report: Uint8Array) => Promise<void>|void,
   *           stop: () => Promise<void>|void }} transport
   * @param {{ sync?: () => Promise<object[]>|object[] }} [hooks]
   *   `sync` returns the messages that make up a full state push.
   */
  constructor(transport, hooks = {}) {
    super();
    this.transport = transport;
    this.hooks = hooks;
    /** Random per-process session id; the device keys its state by it. */
    this.sid = 1 + Math.floor(Math.random() * 0xffff_fffe);
    this.assembler = new LineAssembler();
    this.heartbeat = null;
    this.wake = null;
    this.syncing = false;
    /** True once this sid's state has been pushed; later hellos only re-confirm. */
    this.pushed = false;
    this.running = false;
    this.ready = false;
    /** Serialises writes so the 8 ms pace holds across awaits. */
    this.queue = Promise.resolve();
    this.generation = 0;
    this.lastWrite = 0;
    /** What this deck's firmware accepts; learned from its hello. */
    this.caps = null;
  }

  /** Open the transport and start the heartbeat. */
  async start() {
    if (this.running) return;
    this.running = true;
    await this.transport.start((report) => this.#onReport(report), (connected) => {
      this.lost();
      if (connected) {
        this.sid = 1 + Math.floor(Math.random() * 0xffff_fffe);
        this.#sendHello();
      }
    });
    this.#sendHello();
    // The first hello after a quiet spell is often dropped: the deck answers
    // only once it is awake, so knock again until it does.
    this.wake = setInterval(() => {
      if (!this.ready) this.#sendHello();
    }, WAKE_MS);
    this.wake.unref?.();
    this.heartbeat = setInterval(() => this.#sendHello(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /** Close the transport; pending messages are dropped. */
  async stop() {
    this.running = false;
    this.ready = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.wake) clearInterval(this.wake);
    this.heartbeat = null;
    this.wake = null;
    await this.transport.stop();
    this.emit('closed');
  }

  /**
   * Queue one message for the device.
   * @param {object} message a `m`-tagged protocol message.
   */
  send(message, isCurrent) {
    if (!this.running) return Promise.resolve();
    const text = encode(message);
    const reports = frame(text);
    const generation = this.generation;
    this.queue = this.queue.then(async () => {
      if (!this.running || this.generation !== generation || (isCurrent && !isCurrent())) return;
      this.emit('sent', message);
      // Finish every started JSON line, including when the user changes channels.
      for (const report of reports) await this.#writePaced(report, generation);
    }).catch(error => this.emit('error', error));
    return this.queue;
  }

  /**
   * Queue one raw payload on another channel 鈥?the voice link uses channel 7,
   * which carries binary frames rather than JSON lines.
   * @param {number} channel
   * @param {Uint8Array} payload at most 61 bytes.
   */
  sendRaw(channel, payload) {
    if (!this.running) return Promise.resolve();
    if (payload.length > CHUNK_BYTES) throw new RangeError('raw payload too long');
    const report = Buffer.alloc(REPORT_BYTES);
    report[0] = REPORT_ID;
    report[1] = channel;
    report[2] = payload.length;
    Buffer.from(payload).copy(report, 3);
    const generation = this.generation;
    this.queue = this.queue.then(() => this.#writePaced(report, generation)).catch((error) => {
      this.emit('error', error);
    });
    return this.queue;
  }

  /** Forget the device's readiness, e.g. after a transport error. */
  lost() {
    this.generation++;
    this.assembler = new LineAssembler();
    this.syncing = false;
    this.pushed = false;
    this.caps = null;
    this.ready = false;
    this.emit('lost');
  }

  #sendHello() {
    // Until the deck has answered once, assume it predates the header clock: a
    // firmware that does not know the field refuses the whole line.
    const hm = this.caps?.hm === true ? clock() : undefined;
    this.send(hello(this.sid, hm));
  }

  async #writePaced(report, generation) {
    if (!this.running || this.generation !== generation) return;
    const wait = this.lastWrite + Math.max(PACE_MS, this.transport.paceMs || 0) - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (!this.running || this.generation !== generation) return;
    this.lastWrite = Date.now();
    await this.transport.write(report);
  }

  #onReport(report) {
    // Other channels carry binary frames — 7 is the voice link — so they are
    // offered here; the line assembler only understands channel 5.
    this.emit('report', report);
    for (const line of this.assembler.push(report)) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit('malformed', line);
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (!message || typeof message !== 'object') return;
    if (message.m === 'hello') {
      this.#onHello(message);
      return;
    }
    this.emit('message', message);
    if (typeof message.m === 'string') this.emit(message.m, message);
  }

  /** A hello reply decides whether the device needs a full state push. */
  async #onHello(message) {
    this.caps = capabilities(message);
    // A deck that booted holds nothing: its strip and settings are the power-on
    // defaults, so the state has to go out again rather than only `synced`.
    if (message.boot === 1) this.pushed = false;
    this.emit('hello', message);
    if (message.sid === this.sid) {
      this.ready = true;
      this.syncing = false;
      if (this.wake) clearInterval(this.wake);
      this.wake = null;
      this.emit('ready', message);
      return;
    }
    // A hello that arrives while the state push is still going out must not
    // start a second one: the deck resets the session on every hello that
    // carries a sid it holds no state for, so two overlap into a loop where
    // the device never keeps ours.
    if (this.syncing) return;
    this.syncing = true;
    const generation = this.generation;
    // It answered, so it is awake: stop knocking before the push starts.
    if (this.wake) clearInterval(this.wake);
    this.wake = null;
    try {
      // Push the state once per sid, and after that only repeat `synced`.
      // Measured on 0.14.0: the first `synced` after a hello is often taken and
      // still leaves `held_sid` at 0, while a second one closes it. Re-pushing
      // the rows every heartbeat is what made the screen flicker, so once the
      // state is out, every later hello only re-confirms the end of the sync.
      let sent = 0;
      if (!this.pushed) {
        const messages = (await this.hooks.sync?.()) ?? [];
        sent = messages.length;
        for (const pending of messages) await this.send(pending);
        // Let the last rows land before closing the sync. The deck applies a
        // line when it arrives, and a `synced` inside the same burst as the
        // rows left the session unclaimed on every heartbeat. This waits even
        // when `sync()` returned nothing: the plugin queues its rows itself.
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        if (!this.running || generation !== this.generation) return;
        this.pushed = true;
      }
      // `synced` is a unit variant in the firmware's parser (`b"synced" =>
      // HostMsg::Synced`): it carries no fields, and only `end_sync` clears the
      // `syncing` flag that keeps `held_sid()` at 0. Sent twice, because one
      // lost line otherwise pins the deck in "sync in progress" forever.
      await this.send({ m: 'synced' });
      await new Promise((resolve) => setTimeout(resolve, SYNCED_AGAIN_MS));
      if (!this.running || generation !== this.generation) return;
      await this.send({ m: 'synced' });
      if (!this.running || generation !== this.generation) return;
      this.ready = true;
      this.emit('sync', { boot: message.boot === 1, faces: message.faces ?? [], sent });
      this.emit('ready', message);
    } finally {
      if (generation === this.generation) this.syncing = false;
    }
  }
}










