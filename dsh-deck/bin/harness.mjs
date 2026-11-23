/**
 * Run the plugin's own `apply()` against the real deck, outside DSH.
 *
 * The point is to test our code path end to end without a restart cycle: a fake
 * ctx supplies the services `apply` expects, the deck is the real one, and every
 * message in both directions is printed. Press a key on the deck when a card
 * appears; the harness prints the answer the waterfall would have returned.
 *
 *   node bin/harness.mjs            # roster + one card, 60 s
 *   node bin/harness.mjs --ask      # send the question after 4 s
 *
 * Stop DSH first: two hosts on one deck fight over the session.
 *
 * @module dsh-deck/bin/harness
 */

import { apply } from '../lib/index.mjs';

const argv = new Set(process.argv.slice(2));

/** A minimal Cordis-shaped context: `on`, `tools`, `agents`, `logger`. */
function fakeContext() {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map();
  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {};
    },
    logger: { info: (message) => process.stdout.write(`${message}\n`) },
    tools: { register: (tool) => process.stdout.write(`tool registered: ${tool.name}\n`) },
    agents: {
      list: () => [
        { id: 'a1', name: 'claude-a', status: 'working', cwd: 'C:\\work\\deck' },
        { id: 'a2', name: 'codex-b', status: 'waiting', cwd: 'C:\\work\\api' },
      ],
    },
    get: (key) => ctx[key],
    // Cordis: run the callback once the named services are available.
    inject(services, callback) {
      const scope = {};
      for (const service of services) scope[service] = ctx[service];
      callback(scope);
    },
  };
  return { ctx, listeners };
}

const { ctx, listeners } = fakeContext();
apply(ctx, { transport: 'hid', agentLimit: 7, log: true });

/** Drive the waterfall exactly as the harness would. */
async function askTheDeck() {
  const handlers = listeners.get('user-questions/request') ?? [];
  if (handlers.length === 0) {
    process.stdout.write('harness: no user-questions listener registered 鈥?apply() did not reach that line\n');
    return;
  }
  process.stdout.write(`harness: driving ${handlers.length} listener(s)\n`);
  const request = {
    agent: { id: 'a1' },
    questions: [{
      id: 'q1',
      question: 'Harness test: pick a lane',
      header: 'Deck',
      options: [{ label: 'Lane one' }, { label: 'Lane two' }],
    }],
  };
  let delegated = false;
  const next = async () => {
    delegated = true;
    return 'DELEGATED';
  };
  const result = await handlers[0](request, next);
  if (delegated) process.stdout.write(`harness: listener handed the request on (${result})\n`);
  else process.stdout.write(`harness: listener answered ${JSON.stringify(result)}\n`);
}

setTimeout(askTheDeck, argv.has('--ask') ? 4000 : 6000);
setTimeout(() => {
  process.stdout.write('harness: done\n');
  process.exit(0);
}, 45_000);

