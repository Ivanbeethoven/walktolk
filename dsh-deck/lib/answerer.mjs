/**
 * The answerer: turns a DSH question or approval into a deck card, and the
 * deck's `answer` event back into the harness's answer.
 *
 * Both DSH seams are Cordis waterfalls: a listener returns a value to answer,
 * or calls `next()` to hand the request to the next listener. Letting go is not
 * optional politeness 鈥?a listener that holds a request it cannot present
 * strands the turn behind an answer that never comes, and a headless run has no
 * other answerer to fall back to.
 *
 * @module dsh-deck/answerer
 */

import { FULL } from './caps.mjs';
import { cardMessage } from './protocol.mjs';

/** How long a card may sit unanswered before we hand the question back. */
export const CARD_TIMEOUT_MS = 5 * 60_000;

/**
 * Cards on the deck, at most one visible per agent slot.
 *
 * Each agent's questions queue in order; only the head is presented. Settling
 * the head presents the next one, so a burst of questions from one agent does
 * not overwrite the card the user is currently deciding on.
 */
export class CardBoard {
  /**
   * @param {{ send: (message: object) => void,
   *           slotFor: (agentId: string) => number|undefined,
   *           isReady: () => boolean,
   *           timeoutMs?: number }} options
   */
  constructor(options) {
    this.send = options.send;
    this.slotFor = options.slotFor;
    this.ensureSlot = options.ensureSlot;
    this.isReady = options.isReady;
    this.timeoutMs = options.timeoutMs ?? CARD_TIMEOUT_MS;
    /** Firmware capabilities; a card is cut to the choices it can show. */
    this.caps = options.caps ?? (() => FULL);
    /** @type {Map<string, { agentSlot: number, cardId: number, timer: any, question: object, settle: (choice: number|null) => void }>} */
    this.open = new Map();
    /** @type {Map<number, Array<{ question: object, settle: (choice: number|null) => void }>>} */
    this.backlog = new Map();
    this.nextCardId = 1;
  }

  /** How many cards are visible (for status/debug). */
  get size() {
    return this.open.size;
  }

  /**
   * Present a question on the deck and wait for the user's choice.
   *
   * Resolves with the chosen index, or `null` when the question was let go
   * (link down, timeout, snooze) so the caller can delegate with `next()`.
   *
   * @param {{ agentId: string, text: string, choices: string[] }} question
   * @returns {Promise<number|null>}
   */
  ask(question, signal) {
    if (!this.isReady() || signal?.aborted) return Promise.resolve(null);
    // A card must name a slot the deck already has: one for an agent it has
    // never drawn is refused with `err range`, and the whole card is lost.
    const agentSlot = this.ensureSlot?.(question.agentId) ?? this.slotFor(question.agentId);
    if (!agentSlot) return Promise.resolve(null);
    return new Promise((resolve) => {
      const entry = { question: { ...question, agentSlot }, settle: choice => {
        signal?.removeEventListener('abort', cancel);
        resolve(choice);
      } };
      const queue = this.backlog.get(agentSlot) ?? [];
      const cancel = () => {
        const index = queue.indexOf(entry);
        if (index < 0) return;
        if (index === 0) {
          const card = [...this.open.values()].find(item => item.settle === entry.settle);
          if (card) { this.#settle(card, null, true); return; }
        }
        queue.splice(index, 1);
        entry.settle(null);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      queue.push(entry);
      this.backlog.set(agentSlot, queue);
      if (queue.length === 1) this.#present(agentSlot);
    });
  }

  /**
   * The deck reported a choice.
   * @returns {boolean} whether the card was ours.
   */
  answer(agentSlot, cardId, choice) {
    const card = this.open.get(`${agentSlot}:${cardId}`);
    if (!card) return false;
    const valid = choice >= 0 && choice < (card.question.choices?.length ?? 0);
    this.#settle(card, valid ? choice : null, true);
    return true;
  }

  /**
   * The user pushed the card back to the queue (CANCEL on the card).
   * @returns {boolean} whether the card was ours.
   */
  snooze(agentSlot, cardId) {
    const card = this.open.get(`${agentSlot}:${cardId}`);
    if (!card) return false;
    this.#settle(card, null, false);
    return true;
  }

  /** The link went away: release every waiter so no turn is stranded. */
  releaseAll() {
    for (const card of this.open.values()) clearTimeout(card.timer);
    this.open.clear();
    for (const queue of this.backlog.values()) {
      for (const entry of queue) entry.settle(null);
    }
    this.backlog.clear();
  }

  #present(agentSlot) {
    const queue = this.backlog.get(agentSlot);
    const entry = queue?.[0];
    if (!entry) return;
    const cardId = this.nextCardId++;
    const key = `${agentSlot}:${cardId}`;
    const timer = setTimeout(() => {
      const card = this.open.get(key);
      if (card) this.#settle(card, null, false);
    }, this.timeoutMs);
    timer.unref?.();
    this.open.set(key, { agentSlot, cardId, timer, question: entry.question, settle: entry.settle });
    this.send(cardMessage({
      agent: agentSlot,
      id: cardId,
      type: 'q',
      text: entry.question.text,
      choices: entry.question.choices,
      rec: 0,
    }, this.caps()));
  }

  #settle(card, choice, confirm) {
    this.open.delete(`${card.agentSlot}:${card.cardId}`);
    clearTimeout(card.timer);
    if (confirm) {
      // The deck keeps the card visible, marked "sent", until this arrives.
      this.send({ m: 'card', agent: card.agentSlot, id: card.cardId, clear: 1 });
    }
    card.settle(choice);
    const queue = this.backlog.get(card.agentSlot);
    if (!queue) return;
    queue.shift();
    if (queue.length === 0) this.backlog.delete(card.agentSlot);
    else this.#present(card.agentSlot);
  }
}

/**
 * Normalise a `user-questions/request` payload into the deck's card shape.
 *
 * The tool's questions are single- or multi-select with options; the deck shows
 * one card of at most four choices, so only questions that fit are presented.
 * Anything else is left to another answerer rather than approximated: a wrong
 * option list is worse than no option list.
 *
 * @param {any} request
 * @returns {{ agentId: string, text: string, choices: string[], questionId: string }|null}
 */
export function questionCard(request) {
  const list = request?.questions ?? [];
  if (!Array.isArray(list) || list.length !== 1) return null;
  const question = list[0];
  const options = question?.options;
  if (!Array.isArray(options) || options.length === 0 || options.length > 4) return null;
  if (question.multi_select) return null;
  const choices = options.map((option) => String(option?.label ?? option ?? ''));
  if (choices.some((choice) => choice === '')) return null;
  return {
    agentId: String(request?.agent?.id ?? request?.agentId ?? ''),
    questionId: String(question.id ?? '0'),
    text: String(question.question ?? question.header ?? 'Question'),
    choices,
  };
}

/**
 * Normalise an `approval/request` into a card.
 *
 * An approval carries no tool arguments, only the tool's name and a reason, so
 * the card is the reason with a yes/no pair. "Allow once" is the honest default
 * for a one-shot grant.
 *
 * @param {any} request
 * @returns {{ agentId: string, text: string, choices: string[] }}
 */
export function approvalCard(request) {
  const tool = request?.toolName || request?.tool || 'this action';
  const display = request?.displayReason;
  const reason = [display, display?.zh, display?.en, request?.reason]
    .find(value => typeof value === 'string' && value.trim());
  return {
    agentId: String(request?.agent?.id ?? request?.agentId ?? ''),
    text: reason ? `Allow ${tool}? ${reason}` : `Allow ${tool}?`,
    choices: ['Allow once', 'Reject'],
  };
}

