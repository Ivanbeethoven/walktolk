import assert from 'node:assert/strict';
import test from 'node:test';

import { CardBoard, approvalCard, questionCard } from '../lib/answerer.mjs';
import { DeckLink } from '../lib/link.mjs';
import { LineAssembler, frame } from '../lib/protocol.mjs';
import { Roster } from '../lib/roster.mjs';
import { FakeDeck } from '../lib/transport/sim.mjs';

const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));

/** A deck + link pair that has completed its first sync. */
async function connected() {
  const deck = new FakeDeck();
  const link = new DeckLink(
    { start: (fn) => deck.start(fn), write: (r) => deck.write(r), stop: () => deck.stop() },
    { sync: () => [] },
  );
  await link.start();
  await settle();
  return { deck, link };
}

test('a hello the device cannot answer with our sid triggers a sync, then `synced`', async () => {
  const { deck, link } = await connected();
  assert.equal(link.ready, true);
  assert.deepEqual(
    deck.received.map((message) => message.m),
    ['hello', 'synced', 'synced'],
  );
  await link.stop();
});

test('DeckLink completes a started multipart message, skips queued stale bodies, and reads pace changes', async () => {
  const reports = [];
  const paceAtWrite = [];
  let paceMs = 0;
  let firstWriteStarted;
  let releaseFirstWrite;
  let blockNextWrite = false;
  let startedReportCount = 0;
  const firstWriteStartedPromise = new Promise((resolve) => { firstWriteStarted = resolve; });
  const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
  const transport = {
    get paceMs() { return paceMs; },
    async start() {},
    async write(report) {
      reports.push(Buffer.from(report));
      paceAtWrite.push(paceMs);
      writeTimes.push(Date.now());
      if (blockNextWrite) {
        blockNextWrite = false;
        firstWriteStarted();
        await firstWriteGate;
      }
      if (reports.length === startedReportCount) paceMs = 0;
    },
    async stop() {},
  };
  const link = new DeckLink(transport);
  const sent = [];
  const writeTimes = [];
  link.on('sent', (message) => sent.push(message));
  const started = { m: 'doc', id: 'started', text: 'x'.repeat(520) };
  const staleOne = { m: 'doc', id: 'stale-one', text: 'old body one' };
  const staleTwo = { m: 'doc', id: 'stale-two', text: 'old body two' };
  const selected = { m: 'doc', id: 'selected', text: 'new selected body' };
  startedReportCount = frame(JSON.stringify(started)).length;
  assert.ok(startedReportCount >= 3, 'the first JSON line spans multiple reports');

  try {
    await link.start();
    await link.queue;
    reports.length = 0;
    paceAtWrite.length = 0;
    writeTimes.length = 0;
    sent.length = 0;
    let currentSelection = 'old';
    blockNextWrite = true;
    const startedSend = link.send(started, () => currentSelection === 'old');
    await Promise.race([
      firstWriteStartedPromise,
      settle(2000).then(() => { throw new Error('first message did not reach the blocked write'); }),
    ]);
    assert.deepEqual(sent.map((message) => message.id), ['started']);

    currentSelection = 'new';
    paceMs = 60;
    const staleOneSend = link.send(staleOne, () => currentSelection === 'old');
    const staleTwoSend = link.send(staleTwo, () => currentSelection === 'old');
    const selectedSend = link.send(selected, () => currentSelection === 'new');
    releaseFirstWrite();
    await Promise.all([startedSend, staleOneSend, staleTwoSend, selectedSend]);

    const assembler = new LineAssembler();
    const decoded = reports.flatMap((report) => assembler.push(report)).map((line) => JSON.parse(line));
    assert.deepEqual(decoded, [started, selected], 'started JSON is complete and only the current queued body follows it');
    assert.equal(assembler.pending.length, 0, 'no partial JSON remains in the report stream');
    assert.deepEqual(sent.map((message) => message.id), ['started', 'selected'], 'stale candidates are never marked sent');
    assert.equal(reports.length, startedReportCount + frame(JSON.stringify(selected)).length);

    assert.equal(paceAtWrite[0], 0, 'the first fragment uses the initial USB pace');
    assert.ok(paceAtWrite.slice(1, startedReportCount).every((value) => value === 60), 'remaining fragments observe the BLE pace');
    assert.equal(paceAtWrite.at(-1), 0, 'the selected body observes the USB pace after the switch back');
    for (let index = 1; index < startedReportCount; index += 1) {
      assert.ok(writeTimes[index] - writeTimes[index - 1] >= 50, 'BLE fragments keep the slower pacing interval');
    }
  } finally {
    releaseFirstWrite();
    await link.queue;
    await link.stop();
  }
});

