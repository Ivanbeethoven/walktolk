/**
 * Push a small demo onto the deck and print everything it sends back.
 *
 *   node bin/demo.mjs            # 90 seconds, then exits
 *   node bin/demo.mjs --seconds 600
 *
 * This is the fastest way to see the whole path working against real hardware:
 * three roster rows, one question card with three choices, and the deck's own
 * events (answer, ptt, channel, face) printed as they arrive.
 */

import { DeckLink } from '../lib/link.mjs';
import { agentRow, cardMessage } from '../lib/protocol.mjs';
import { openDeck } from '../lib/transport/hid-win.mjs';

const argv = process.argv.slice(2);
const secondsAt = argv.indexOf('--seconds');
const seconds = secondsAt >= 0 ? Number(argv[secondsAt + 1]) || 90 : 90;

const transport = await openDeck({ log: (message) => console.log('transport:', message) });
const rows = [
  { m: 'agent', id: 1, kind: 'claude', name: 'refactor', proj: 'deck', state: 'question', title: 'Run the migrations on staging?', since: 42 },
  { m: 'agent', id: 2, kind: 'codex', name: 'tests', proj: 'deck', state: 'working', title: 'cargo test --all' },
  { m: 'agent', id: 3, kind: 'other', name: 'docs', proj: 'deck', state: 'ready', title: 'waiting for review' },
];
const card = cardMessage({
  agent: 1,
  id: 1,
  type: 'q',
  text: 'Tests fail on main. Run the pending migrations on staging first?',
  choices: ['Run on staging', 'Skip migrations', 'Abort task'],
  rec: 0,
});

const link = new DeckLink(transport, {
  sync: () => [...rows, card],
});

link.on('hello', (message) => {
  console.log(`deck: fw ${message.fw}, boot ${message.boot}, ${message.faces?.length ?? 0} faces`);
});
link.on('ready', async () => {
  console.log('deck: ready — pushed 3 agents and one card');
});
link.on('synced', (info) => console.log('deck: synced', JSON.stringify(info)));
for (const kind of ['answer', 'snooze', 'channel', 'ptt', 'key', 'face', 'set', 'macro']) {
  link.on(kind, (message) => console.log(`<- ${kind}:`, JSON.stringify(message)));
}
link.on('err', (message) => console.log('<- err:', JSON.stringify(message)));
link.on('error', (error) => console.log('link error:', error?.message ?? error));
link.on('closed', () => console.log('link closed'));

console.log(`connecting to ${transport.path}`);
await link.start();
console.log(`watching for ${seconds}s — press the deck's buttons, then Ctrl+C`);

setTimeout(async () => {
  await link.stop();
  process.exit(0);
}, seconds * 1000);
