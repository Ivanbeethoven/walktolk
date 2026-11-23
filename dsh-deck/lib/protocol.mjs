/**
 * Wire codec for the OpenWalkieTalkie deck: HID report framing and the
 * channel-5 JSON line stream.
 *
 * Contract (openwalkietalkie/docs/deck-protocol.md):
 *   report  = [6, 5, len, payload[0..len], zero padding]   len <= 61
 *   message = one compact JSON object, UTF-8, terminated by a raw LF
 *   line    <= 1024 bytes including the LF
 *
 * Fragments of one line never interleave with another line, so a single
 * assembler per link is enough.
 *
 * @module dsh-deck/protocol
 */

/** HID report id of the deck's single vendor collection. */
export const REPORT_ID = 6;
/** The deck's own channel; the firmware ignores any other byte. */
export const CHANNEL = 5;
/** Bytes of one report, including report id and channel. */
export const REPORT_BYTES = 64;
/** Payload bytes a single report can carry. */
export const CHUNK_BYTES = REPORT_BYTES - 3;
/** Bytes of one line, LF included. */
export const LINE_MAX = 1024;

import { FULL } from './caps.mjs';

/**
 * Split one JSON line into HID reports.
 * @param {string} line JSON without a trailing LF.
 * @returns {Buffer[]} one 64-byte report per chunk.
 */
export function frame(line) {
  const body = Buffer.from(line + '\n', 'utf8');
  if (body.length > LINE_MAX) {
    throw new RangeError(`line is ${body.length} bytes, over the ${LINE_MAX}-byte limit`);
  }
  const reports = [];
  for (let at = 0; at < body.length; at += CHUNK_BYTES) {
    const report = Buffer.alloc(REPORT_BYTES);
    report[0] = REPORT_ID;
    report[1] = CHANNEL;
    const len = Math.min(CHUNK_BYTES, body.length - at);
    report[2] = len;
    body.copy(report, 3, at, at + len);
    reports.push(report);
  }
  return reports;
}

/**
 * Reassembles channel-5 lines out of input reports.
 *
 * Bad frames are dropped rather than throwing: a running link must survive a
 * truncated report, and the firmware itself is the authority on content.
 */
export class LineAssembler {
  constructor() {
    /** @type {number[]} bytes of the line being built. */
    this.pending = [];
  }

  /**
   * Feed one input report.
   * @param {Uint8Array} report raw report bytes, report id first.
   * @returns {string[]} every line completed by this report.
   */
  push(report) {
    if (!report || report.length < 3 || report[0] !== REPORT_ID) return [];
    if (report[1] !== CHANNEL) return [];
    const len = report[2];
    if (len > report.length - 3) return [];
    const lines = [];
    for (let i = 0; i < len; i += 1) {
      const byte = report[3 + i];
      if (byte === 0x0a) {
        if (this.pending.length > 0) {
          lines.push(Buffer.from(this.pending).toString('utf8'));
        }
        this.pending = [];
        continue;
      }
      this.pending.push(byte);
      if (this.pending.length > LINE_MAX) this.pending = []; // oversize: drop to the LF
    }
    return lines;
  }
}

/**
 * Cut a string to a byte budget on a character boundary.
 *
 * The firmware truncates too, but only after the line has crossed the link:
 * cutting here keeps a 1024-byte line from being refused with `err size`.
 *
 * @param {string} text source text.
 * @param {number} maxBytes UTF-8 byte budget.
 * @returns {string} text whose UTF-8 encoding fits `maxBytes`.
 */
export function cut(text, maxBytes) {
  const source = String(text ?? '');
  let used = 0;
  let out = '';
  for (const char of source) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (used + bytes > maxBytes) break;
    used += bytes;
    out += char;
  }
  return out;
}

/** Collapse a multi-line text into one deck-sized line. */
export function oneLine(text, maxBytes) {
  return cut(String(text ?? '').replace(/\s+/g, ' ').trim(), maxBytes);
}