test('a later hello for an unknown sid re-syncs without a new heartbeat', async () => {
  const { deck, link } = await connected();
  deck.received.length = 0;
  // A device that rebooted answers the next hello with sid 0.
  deck.reboot();
  deck.emit({
    m: 'hello', v: 1, fw: '0.15.0', sid: 0, boot: 1, rx: 1024,
    faces: [{ f: 1, t: 'agents', n: 'Agents' }],
  });
  await settle();
  assert.deepEqual(deck.received.map((message) => message.m), ['synced', 'synced']);
  await link.stop();
});

test('the roster keeps a slot stable and stays quiet when nothing changed', () => {
  const sent = [];
  const roster = new Roster((message) => sent.push(message), { limit: 4 });
  roster.update([
    { id: 'a', name: 'claude-a', project: 'deck', state: 'working', title: 'compiling' },
    { id: 'b', name: 'codex-b', project: 'api', state: 'question', title: 'run it?' },
  ]);
  // The question outranks the working row, so it gets slot 1.
  assert.equal(roster.slotOf('b'), 1);
  assert.equal(roster.slotOf('a'), 2);
  assert.equal(sent.length, 2);

  sent.length = 0;
  roster.update([
    { id: 'a', name: 'claude-a', project: 'deck', state: 'working', title: 'compiling' },
    { id: 'b', name: 'codex-b', project: 'api', state: 'question', title: 'run it?' },
  ]);
  assert.equal(sent.length, 0, 'identical rows are not re-sent');

  roster.update([{ id: 'a', name: 'claude-a', project: 'deck', state: 'ready', title: '' }]);
  assert.equal(sent.length, 2, 'the state change plus the gone row');
  assert.ok(sent.some((message) => message.gone === 1 && message.id === 1));
});

test('a card is presented, answered and cleared', async () => {
  const sent = [];
  const board = new CardBoard({
    send: (message) => sent.push(message),
    slotFor: () => 2,
    isReady: () => true,
  });
  const answer = board.ask({ agentId: 'x', text: 'Run migrations?', choices: ['Yes', 'No'] });
  await settle(5);
  const card = sent.at(-1);
  assert.equal(card.m, 'card');
  assert.equal(card.agent, 2);
  assert.deepEqual(card.choices, ['Yes', 'No']);

  board.answer(2, card.id, 1);
  assert.equal(await answer, 1);
  assert.deepEqual(sent.at(-1), { m: 'card', agent: 2, id: card.id, clear: 1 });
});

test('a snoozed card resolves null and shows nothing more', async () => {
  const sent = [];
  const board = new CardBoard({
    send: (message) => sent.push(message),
    slotFor: () => 1,
    isReady: () => true,
  });
  const answer = board.ask({ agentId: 'x', text: 'q', choices: ['a'] });
  await settle(5);
  board.snooze(1, sent.at(-1).id);
  assert.equal(await answer, null);
});

test('a second question for the same agent waits for the first to settle', async () => {
  const sent = [];
  const board = new CardBoard({
    send: (message) => sent.push(message),
    slotFor: () => 1,
    isReady: () => true,
  });
  const first = board.ask({ agentId: 'x', text: 'first', choices: ['ok'] });
  const second = board.ask({ agentId: 'x', text: 'second', choices: ['ok'] });
  await settle(5);
  const cards = sent.filter((message) => message.m === 'card');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].text, 'first');

  board.answer(1, cards[0].id, 0);
  assert.equal(await first, 0);
  await settle(5);
  assert.equal(sent.filter((message) => message.m === 'card').at(-1).text, 'second');
  board.releaseAll();
  assert.equal(await second, null);
});

test('no ready link means no card and an immediate hand-back', async () => {
  const board = new CardBoard({ send: () => {}, slotFor: () => 1, isReady: () => false });
  assert.equal(await board.ask({ agentId: 'x', text: 'q', choices: ['a'] }), null);
});

test('only single-select questions with up to four options become cards', () => {
  const base = {
    agent: { id: 'a1' },
    questions: [{
      id: 'q1',
      question: 'Which database?',
      options: [{ label: 'Postgres' }, { label: 'SQLite' }],
    }],
  };
  const card = questionCard(base);
  assert.deepEqual(card, {
    agentId: 'a1',
    questionId: 'q1',
    text: 'Which database?',
    choices: ['Postgres', 'SQLite'],
  });
  assert.equal(questionCard({ ...base, questions: [{ ...base.questions[0], multi_select: true }] }), null);
  assert.equal(questionCard({
    ...base,
    questions: [{ ...base.questions[0], options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' }] }],
  }), null);
  assert.equal(questionCard({ ...base, questions: [base.questions[0], base.questions[0]] }), null);
  assert.equal(questionCard({ ...base, questions: [] }), null);
});

test('an approval becomes a yes/no card naming the tool', () => {
  const card = approvalCard({ agent: { id: 'a1' }, tool: 'bash', reason: 'needs network' });
  assert.equal(card.agentId, 'a1');
  assert.equal(card.text, 'Allow bash? needs network');
  assert.deepEqual(card.choices, ['Allow once', 'Reject']);
});


