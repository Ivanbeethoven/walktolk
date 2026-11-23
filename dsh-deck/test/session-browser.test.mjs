import assert from 'node:assert/strict';
import test from 'node:test';

import { capabilities } from '../lib/caps.mjs';
import { Roster } from '../lib/roster.mjs';
import { foldActivity, listedSession, SessionPages, documentWindow, wrapLines } from '../lib/session-browser.mjs';

const PAGE_LIMIT = 8;

function makeEntries(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${String(index).padStart(2, '0')}`,
    name: `Agent ${index}`,
    state: index === 20 ? 'question' : 'working',
    title: `Task ${index}`,
    updatedAt: index,
  }));
}

function navigationEntries(rows) {
  return rows.filter((entry) => Number.isInteger(entry.targetPage));
}

function sessionIds(rows, entries) {
  const knownIds = new Set(entries.map((entry) => entry.id));
  return rows.filter((entry) => knownIds.has(entry.id)).map((entry) => entry.id);
}

function pageRows(pages, entries, pinned) {
  const rows = pages.rows(entries, pinned);
  assert.ok(rows.length <= PAGE_LIMIT, 'the rendered roster fits the eight available rows');
  assert.ok(navigationEntries(rows).length <= PAGE_LIMIT, 'navigation uses no more than eight rows');
  return rows;
}

test('SessionPages traverses a directory larger than eight rows in both directions', () => {
  const entries = makeEntries(25);
  const pages = new SessionPages(PAGE_LIMIT);
  const pinned = new Set(['session-20']);
  const visited = new Set();
  let rows = pageRows(pages, entries, pinned);

  for (const id of sessionIds(rows, entries)) visited.add(id);
  assert.ok(rows.some((entry) => entry.id === 'session-20'), 'the active approval is visible on the first page');

  let currentPage = 0;
  let steps = 0;
  while (visited.size < entries.length && steps < entries.length) {
    const next = navigationEntries(rows)
      .filter((entry) => entry.targetPage > currentPage)
      .sort((left, right) => left.targetPage - right.targetPage)[0];
    assert.ok(next, 'a forward page is available until every session has been visited');
    assert.equal(pages.turn(next), true, 'a currently displayed navigation entry changes page');
    currentPage = next.targetPage;
    rows = pageRows(pages, entries, pinned);
    assert.ok(rows.some((entry) => entry.id === 'session-20'), 'the active approval remains visible while paging forward');
    for (const id of sessionIds(rows, entries)) visited.add(id);
    steps += 1;
  }

  assert.deepEqual([...visited].sort(), entries.map((entry) => entry.id).sort());
  assert.ok(steps > 0);

  steps = 0;
  while (currentPage > 0 && steps < entries.length) {
    const previous = navigationEntries(rows)
      .filter((entry) => entry.targetPage < currentPage)
      .sort((left, right) => right.targetPage - left.targetPage)[0];
    if (!previous) break;
    assert.equal(pages.turn(previous), true, 'a currently displayed navigation entry changes page backward');
    currentPage = previous.targetPage;
    rows = pageRows(pages, entries, pinned);
    assert.ok(rows.some((entry) => entry.id === 'session-20'), 'the active approval remains visible while paging backward');
    for (const id of sessionIds(rows, entries)) visited.add(id);
    steps += 1;
  }

  assert.equal(currentPage, 0, 'backward navigation reaches the first page');
  assert.deepEqual([...visited].sort(), entries.map((entry) => entry.id).sort());
});

test('SessionPages accepts each displayed navigation entry once and rejects ordinary rows', () => {
  const entries = makeEntries(12);
  const pages = new SessionPages(PAGE_LIMIT);
  const rows = pageRows(pages, entries);
  const navigation = navigationEntries(rows).find((entry) => entry.targetPage > 0);
  const ordinary = rows.find((entry) => Number.isInteger(entry.targetPage) === false);

  assert.ok(navigation, 'a forward navigation row is available');
  assert.ok(ordinary, 'an ordinary roster row is available');
  assert.equal(pages.turn(ordinary), false);
  assert.equal(pages.turn(navigation), true);
  const nextRows = pageRows(pages, entries);
  assert.notDeepEqual(sessionIds(nextRows, entries), sessionIds(rows, entries), 'the page content changes');
  assert.equal(pages.turn(navigation), false, 'a previously displayed navigation object cannot trigger another turn');
});

test('wrapLines preserves explicit breaks and complete UTF-8 text within 48 bytes per line', () => {
  assert.deepEqual(wrapLines('first line\nsecond line'), ['first line', 'second line']);

  const source = `${'中文'.repeat(17)}🙂${'é'.repeat(19)}${'x'.repeat(20)}`;
  const lines = wrapLines(source);
  assert.ok(Array.isArray(lines));
  assert.ok(lines.length > 1, 'long text is split into display lines');
  assert.ok(lines.every((line) => Buffer.byteLength(line, 'utf8') <= 48));
  assert.equal(lines.join(''), source, 'wrapping preserves every visible character');
  assert.ok(lines.some((line) => line.includes('🙂')), 'the four-byte emoji remains intact');
  assert.ok(lines.every((line) => !line.includes('\uFFFD')), 'UTF-8 characters are not split');
});

test('documentWindow emits bounded document pages and treats 65535 as the final-page request', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line-${String(index).padStart(2, '0')}-content`);
  const first = documentWindow(3, 'session', 42, lines, 0);
  const last = documentWindow(3, 'session', 42, lines, 65535);

  for (const message of [first, last]) {
    assert.equal(message.m, 'doc');
    assert.ok(Buffer.byteLength(`${JSON.stringify(message)}\n`, 'utf8') <= 1000, 'JSON plus LF fits the device limit');
  }

  const visibleLines = (message) => lines.filter((line) => JSON.stringify(message).includes(line));
  const firstVisible = visibleLines(first);
  const lastVisible = visibleLines(last);
  assert.ok(firstVisible.length > 0 && firstVisible.length <= 17, 'the first document page contains at most 17 lines');
  assert.ok(lastVisible.length > 0 && lastVisible.length <= 17, 'the final document page contains at most 17 lines');
  assert.deepEqual(firstVisible, lines.slice(0, firstVisible.length), 'the initial request begins with the first source line');
  assert.deepEqual(lastVisible, lines.slice(-lastVisible.length), '65535 selects a page ending at the final source line');
});

