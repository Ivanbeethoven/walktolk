import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';

import { approvalCard } from '../lib/answerer.mjs';
import { FakeDeck } from '../lib/transport/sim.mjs';

const originalTemp = process.env.TEMP;
const originalTmp = process.env.TMP;
const originalTmpdir = process.env.TMPDIR;
const tempRoot = tmpdir();
const testTempDir = mkdtempSync(join(tempRoot, 'dsh-deck-approval-test-'));
process.env.TEMP = testTempDir;
process.env.TMP = testTempDir;
process.env.TMPDIR = testTempDir;
const { apply } = await import('../lib/index.mjs');

after(() => {
  if (originalTemp === undefined) delete process.env.TEMP;
  else process.env.TEMP = originalTemp;
  if (originalTmp === undefined) delete process.env.TMP;
  else process.env.TMP = originalTmp;
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;

  const base = resolve(tempRoot) + sep;
  const target = resolve(testTempDir);
  if (target.startsWith(base)) rmSync(target, { recursive: true, force: true });
});

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function waitUntil(predicate, label, timeoutMs = 3500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function fakeContext(agent, services) {
  const context = new EventEmitter();
  const disposeHandlers = [];
  const originalOn = context.on.bind(context);
  context.on = (event, listener, ...options) => {
    if (event === 'dispose') disposeHandlers.push(listener);
    return originalOn(event, listener, ...options);
  };
  context.inject = (names, register) => {
    const name = names[0];
    const service = services[name];
    register(service ? { [name]: service } : {});
  };
  context.get = (name) => services[name];
  return { context, disposeHandlers };
}

async function withSimulatedPlugin(agent, action) {
  const services = {
    agents: { list: () => [agent] },
    speechToText: {
      resolve: ({ audio }) => ({ audio }),
      transcribe: async () => ({ text: '' }),
    },
    sessionTitle: { get: () => undefined },
    tools: { register: () => {} },
  };
  const { context, disposeHandlers } = fakeContext(agent, services);
  const originalStart = FakeDeck.prototype.start;
  let deck;
  FakeDeck.prototype.start = async function start(onReport) {
    deck = this;
    return originalStart.call(this, onReport);
  };
  try {
    apply(context, { transport: 'sim' });
    await waitUntil(() => deck && deck.received.filter((message) => message.m === 'synced').length >= 2,
      'simulated deck handshake');
    await waitUntil(() => deck.agents.has(1), 'fake agent roster row');
    await delay(20);
    await action({ context, deck, disposeHandlers });
  } finally {
    const dispose = disposeHandlers.at(-1);
    if (dispose) await dispose();
    FakeDeck.prototype.start = originalStart;
  }
}

const localizedReason = {
  en: 'Read the test resource',
  zh: '读取测试资源',
};

test('approvalCard uses toolName and a localized displayReason entry', () => {
  const card = approvalCard({
    agent: { id: 'approval-agent' },
    toolName: 'file_read',
    displayReason: localizedReason,
    reason: 'raw fallback reason',
  });
  assert.equal(card.agentId, 'approval-agent');
  assert.ok([
    'Allow file_read? Read the test resource',
    'Allow file_read? 读取测试资源',
  ].includes(card.text));
  assert.deepEqual(card.choices, ['Allow once', 'Reject']);
  assert.doesNotMatch(card.text, /\[object Object\]/);
});

test('approvalCard falls back to the raw reason when no display locale is available', () => {
  const card = approvalCard({
    toolName: 'file_read',
    displayReason: { en: '', zh: '' },
    reason: 'raw approval reason',
  });
  assert.equal(card.text, 'Allow file_read? raw approval reason');
});

test('approvalCard keeps the legacy tool field working', () => {
  const card = approvalCard({ agent: { id: 'legacy-agent' }, tool: 'bash', reason: 'needs network' });
  assert.equal(card.agentId, 'legacy-agent');
  assert.equal(card.text, 'Allow bash? needs network');
});

test('the real approval handler clears an aborted card and returns cancelled', async () => {
  const agentContext = new EventEmitter();
  const agent = {
    id: 'approval-cancel-agent',
    name: 'approval test agent',
    project: 'deck-tests',
    state: 'working',
    ctx: agentContext,
  };
  await withSimulatedPlugin(agent, async ({ deck }) => {
    const handler = agentContext.listeners('approval/request')[0];
    assert.equal(typeof handler, 'function');
    const controller = new AbortController();
    const request = {
      agent,
      toolName: 'file_read',
      displayReason: localizedReason,
      reason: 'raw approval reason',
      signal: controller.signal,
    };
    let nextCalls = 0;
    const result = handler.call(agentContext, request, () => {
      nextCalls++;
      return 'next-answerer';
    });

    await waitUntil(() => deck.cards.size === 1, 'approval card presentation');
    const [visibleCard] = deck.cards.values();
    assert.ok([
      'Allow file_read? Read the test resource',
      'Allow file_read? 读取测试资源',
    ].includes(visibleCard.text));
    assert.deepEqual(visibleCard.choices, ['Allow once', 'Reject']);

    controller.abort();
    assert.equal(await result, 'cancelled');
    await waitUntil(() => deck.cards.size === 0, 'aborted approval card clear');
    assert.ok(deck.received.some((message) => message.m === 'card'
      && message.agent === visibleCard.agent && message.id === visibleCard.id && message.clear === 1));
    assert.equal(nextCalls, 0, 'an aborted request does not advance to the next answerer');
    assert.equal(request.signal, controller.signal);
  });
});
