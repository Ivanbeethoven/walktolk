/**
 * What one deck's firmware accepts.
 *
 * The protocol grows by adding fields, and an old firmware refuses a whole line
 * over one field it does not know (`err parse`), so a host that assumes the
 * newest vocabulary gets a deck that shows nothing. The device's `hello`
 * carries `fw`, and this file turns that into the subset to send.
 *
 * Thresholds come from the firmware's own notes (a face template the firmware
 * predates answers `err unknown`: `arcade` before 0.6.0, `system` before 0.10.0,
 * `timer` before 0.12.0) and from probing a 0.7.0 and a 0.14.0 deck.
 *
 * @module dsh-deck/caps
 */

/**
 * @typedef {object} Caps
 * @property {string} fw the firmware version string, as reported.
 * @property {boolean} hm `hello` may carry the header clock.
 * @property {boolean} agentKind `agent` may carry `kind`.
 * @property {boolean} agentProject `agent` may carry `proj`.
 * @property {boolean} agentSince `agent` may carry `since`.
 * @property {number} maxChoices choices one card may carry.
 * @property {boolean} facesExtra `system`/`timer` faces can be named.
 */

/**
 * Parse a `major.minor.patch` firmware version.
 * @param {string} fw
 * @returns {[number, number, number]}
 */
export function parseFw(fw) {
  const parts = String(fw ?? '0.0.0').split('.').map((part) => Number.parseInt(part, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** True when `fw` is at least `major.minor`. */
export function atLeast(fw, major, minor) {
  const [a, b] = parseFw(fw);
  return a > major || (a === major && b >= minor);
}

/**
 * The capability set for a deck that answered `hello`.
 * @param {{ fw?: string }} helloMessage
 * @returns {Caps}
 */
export function capabilities(helloMessage) {
  const fw = String(helloMessage?.fw ?? '0.0.0');
  return {
    fw,
    slots: Number.isInteger(helloMessage?.agents) && helloMessage.agents > 0 ? Math.min(255, helloMessage.agents) : 8,
    // Off for now, and measured rather than guessed: a hello carrying `hm` is
    // answered, but the session that follows it is refused and never keeps our
    // sid. The header clock is the one thing worth losing to get a stable link;
    // re-enable it once a firmware is seen that takes it.
    hm: false,
    // `kind`, `proj` and `since` parse from 0.7.0 upward.
    agentKind: atLeast(fw, 0, 7),
    agentProject: atLeast(fw, 0, 7),
    agentSince: atLeast(fw, 0, 7),
    sessionDetails: atLeast(fw, 0, 14),
    // Measured on 0.7.0: a card carrying three choices makes the deck drop the
    // whole session, so only two are offered until a newer firmware is seen.
    maxChoices: atLeast(fw, 0, 10) ? 4 : 2,
    // `system` needs 0.10.0 and `timer` 0.12.0.
    facesExtra: atLeast(fw, 0, 12),
  };
}

/** The capability set of the newest firmware, for tests and the simulator. */
export const FULL = capabilities({ fw: '99.0.0' });
