/**
 * The roster: which DSH agents the deck shows, in which slot, in what order.
 *
 * Each session keeps its device slot across updates. The firmware advertises
 * the number of slots and receives only rows whose visible fields changed.
 *
 * @module dsh-deck/roster
 */

import { FULL } from './caps.mjs';
import { agentRow } from './protocol.mjs';

/** Capacity of a deck that omits the slot count from its hello. */
export const SLOTS = 8;

/** Order in which states deserve a slot: someone waiting for you wins. */
const URGENCY = { question: 0, error: 1, working: 2, ready: 3, idle: 4 };

/**
 * Fold a DSH agent status into a deck state.
 *
 * DSH statuses are richer than the deck's five, and the exact vocabulary is the
 * driver's; anything unrecognised reads as `working` while it is live, because
 * a running turn is the safe default for a status we do not know.
 *
 * @param {string|undefined} status
 * @param {boolean} [waiting] the agent is blocked on a question or approval.
 * @returns {'working'|'question'|'ready'|'error'|'idle'}
 */
export function deckState(status, waiting = false) {
  if (waiting) return 'question';
  const text = String(status ?? '').toLowerCase();
  if (text.includes('error') || text.includes('fail')) return 'error';
  if (text.includes('question') || text.includes('wait') || text.includes('approval')) return 'question';
  if (text.includes('idle') || text.includes('ready') || text.includes('done') || text.includes('stop')) {
    return 'ready';
  }
  if (text === '' || text.includes('created')) return 'idle';
  return 'working';
}

/**
 * Read one agent as a roster entry, tolerating the several shapes a driver may
 * hand us (an `Agent` handle, a registry snapshot, or a plain summary).
 *
 * @param {any} agent
 * @param {{ waiting?: (id: string) => boolean, title?: (id: string) => string|undefined }} hooks
 * @returns {{ id: string, name: string, project: string, state: string, title: string }|null}
 */
export function readAgent(agent, hooks = {}) {
  if (!agent) return null;
  const id = String(agent.id ?? agent.agentId ?? agent.sessionId ?? '');
  if (!id) return null;
  const name = String(agent.name ?? agent.title ?? agent.label ?? id);
  const project = String(
    agent.project ?? agent.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? agent.workingDirectory ?? '',
  );
  const state = deckState(agent.status ?? agent.state, hooks.waiting?.(id) ?? false);
  const title = hooks.title?.(id) ?? agent.activity ?? agent.lastMessage ?? '';
  return { id, name, project, state, title: String(title) };
}

/** Ranks entries for slot allocation. */
function rank(entry) {
  return URGENCY[entry.state] ?? URGENCY.idle;
}

/**
 * Assigns stable slots to agents and diffs what the deck already shows.
 *
 * Slots are sticky: an agent keeps its slot while it stays in the list, so the
 * deck does not shuffle under the user's finger when a row changes state.
 */
export class Roster {
  /**
   * @param {(message: object) => void} send writer for one protocol message.
   * @param {{ limit?: number }} [options]
   */
  constructor(send, options = {}) {
    this.send = send;
    this.limit = Math.max(1, Math.min(options.limit ?? SLOTS - 1, SLOTS - 1));
    /** Firmware capabilities; rows omit fields a deck would refuse. */
    this.caps = options.caps ?? (() => FULL);
    /** @type {Map<string, number>} agent id -> slot. */
    this.slots = new Map();
    /** @type {Map<number, string>} slot -> last line sent, for diffing. */
    this.shown = new Map();
  }

  /**
   * Push a new snapshot of live agents.
   * @param {Array<{ id: string, name: string, project: string, state: string, title: string }>} entries
   */
  update(entries, { paged = false, budget = Infinity } = {}) {
    const capacity = this.caps()?.slots ?? SLOTS;
    const keep = paged ? entries.slice(0, capacity) : [...entries].sort((a, b) => rank(a) - rank(b)).slice(0, this.limit);
    const wanted = new Set(keep.map((entry) => entry.id));
    let pending = false;

    // Free slots of agents that are gone or no longer fit.
    for (const [id, slot] of this.slots) {
      if (!wanted.has(id) || slot > capacity) {
        if (this.shown.has(slot) && slot <= capacity && budget <= 0) { pending = true; continue; }
        this.slots.delete(id);
        if (slot <= capacity && this.shown.has(slot)) {
          this.send(agentRow({ id: slot, gone: true }, this.caps()));
          budget--;
        }
        this.shown.delete(slot);
      }
    }
    // Assign the lowest free slot to each newcomer, in rank order.
    let next = 1;
    for (const entry of keep) {
      if (this.slots.has(entry.id)) continue;
      while ([...this.slots.values()].includes(next)) next += 1;
      if (next > capacity) break;
      this.slots.set(entry.id, next);
      next += 1;
    }
    // Send only rows whose visible content changed.
    for (const entry of keep) {
      const slot = this.slots.get(entry.id);
      if (!slot) continue;
      const row = agentRow({
        id: slot,
        kind: kindOf(entry.name),
        name: entry.name,
        proj: entry.project,
        state: entry.state,
        title: entry.title,
        task: entry.task,
      }, this.caps());
      const line = JSON.stringify(row);
      if (this.shown.get(slot) === line) continue;
      if (budget <= 0) { pending = true; continue; }
      budget--;
      this.shown.set(slot, line);
      this.send(row);
    }
    return pending;
  }

  /** Slot of one agent, if it currently has one. */
  slotOf(agentId) {
    return this.slots.get(String(agentId));
  }

  idAt(slot) {
    for (const [id, assigned] of this.slots) if (assigned === slot) return id;
  }

  /** Every live mapping, for a full sync. */
  snapshot() {
    return [...this.slots.entries()].map(([id, slot]) => ({ id, slot }));
  }


  /**
   * The slot an agent must use for a card, creating a row if it has none.
   *
   * A card names an agent slot, and the deck refuses one for a slot it does not
   * have (`err range`) — so a question from an agent the roster has not shown
   * yet cannot be sent as-is. This allocates the lowest free slot and announces
   * the row first.
   *
   * @param {string} agentId
   * @param {string} [name]
   * @returns {number|undefined} the slot, or undefined when every slot is taken.
   */
  ensureSlot(agentId, name = '') {
    const known = this.slots.get(String(agentId));
    if (known && this.shown.has(known)) return known;
    let slot = known ?? 1;
    const taken = new Set(this.slots.values());
    if (!known) while (taken.has(slot)) slot += 1;
    if (slot > (this.caps()?.slots ?? SLOTS)) return undefined;
    this.slots.set(String(agentId), slot);
    const row = agentRow({ id: slot, name: name || 'agent', state: 'question', title: '' }, this.caps());
    this.shown.set(slot, JSON.stringify(row));
    this.send(row);
    return slot;
  }

  /** Forget everything the deck was told, e.g. after a reboot. */
  reset() {
    this.slots.clear();
    this.shown.clear();
  }
}

/** Guess a deck agent kind from a name; the deck only draws a glyph for it. */
function kindOf(name) {
  const text = String(name).toLowerCase();
  if (text.includes('claude')) return 'claude';
  if (text.includes('codex')) return 'codex';
  if (text.includes('gemini')) return 'gemini';
  return 'other';
}


