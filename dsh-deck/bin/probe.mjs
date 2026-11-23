/**
 * Probe the deck from a terminal: list what Windows sees, and optionally run a
 * link against it and print every line in both directions.
 *
 *   node bin/probe.mjs            # enumerate HID interfaces
 *   node bin/probe.mjs --lines    # connect, say hello, print 5 s of traffic
 *   node bin/probe.mjs --sim      # same over the in-memory fake deck
 */

import { DeckLink } from '../lib/link.mjs';
import { FakeDeck } from '../lib/transport/sim.mjs';
import { listDecks, listDevices, openDeck } from '../lib/transport/hid-win.mjs';

const argv = new Set(process.argv.slice(2));
const wantsLines = argv.has('--lines') || argv.has('--sim');
const useSim = argv.has('--sim');

if (!wantsLines) {
  const devices = listDevices();
  if (devices.length === 0) {
    console.log('no HID interfaces visible; check the cable, or the sandbox you are running under');
  }
  for (const device of devices) {
    const tag = device.vendorId === 0x1209 && device.productId === 0x5754 ? ' <- deck' : '';
    console.log(`${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}  ${device.path}${tag}`);
  }
  const decks = listDecks();
  console.log(`\n${decks.length} deck${decks.length === 1 ? '' : 's'} found`);
  process.exit(0);
}

const deck = useSim ? new FakeDeck() : null;
const transport = useSim
  ? { start: (fn) => deck.start(fn), write: (r) => deck.write(r), stop: () => deck.stop() }
  : await openDeck({ log: console.log });

const link = new DeckLink(transport, {
  sync: () => {
    console.log('sync: (nothing to push in a probe)');
    return [];
  },
});
link.on('message', (message) => console.log('<-', JSON.stringify(message)));
link.on('sent', (message) => console.log('->', JSON.stringify(message)));

console.log(useSim ? 'connecting to the fake deck…' : `connected to ${transport.path}`);
await link.start();

if (useSim) {
  desk(deck);
}

setTimeout(async () => {
  await link.stop();
  process.exit(0);
}, 5000);

/** Drive the fake deck through a session a human can recognise. */
function desk(deck) {
  setTimeout(() => {
    deck.emit({ m: 'channel', agent: 1, seq: 1 });
    deck.emit({ m: 'ptt', act: 1, agent: 1, ctx: 'talk' });
    deck.pressPtt(1);
    deck.switchFace(2);
  }, 1500);
}
