/**
 * Reboot the deck over its own USB link.
 *
 *   node bin/reboot.mjs              # normal restart
 *   node bin/reboot.mjs --recovery   # into the bootloader's USB recovery mode
 *
 * The firmware answers `sys.reboot` on channel 2, then reboots once the reply has
 * gone out. Nothing is written; the flash, the settings and the pairings stay.
 *
 * The deck also has a soft power-off with no protocol equivalent: hold CANCEL for
 * three seconds, and hold PTT for two seconds to wake it again.
 *
 * @module dsh-deck/bin/reboot
 */

import { REPORT_BYTES, listDecks, openDeck } from '../lib/transport/hid-win.mjs';

const REPORT_ID = 6;
const RPC_CHANNEL = 2;
const PAYLOAD_MAX = 61;

const argv = process.argv.slice(2);
const recovery = argv.includes('--recovery');

if (listDecks().length === 0) {
  process.stderr.write('reboot: no deck on USB (VID 1209 / PID 5754)\n');
  process.exit(1);
}

const transport = await openDeck({ log: (message) => process.stderr.write(`transport: ${message}\n`) });
let reply = null;

await transport.start((report) => {
  if (!report || report[0] !== REPORT_ID || report[1] !== RPC_CHANNEL) return;
  const len = report[2];
  if (len > 0) reply = Buffer.from(report.subarray(3, 3 + len)).toString('utf8');
});

/** One channel-2 request, as a report per chunk. */
async function rpc(method, params) {
  const request = Buffer.from(`${JSON.stringify({ id: 1, method, params })}\n`, 'utf8');
  for (let at = 0; at < request.length; at += PAYLOAD_MAX) {
    const piece = request.subarray(at, at + PAYLOAD_MAX);
    const report = Buffer.alloc(REPORT_BYTES);
    report[0] = REPORT_ID;
    report[1] = RPC_CHANNEL;
    report[2] = piece.length;
    piece.copy(report, 3);
    await transport.write(report);
  }
  for (let waited = 0; waited < 2000 && !reply; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return reply;
}

const version = await rpc('sys.version', {});
process.stdout.write(`deck: ${version?.trim() ?? '(no answer to sys.version)'}\n`);

reply = null;
const answer = await rpc('sys.reboot', recovery ? { mode: 'recovery' } : {});
process.stdout.write(`sys.reboot: ${answer?.trim() ?? '(no answer)'}\n`);

await transport.stop();
process.stdout.write(
  recovery
    ? 'deck is going into recovery; `node bin/flash.mjs --no-request <image>` can write it now\n'
    : 'deck is rebooting; the link will re-enumerate in a few seconds\n',
);
process.exit(0);