test('listedSession reads real session list projections and distinguishes current from historical sessions', () => {
  const current = listedSession({
    sessionId: 'current-session',
    running: true,
    agentAvailable: true,
    updatedAt: 1234,
    projections: {
      values: {
        title: { title: 'Projected session title' },
        turnOutline: [
          { prompt: 'Earlier prompt', response: 'Earlier response' },
          { prompt: 'Latest prompt', response: 'Latest response' },
        ],
      },
    },
  });
  assert.deepEqual(current, {
    id: 'current-session',
    name: 'Projected session title',
    prompt: 'Latest prompt',
    answer: 'Latest response',
    state: 'working',
    historical: false,
    updatedAt: 1234,
  });

  const available = listedSession({
    sessionId: 'available-session',
    running: false,
    agentAvailable: true,
    projections: { values: { title: { title: 'Available' }, turnOutline: [] } },
  });
  assert.equal(available.state, 'ready');
  assert.equal(available.historical, false);

  const historical = listedSession({
    sessionId: 'historical-session',
    running: false,
    agentAvailable: false,
    projections: {
      values: {
        title: { title: 'Archived title' },
        turnOutline: [{ prompt: 'Archived prompt', response: 'Archived answer' }],
      },
    },
  });
  assert.equal(historical.state, 'idle');
  assert.equal(historical.historical, true);
  assert.equal(historical.prompt, 'Archived prompt');
  assert.equal(historical.answer, 'Archived answer');
});

test('foldActivity extracts public text and tool names from live and historical event shapes', () => {
  const events = [
    {
      type: 'user/message',
      time: 10,
      data: {
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'Please inspect this session.' },
          { type: 'image', data: 'private-image-payload' },
        ],
      },
    },
    {
      type: 'assistant/message',
      time: 20,
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'PRIVATE_REASONING' },
            { type: 'text', text: 'The session is healthy.' },
            { type: 'toolCall', name: 'session_search', arguments: { query: 'PRIVATE_TOOL_ARGUMENT' } },
          ],
        },
      },
    },
    {
      type: 'tool/result',
      time: 30,
      data: {
        message: {
          toolName: 'session_search',
          content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT_BODY' }],
        },
      },
    },
  ];

  const live = foldActivity(events);
  assert.equal(live.prompt, 'Please inspect this session.');
  assert.equal(live.answer, 'The session is healthy.');
  assert.equal(live.activity, '已收到工具结果 · session_search');
  assert.equal(live.updatedAt, 30);
  const visible = JSON.stringify(live);
  assert.ok(!visible.includes('PRIVATE_REASONING'));
  assert.ok(!visible.includes('PRIVATE_TOOL_ARGUMENT'));
  assert.ok(!visible.includes('PRIVATE_TOOL_RESULT_BODY'));

  const historical = foldActivity(events.slice(0, 2), { historical: true, state: 'idle' });
  assert.equal(historical.historical, true);
  assert.equal(historical.state, 'idle');
  assert.equal(historical.prompt, 'Please inspect this session.');
  assert.equal(historical.answer, 'The session is healthy.');
  assert.equal(historical.activity, '调用工具 session_search');
  assert.ok(!JSON.stringify(historical).includes('PRIVATE_TOOL_ARGUMENT'));
});

