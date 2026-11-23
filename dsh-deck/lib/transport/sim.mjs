/**
 * In-memory stand-in for the deck, for tests and for developing without the
 * hardware on the desk.
 *
 * It speaks the real framing: both directions go through the protocol codec, so
 * a bug in chunking or line assembly shows up here rather than on the device.
 *
 * @module dsh-deck/transport/sim
 */

import { CHANNEL, LineAssembler, REPORT_ID, frame } from '../protocol.mjs';

/** A fake deck that answers hellos and lets a test press buttons. */
export class FakeDeck {
  /**
   * @param {{ autoAnswer?: number }} [options] `autoAnswer` presses the first
   *   choice of every card after that many milliseconds, so a headless run can
   *   exercise the whole question path without a person at the device.
   */
  constructor(options = {}) {
    this.autoAnswer = options.autoAnswer ?? 0;
    this.assembler = new LineAssembler();
    /** @type {Array<object>} every message the host sent, in order. */
    this.received = [];
    /** @type {Array<object>} cards the host currently has open, by `agent:id`. */
    this.cards = new Map();
    /** @type {((report: Uint8Array) => void)|null} */
    this.onReport = null;
    /** The sid the fake holds complete state for; 0 means "needs a sync". */
    this.sid = 0;
    this.face = 1;
    this.agents = new Map();
  }

  /** Transport surface used by DeckLink. */
  async start(onReport) {
    this.onReport = onReport;
  }

  async write(report) {
    if (report[0] !== REPORT_ID || report[1] !== CHANNEL) return;
    for (const line of this.assembler.push(report)) {
      const message = JSON.parse(line);
      this.received.push(message);
      this.#apply(message);
    }
  }

  async stop() {
    this.onReport = null;
  }

  /** Push a device line up to the host, framed exactly as the device would. */
  emit(message) {
    const text = JSON.stringify(message);
    for (const report of frame(text)) this.onReport?.(new Uint8Array(report));
  }

  /** Simulate the user tapping a choice on an open card. */
  tapAnswer(agentSlot, cardId, choice) {
    this.emit({ m: 'answer', agent: agentSlot, card: cardId, choice });
  }

  /** Simulate CANCEL on a card (it goes back to the queue). */
  tapSnooze(agentSlot, cardId) {
    this.emit({ m: 'snooze', agent: agentSlot, card: cardId });
  }

  /** Simulate the PTT button. */
  pressPtt(agentSlot, context = 'talk') {
    this.emit({ m: 'ptt', act: 1, agent: agentSlot, ctx: context });
  }

  /** Simulate the wheel moving to another face. */
  switchFace(face) {
    this.face = face;
    this.emit({ m: 'face', f: face });
  }

  /** Simulate a device reboot: the next hello reports sid 0. */
  reboot() {
    this.sid = 0;
  }

  #apply(message) {
    switch (message.m) {
      case 'hello':
        // Remember the host's sid so the next reply can claim complete state.
        this.hostSid = message.sid;
        this.emit({
          m: 'hello',
          v: 1,
          fw: '0.15.0',
          sid: this.sid,
          boot: this.sid === 0 ? 1 : 0,
          rx: 1024,
          lang: 0,
          lang_rev: 0,
          kinds: 6,
          faces: [
            { f: 1, t: 'agents', n: 'Agents' },
            { f: 2, t: 'settings', n: 'Settings' },
          ],
        });
        return;
      case 'synced':
        this.sid = this.hostSid ?? 0;
        return;
      case 'agent':
        if (message.gone) this.agents.delete(message.id);
        else this.agents.set(message.id, message);
        return;
      case 'card': {
        const key = `${message.agent}:${message.id}`;
        if (message.clear) {
          this.cards.delete(key);
          return;
        }
        this.cards.set(key, message);
        if (this.autoAnswer > 0) {
          // Stand in for a person at the device: press the first choice.
          setTimeout(() => {
            if (this.cards.has(key)) this.tapAnswer(message.agent, message.id, 0);
          }, this.autoAnswer).unref?.();
        }
        return;
      }
      default:
        return;
    }
  }
}

/** Wrap a fake deck as the transport `DeckLink` expects. */
export function simTransport(deck = new FakeDeck()) {
  return {
    deck,
    start: (onReport) => deck.start(onReport),
    write: (report) => deck.write(report),
    stop: () => deck.stop(),
  };
}