/**
 * Fit a label into a byte budget, marking a cut with an ellipsis.
 *
 * A silently truncated name reads as a different name; a CJK character costs
 * three bytes, so a 24-byte row holds only eight of them.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function fit(text, maxBytes) {
  const clean = oneLine(text, maxBytes * 4);
  if (Buffer.byteLength(clean, 'utf8') <= maxBytes) return clean;
  return `${cut(clean, maxBytes - 3)}…`;
}

/** Serialise one message object. */
export function encode(message) {
  return JSON.stringify(message);
}

/**
 * Build the host hello.
 * @param {number} sid session id.
 * @param {string} [hm] local `HH:MM`, for a firmware that accepts it.
 */
export function hello(sid, hm) {
  const message = { m: 'hello', v: 1, sid };
  if (hm) message.hm = hm;
  return message;
}

/**
 * Upsert one roster row.
 *
 * Fields a deck's firmware predates are omitted rather than sent and refused:
 * the firmware rejects the whole line over one unknown field.
 *
 * @param {object} row
 * @param {number} row.id slot 1..8.
 * @param {'claude'|'codex'|'gemini'|'other'|'conol'|'grok'} [row.kind]
 * @param {string} [row.name] 24-byte name.
 * @param {string} [row.proj] 24-byte project.
 * @param {'working'|'question'|'ready'|'error'|'idle'} [row.state]
 * @param {string} [row.title] 64-byte title.
 * @param {number} [row.since] seconds in the current state.
 * @param {boolean} [row.gone]
 * @param {import('./caps.mjs').Caps} [caps] defaults to the newest vocabulary.
 */
export function agentRow(row, caps = FULL) {
  const message = { m: 'agent', id: row.id };
  if (row.gone) return { ...message, gone: 1 };
  if (row.kind && caps.agentKind) message.kind = row.kind;
  // Empty strings are refused by a 0.14.0 deck with `err parse`, and one refused
  // line leaves the session unsynced, so an empty field is simply not sent: an
  // absent optional field keeps whatever the deck has.
  message.name = fit(row.name ?? '', 24);
  if (!message.name) delete message.name;
  const project = cut(row.proj ?? '', 24);
  if (project && caps.agentProject) message.proj = project;
  if (row.state) message.state = row.state;
  const title = oneLine(row.title ?? '', 64);
  if (title) message.title = title;
  if (row.task && caps.sessionDetails) message.task = fit(row.task, 64);
  if (row.since !== undefined && caps.agentSince) message.since = Math.max(0, Math.round(row.since));
  return message;
}

/**
 * Set one agent's pending card.
 * @param {object} card
 * @param {number} card.agent slot 1..8.
 * @param {number} card.id card id, stable while the question is open.
 * @param {'q'|'r'} [card.type]
 * @param {string} [card.text] 128-byte question text.
 * @param {string[]} [card.choices] up to four 32-byte choices.
 * @param {number} [card.rec] 0-based recommended choice.
 * @param {boolean} [card.clear] resolve the card instead.
 */
export function cardMessage(card, caps = FULL) {
  const message = { m: 'card', agent: card.agent, id: card.id };
  if (card.clear) return { ...message, clear: 1 };
  message.type = card.type ?? 'q';
  message.text = oneLine(card.text, 118); // leave room for the envelope
  if (card.choices?.length) {
    // A choice is 32 bytes on the wire and a CJK character is three of them, so
    // an over-long label is cut with an ellipsis instead of looking complete.
    message.choices = card.choices.slice(0, caps.maxChoices).map((choice) => {
      const text = String(choice ?? '');
      if (Buffer.byteLength(text, 'utf8') <= 32) return text;
      return `${cut(text, 29)}…`;
    });
  }
  if (card.rec !== undefined) message.rec = card.rec;
  return message;
}

/** Free text for the channel lane. */
export function reply(agentSlot, text) {
  return { m: 'reply', agent: agentSlot, text: oneLine(text, 190) };
}

/** Local `HH:MM` for the deck header clock. */
export function clock(now = new Date()) {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}



