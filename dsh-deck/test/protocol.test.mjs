import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHUNK_BYTES,
  LineAssembler,
  REPORT_BYTES,
  agentRow,
  cardMessage,
  cut,
  frame,
} from '../lib/protocol.mjs';

test('a short line becomes one report whose length byte counts the payload', () => {
  const reports = frame('{"m":"synced"}');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].length, REPORT_BYTES);
  assert.equal(reports[0][0], 6);
  assert.equal(reports[0][1], 5);
  assert.equal(reports[0][2], Buffer.byteLength('{"m":"synced"}\n'));
  assert.equal(reports[0].subarray(3, 3 + reports[0][2]).toString(), '{"m":"synced"}\n');
  assert.ok(reports[0].subarray(3 + reports[0][2]).every((byte) => byte === 0));
});

test('a long line spans reports and reassembles byte for byte', () => {
  const line = JSON.stringify({ m: 'card', text: 'x'.repeat(300) });
  const reports = frame(line);
  assert.equal(reports.length, Math.ceil((line.length + 1) / CHUNK_BYTES));
  const assembler = new LineAssembler();
  const lines = reports.flatMap((report) => assembler.push(report));
  assert.deepEqual(lines, [line]);
});

test('a line ending mid-report is delivered with the next report', () => {
  const first = frame('{"m":"agent","id":1}');
  const second = frame('{"m":"agent","id":2}');
  const joined = Buffer.concat([first[0], second[0]]);
  const assembler = new LineAssembler();
  // Squeeze both reports into one buffer to prove the LF is what splits them.
  const lines = assembler.push(joined);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '{"m":"agent","id":1}');
});

test('other channels and other report ids are ignored', () => {
  const assembler = new LineAssembler();
  assert.deepEqual(assembler.push(Uint8Array.from([6, 7, 3, 123, 125, 10])), []);
  assert.deepEqual(assembler.push(Uint8Array.from([2, 5, 3, 123, 125, 10])), []);
});

test('a truncated report is dropped rather than trusted', () => {
  const assembler = new LineAssembler();
  assert.deepEqual(assembler.push(Uint8Array.from([6, 5, 61, 123, 125])), []);
});

test('cut keeps whole characters at the UTF-8 boundary', () => {
  assert.equal(cut('abcdef', 3), 'abc');
  assert.equal(cut('中文', 4), '中'); // 3 bytes each, 4-byte budget
  assert.equal(cut('中文', 6), '中文');
  assert.equal(cut('a中', 1), 'a');
  assert.equal(cut(undefined, 4), '');
});

test('an agent row cuts its own fields to the budgets the firmware expects', () => {
  const row = agentRow({
    id: 1,
    name: 'a'.repeat(40),
    proj: 'p',
    state: 'question',
    title: 'multi\nline   title',
    since: 12.6,
  });
  assert.equal(row.m, 'agent');
  assert.equal(Buffer.byteLength(row.name, 'utf8'), 24, 'a cut name keeps the byte budget');
  assert.ok(row.name.endsWith('…'), 'and says that it was cut');
  assert.equal(row.title, 'multi line title');
  assert.equal(row.since, 13);
});

test('a CJK session title is fitted, not silently mangled', () => {
  const row = agentRow({ id: 1, name: '重构语音输入的握手流程', state: 'working' });
  assert.ok(Buffer.byteLength(row.name, 'utf8') <= 24);
  assert.ok(row.name.endsWith('…'));
});

test('a card carries at most four choices and clears by id alone', () => {
  const card = cardMessage({
    agent: 2,
    id: 7,
    text: 'Run migrations?',
    choices: ['one', 'two', 'three', 'four', 'five'],
  });
  assert.equal(card.choices.length, 4);
  assert.equal(card.type, 'q');
  assert.deepEqual(cardMessage({ agent: 2, id: 7, clear: true }), { m: 'card', agent: 2, id: 7, clear: 1 });
});