test('SessionPages uses six-row native groups for current and historical sessions without synthetic navigation', () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({
    id: `session-${index}`,
    name: `Session ${index}`,
    state: 'ready',
    title: `Title ${index}`,
    updatedAt: index,
    historical: index % 2 === 1,
  }));
  const rows = new SessionPages(255).rows(entries);

  assert.equal(rows.length, entries.length);
  assert.deepEqual(rows.map((entry) => entry.id).sort(), entries.map((entry) => entry.id).sort());
  assert.ok(rows.every((entry) => !Number.isInteger(entry.targetPage)), 'native group changes need no synthetic page entries');

  const groups = new Map();
  for (const entry of rows) {
    const [groupNumber, section] = entry.project.split(' ');
    const key = `${section}/${groupNumber}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const [key, members] of groups) {
    assert.ok(members.length <= 6, `${key} contains no more than six sessions`);
    assert.ok(members.every((entry) => `${entry.historical ? '历史会话' : '当前会话'}/${entry.project.split(' ')[0]}` === key));
  }
  assert.deepEqual(
    [...groups.keys()].sort(),
    ['当前会话/01', '当前会话/02', '当前会话/03', '历史会话/04', '历史会话/05', '历史会话/06'].sort(),
  );
  assert.deepEqual([...groups.values()].map((members) => members.length).sort((a, b) => b - a), [6, 6, 6, 6, 3, 3]);
});

test('Roster sends 32 sessions into capability-advertised slots above eight', () => {
  const caps = capabilities({ fw: '0.14.0', agents: 32 });
  const sent = [];
  const roster = new Roster((message) => sent.push(message), { limit: 32, caps: () => caps });
  const entries = Array.from({ length: 32 }, (_, index) => ({
    id: `agent-${index}`,
    name: `agent ${index}`,
    project: 'native group',
    state: 'working',
    title: `session ${index}`,
  }));

  assert.equal(caps.slots, 32);
  roster.update(entries, { paged: true });
  assert.equal(sent.length, 32);
  assert.equal(roster.snapshot().length, 32);
  assert.equal(Math.max(...sent.map((message) => message.id)), 32);
  assert.deepEqual(sent.map((message) => message.id).sort((a, b) => a - b), Array.from({ length: 32 }, (_, index) => index + 1));
  assert.ok(sent.every((message) => Number.isInteger(message.id) && message.id >= 1 && message.id <= caps.slots));
});

test('Roster limits paged updates and gone rows to the per-call budget until the catalog settles', () => {
  const caps = capabilities({ fw: '0.14.0', agents: 62 });
  const sent = [];
  const roster = new Roster((message) => sent.push(message), { limit: 62, caps: () => caps });
  const entries = Array.from({ length: 62 }, (_, index) => ({
    id: `agent-${index}`,
    name: `agent ${index}`,
    project: 'native group',
    state: 'working',
    title: `session ${index}`,
  }));

  let pending = true;
  let rounds = 0;
  while (pending && rounds < 100) {
    const before = sent.length;
    pending = roster.update(entries, { paged: true, budget: 2 });
    assert.ok(sent.length - before <= 2, 'one update sends no more than two rows');
    rounds += 1;
  }
  assert.equal(pending, false, 'repeated updates eventually send the complete catalog');
  const initialRows = sent.filter((message) => !message.gone);
  assert.equal(initialRows.length, 62);
  assert.deepEqual(initialRows.map((message) => message.id).sort((a, b) => a - b), Array.from({ length: 62 }, (_, index) => index + 1));
  assert.equal(new Set(initialRows.map((message) => message.id)).size, 62, 'each session row is sent once');

  const reduced = entries.slice(0, 30);
  pending = true;
  rounds = 0;
  while (pending && rounds < 100) {
    const before = sent.length;
    pending = roster.update(reduced, { paged: true, budget: 2 });
    assert.ok(sent.length - before <= 2, 'one shrinking update sends no more than two rows');
    rounds += 1;
  }
  assert.equal(pending, false, 'repeated updates eventually clear every removed row');
  const goneRows = sent.filter((message) => message.gone === 1);
  assert.equal(goneRows.length, 32);
  assert.deepEqual(goneRows.map((message) => message.id).sort((a, b) => a - b), Array.from({ length: 32 }, (_, index) => index + 31));
  assert.equal(new Set(goneRows.map((message) => message.id)).size, 32, 'each removed row is cleared once');
  assert.equal(roster.snapshot().length, 30);
  assert.equal(roster.slotOf('agent-30'), undefined);
  assert.equal(roster.slotOf('agent-61'), undefined);
});
