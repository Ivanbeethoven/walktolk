import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';

const originalTemp = process.env.TEMP;
const originalTmp = process.env.TMP;
const originalTmpdir = process.env.TMPDIR;
const tempRoot = tmpdir();
const testTempDir = mkdtempSync(join(tempRoot, 'dsh-deck-ptt-test-'));
process.env.TEMP = testTempDir;
process.env.TMP = testTempDir;
process.env.TMPDIR = testTempDir;

const [{ apply }, { FakeDeck }] = await Promise.all([
  import('../lib/index.mjs'),
  import('../lib/transport/sim.mjs'),
]);

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

function voiceReport(body) {
  return Uint8Array.from([6, 7, body.length, ...body]);
}

test('apply sends a transcribed PTT utterance to agent.followup as a DSH user message', async () => {
  const utterance = 'sample speech';
  const followups = [];
  const agentContext = new EventEmitter();
  const agent = {
    id: 'fake-agent-1',
    name: 'test agent',
    project: 'deck-tests',
    state: 'working',
    ctx: agentContext,
    followup(message) {
      followups.push(message);
      return Promise.resolve();
    },
  };
  const services = {
    agents: { list: () => [agent] },
    speechToText: {
      resolve: ({ audio }) => ({ audio }),
      transcribe: async (spec) => {
        assert.ok(Buffer.isBuffer(spec.audio), 'speech service receives decoded WAV audio');
        return { text: utterance };
      },
    },
    sessionTitle: { get: () => undefined },
    tools: { register: () => {} },
  };
  const context = new EventEmitter();
  const disposeHandlers = [];
  const contextOn = context.on.bind(context);
  context.on = (event, listener, ...options) => {
    if (event === 'dispose') disposeHandlers.push(listener);
    return contextOn(event, listener, ...options);
  };
  context.inject = (names, register) => {
    const name = names[0];
    const service = services[name];
    register(service ? { [name]: service } : {});
  };
  context.get = (name) => services[name];

  let deck;
  const originalStart = FakeDeck.prototype.start;
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

    deck.pressPtt(1, 'talk');
    deck.onReport(voiceReport([0x01, 1, 1, 16, 20]));
    deck.onReport(voiceReport([0x02, 1, 0, 0, 0, 40, 0x11, 0x22]));
    deck.onReport(voiceReport([0x03, 1, 1, 0]));
    deck.emit({ m: 'ptt', act: 0, agent: 1, ctx: 'talk' });

    await waitUntil(() => followups.length === 1, 'agent follow-up');
    const message = followups[0];
    assert.deepEqual(Object.keys(message).sort(), ['content', 'id', 'role', 'source']);
    assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(message.role, 'user');
    assert.deepEqual(message.source, { kind: 'user' });
    assert.deepEqual(message.content, [{ type: 'text', text: utterance }]);
    assert.ok(deck.received.some((item) => item.m === 'transcript' && item.final === 1 && item.text === utterance));
  } finally {
    const dispose = disposeHandlers.at(-1);
    if (dispose) await dispose();
    FakeDeck.prototype.start = originalStart;
  }
});
