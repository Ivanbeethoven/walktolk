import assert from 'node:assert/strict';
import test from 'node:test';

import { CardBoard } from '../lib/answerer.mjs';
import { askOnBoth } from '../lib/phone-answer.mjs';

const card = {
  agentId: 'agent-1',
  questionId: 'question-1',
  text: 'Choose a route',
  choices: ['Deck route', 'Phone route'],
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function controlledBoard() {
  return {
    calls: 0,
    card: null,
    signal: null,
    choose: null,
    ask(question, signal) {
      this.calls += 1;
      this.card = question;
      this.signal = signal;
      return new Promise((resolve) => {
        let settled = false;
        const settle = (choice) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', cancel);
          resolve(choice);
        };
        const cancel = () => settle(null);
        this.choose = settle;
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, { once: true });
      });
    },
  };
}

function controlledPhone(request) {
  const started = deferred();
  let finish;
  let signal;
  let calls = 0;

  const next = () => {
    calls += 1;
    signal = request.signal;
    started.resolve();
    return new Promise((resolve, reject) => {
      finish = resolve;
      const cancel = () => reject(abortError());
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
  };

  return {
    next,
    started: started.promise,
    get calls() { return calls; },
    get signal() { return signal; },
    answer(value) { finish(value); },
  };
}

function requestWithSignal(signal = new AbortController().signal) {
  return { signal, agent: { id: card.agentId } };
}

test('phone answer wins, clears the deck card, and is returned unchanged', async () => {
  const original = new AbortController().signal;
  const request = requestWithSignal(original);
  const board = controlledBoard();
  const phone = controlledPhone(request);
  const phoneAnswer = { answers: [{ id: card.questionId, selected: ['Phone route'] }] };

  const result = askOnBoth(request, card, board, phone.next);
  await phone.started;
  assert.notStrictEqual(phone.signal, original);
  phone.answer(phoneAnswer);

  assert.strictEqual(await result, phoneAnswer);
  assert.equal(board.calls, 1);
  assert.equal(board.signal.aborted, true, 'the deck branch is cancelled when the phone answers');
  assert.equal(phone.calls, 1);
  assert.equal(phone.signal.aborted, true, 'the temporary phone signal is cleaned up');
  assert.strictEqual(request.signal, original);
});

test('deck answer wins and cancels the phone next signal', async () => {
  const original = new AbortController().signal;
  const request = requestWithSignal(original);
  const board = controlledBoard();
  const phone = controlledPhone(request);

  const result = askOnBoth(request, card, board, phone.next);
  await phone.started;
  board.choose(1);

  assert.deepEqual(await result, {
    answers: [{ id: card.questionId, selected: ['Phone route'] }],
  });
  assert.equal(board.calls, 1);
  assert.equal(board.signal.aborted, true, 'the temporary deck signal is cleaned up');
  assert.equal(phone.calls, 1);
  assert.equal(phone.signal.aborted, true, 'the phone answerer is cancelled when the deck answers');
  assert.strictEqual(request.signal, original);
});

test('a missing phone provider does not prevent a deck answer', async () => {
  const original = new AbortController().signal;
  const request = requestWithSignal(original);
  const board = controlledBoard();
  const noProvider = new Error('NO_PROVIDER');
  const rejected = deferred();
  let nextCalls = 0;
  let nextSignal;
  const next = () => {
    nextCalls += 1;
    nextSignal = request.signal;
    return Promise.reject(noProvider).catch((error) => {
      rejected.resolve(error);
      throw error;
    });
  };

  const result = askOnBoth(request, card, board, next);
  assert.strictEqual(await rejected.promise, noProvider);
  assert.equal(board.signal.aborted, false, 'the deck remains active when no phone provider exists');
  board.choose(0);

  assert.deepEqual(await result, {
    answers: [{ id: card.questionId, selected: ['Deck route'] }],
  });
  assert.equal(nextCalls, 1);
  assert.equal(nextSignal.aborted, true);
  assert.strictEqual(request.signal, original);
});

test('a deck cancel hands the same request to the phone answerer', async () => {
  const original = new AbortController().signal;
  const request = requestWithSignal(original);
  const board = controlledBoard();
  const phone = controlledPhone(request);
  const phoneAnswer = { answers: [{ id: card.questionId, selected: ['Phone route'] }] };

  const result = askOnBoth(request, card, board, phone.next);
  await phone.started;
  board.choose(null);
  assert.equal(phone.signal.aborted, false, 'letting go on the deck leaves the phone answerer active');
  phone.answer(phoneAnswer);

  assert.strictEqual(await result, phoneAnswer);
  assert.equal(board.calls, 1);
  assert.equal(phone.calls, 1);
  assert.strictEqual(request.signal, original);
});

test('caller cancellation stops both branches and restores the original signal', async () => {
  const caller = new AbortController();
  const request = requestWithSignal(caller.signal);
  const board = controlledBoard();
  const phone = controlledPhone(request);

  const result = askOnBoth(request, card, board, phone.next);
  await phone.started;
  const deckSignal = board.signal;
  const phoneSignal = phone.signal;
  caller.abort();

  await assert.rejects(result);
  assert.equal(deckSignal.aborted, true);
  assert.equal(phoneSignal.aborted, true);
  assert.equal(board.calls, 1);
  assert.equal(phone.calls, 1);
  assert.strictEqual(request.signal, caller.signal);
});

test('next is called once even when the deck cancels before the phone answers', async () => {
  const request = requestWithSignal();
  const board = controlledBoard();
  const phone = controlledPhone(request);
  const phoneAnswer = { answers: [{ id: card.questionId, selected: ['Phone route'] }] };

  const result = askOnBoth(request, card, board, phone.next);
  await phone.started;
  board.choose(null);
  phone.answer(phoneAnswer);

  assert.strictEqual(await result, phoneAnswer);
  assert.equal(phone.calls, 1);
});

test('aborting a visible CardBoard question clears its card', async () => {
  const sent = [];
  const board = new CardBoard({ send: (message) => sent.push(message), slotFor: () => 1, isReady: () => true });
  const controller = new AbortController();

  const answer = board.ask({ ...card }, controller.signal);
  const visible = sent.find((message) => message.m === 'card');
  assert.ok(visible);
  assert.equal(board.size, 1);

  controller.abort();

  assert.equal(await answer, null);
  assert.deepEqual(sent.at(-1), { m: 'card', agent: visible.agent, id: visible.id, clear: 1 });
  assert.equal(board.size, 0);
});

test('aborting a waiting CardBoard question leaves other visible cards intact', async () => {
  const sent = [];
  const board = new CardBoard({
    send: (message) => sent.push(message),
    slotFor: (agentId) => agentId === 'agent-2' ? 2 : 1,
    isReady: () => true,
  });
  const waitingController = new AbortController();
  const visibleAnswer = board.ask({ ...card, text: 'Visible question' });
  const waitingAnswer = board.ask({ ...card, text: 'Waiting question' }, waitingController.signal);
  const otherAnswer = board.ask({ ...card, agentId: 'agent-2', text: 'Other visible question' });
  const visible = sent.find((message) => message.text === 'Visible question');
  const other = sent.find((message) => message.text === 'Other visible question');

  assert.ok(visible);
  assert.ok(other);
  assert.equal(board.size, 2);
  waitingController.abort();

  assert.equal(await waitingAnswer, null);
  assert.equal(board.size, 2);
  assert.equal(sent.some((message) => message.text === 'Waiting question'), false);
  assert.equal(sent.some((message) => message.clear === 1), false, 'a waiting card was never drawn and needs no clear');

  assert.equal(board.answer(visible.agent, visible.id, 0), true);
  assert.equal(await visibleAnswer, 0);
  assert.equal(sent.some((message) => message.text === 'Waiting question'), false);
  assert.equal(board.size, 1, 'the other agent card remains open');

  assert.equal(board.answer(other.agent, other.id, 1), true);
  assert.equal(await otherAnswer, 1);
  assert.equal(board.size, 0);
});
