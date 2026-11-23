import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';

import { FakeDeck } from '../lib/transport/sim.mjs';

const originalTemp = process.env.TEMP;
const originalTmp = process.env.TMP;
const originalTmpdir = process.env.TMPDIR;
const tempRoot = tmpdir();
const testTempDir = mkdtempSync(join(tempRoot, 'dsh-deck-session-view-test-'));
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

async function waitUntil(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function fakeContext(services) {
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

test('the plugin opens a saved session, shows its 0.14 detail and status pages, and rejects stale revisions', async () => {
  const savedId = 'saved-session';
  const liveId = 'live-session';
  const savedEvents = [
    {
      type: 'user/message',
      time: 1_700_000_001_000,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Saved session prompt body' }],
      },
    },
    {
      type: 'assistant/message',
      time: 1_700_000_002_000,
      data: {
        message: { content: [{ type: 'text', text: 'Saved session response body' }] },
      },
    },
  ];
  const liveEvents = [
    {
      type: 'assistant/message',
      time: 1_700_000_003_000,
      data: {
        message: { content: [{ type: 'text', text: 'Live-only response body' }] },
      },
    },
  ];
  const liveAgentContext = new EventEmitter();
  const liveAgent = {
    id: liveId,
    name: 'Live agent',
    project: 'live project',
    status: 'working',
    ctx: liveAgentContext,
    session: { seq: 2, snapshotEvents: () => liveEvents },
  };
  const savedSession = {
    sessionId: savedId,
    running: false,
    agentAvailable: false,
    updatedAt: 1_700_000_000_000,
    projections: {
      values: {
        title: { title: 'Saved history title' },
        turnOutline: [{ prompt: 'List prompt body', response: 'List response body' }],
      },
    },
  };
  let listCalls = 0;
  let readSurfaceCalls = 0;
  let resumeCalls = 0;
  let createCalls = 0;
  let agentListCalls = 0;
  let finishSavedSurface;
  const savedSurfaceGate = new Promise((resolveSurface) => { finishSavedSurface = resolveSurface; });
  const services = {
    agents: {
      list: () => { agentListCalls += 1; return [liveAgent]; },
      create: () => { createCalls += 1; },
    },
    sessionController: {
      list: async () => { listCalls += 1; return { items: [savedSession] }; },
      resume: async () => { resumeCalls += 1; },
      create: async () => { createCalls += 1; },
    },
    sessionQuery: {
      readSurface: async (id) => {
        readSurfaceCalls += 1;
        assert.equal(id, savedId);
        return savedSurfaceGate;
      },
    },
    speechToText: {
      resolve: ({ audio }) => ({ audio }),
      transcribe: async () => ({ text: '' }),
    },
    sessionTitle: { get: () => undefined },
    tools: { register: () => {} },
  };
  const { context, disposeHandlers } = fakeContext(services);
  const originalStart = FakeDeck.prototype.start;
  const originalEmit = FakeDeck.prototype.emit;
  let deck;
  FakeDeck.prototype.start = async function start(onReport) {
    deck = this;
    return originalStart.call(this, onReport);
  };
  FakeDeck.prototype.emit = function emit(message) {
    const firmwareMessage = message?.m === 'hello' && message.fw === '0.15.0'
      ? { ...message, fw: '0.14.0', agents: 32 }
      : message;
    return originalEmit.call(this, firmwareMessage);
  };

  try {
    apply(context, { transport: 'sim', agentLimit: 32 });
    await waitUntil(() => deck && deck.agents.size === 2, 'the saved and live session rows');
    assert.ok(listCalls > 0, 'the plugin read the saved-session catalog');
    assert.ok(agentListCalls > 0);
    const rows = [...deck.agents.values()];
    const savedRow = rows.find((row) => row.name === 'Saved history title');
    const liveRow = rows.find((row) => row.name === 'Live agent');
    assert.ok(savedRow);
    assert.ok(liveRow);
    assert.equal(savedRow.task, 'Saved history title', '0.14 firmware receives the session detail field');
    assert.equal(liveRow.task, 'Live agent');

    deck.emit({ m: 'channel', agent: savedRow.id, seq: 7 });
    deck.emit({ m: 'doclines', agent: savedRow.id, d: 'w', id: 0, first: 0 });
    await waitUntil(() => readSurfaceCalls === 1 && deck.received.some((message) =>
      message.m === 'doc' && message.agent === savedRow.id && message.d === 'w'
      && message.lines?.join('\n').includes('Saved history title')),
    'the first status-page switch with revision zero');
    const firstStatus = deck.received.filter((message) => message.m === 'doc' && message.agent === savedRow.id).at(-1);
    assert.equal(firstStatus.d, 'w');
    assert.ok(firstStatus.lines.join('\n').includes('状态 · 未运行'));
    assert.ok(firstStatus.lines.join('\n').includes('List prompt body'));
    const firstReply = deck.received.filter((message) => message.m === 'reply' && message.agent === savedRow.id).at(-1);
    assert.equal(firstReply.text, 'List response body');

    finishSavedSurface({ events: savedEvents });
    await waitUntil(() => deck.received.some((message) =>
      message.m === 'doc' && message.agent === savedRow.id && message.d === 'w'
      && (message.lines ?? []).join('').includes('Saved session response body')),
    'the saved session status page after reading its surface');
    const savedStatus = deck.received.filter((message) => message.m === 'doc' && message.agent === savedRow.id).at(-1);
    assert.notEqual(savedStatus.id, firstStatus.id);
    assert.ok(savedStatus.lines.join('\n').includes('Saved history title'));
    assert.ok(savedStatus.lines.join('\n').includes('状态 · 未运行'));
    assert.ok(savedStatus.lines.join('').includes('最近活动 · Saved session response body'));
    assert.ok(savedStatus.lines.join('\n').includes('最近提问'));
    assert.ok(savedStatus.lines.join('\n').includes('Saved session prompt body'));
    const statusReply = deck.received.filter((message) => message.m === 'reply' && message.agent === savedRow.id).at(-1);
    assert.equal(statusReply.text, 'Saved session response body');

    deck.emit({ m: 'channel', agent: liveRow.id, seq: 8 });
    await waitUntil(() => deck.received.some((message) =>
      message.m === 'doc' && message.agent === liveRow.id && message.d === 'r'
      && message.lines?.join('\n').includes('Live-only response body')),
    'the live session reading page');
    const liveDoc = deck.received.filter((message) => message.m === 'doc' && message.agent === liveRow.id).at(-1);
    assert.notEqual(liveDoc.id, savedStatus.id);
    assert.ok(liveDoc.lines.join('\n').includes('Live-only response body'));

    const docCount = deck.received.filter((message) => message.m === 'doc').length;
    deck.emit({ m: 'doclines', agent: liveRow.id, d: 'w', id: savedStatus.id, first: 0 });
    await delay(30);
    assert.equal(deck.received.filter((message) => message.m === 'doc').length, docCount,
      'a revision from the saved session does not return the selected live session document');
    assert.equal(readSurfaceCalls, 1, 'opening a saved session reads its surface without resuming it');
    assert.equal(resumeCalls, 0);
    assert.equal(createCalls, 0);
    assert.equal(services.agents.list().length, 1, 'opening history does not create an agent');
  } finally {
    const dispose = disposeHandlers.at(-1);
    if (dispose) await dispose();
    FakeDeck.prototype.start = originalStart;
    FakeDeck.prototype.emit = originalEmit;
  }
});
