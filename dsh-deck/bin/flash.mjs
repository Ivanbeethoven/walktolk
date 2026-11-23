/**
 * Flash the deck over its own USB-C port, through the bootloader's recovery
 * mode — the Windows port of `tools/flash-usb.py`, using the same koffi HID
 * transport as the plugin. No Python, no hidapi wheel, no probe, no test pads.
 *
 *   node bin/flash.mjs --status                  # what is attached, and in which mode
 *   node bin/flash.mjs --dry-run image.elf       # validate an image, touch nothing
 *   node bin/flash.mjs image.elf                 # ask a running deck to reboot into
 *                                                # recovery, then write and verify it
 *   node bin/flash.mjs --no-request image.bin    # the deck is already in recovery
 *
 * Only the application window at 0x12020000 is ever written. The flash table
 * and the bootloader are left alone, so a bad image is always recoverable by
 * flashing a good one.
 *
 * @module dsh-deck/bin/flash
 */

import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

import { REPORT_BYTES, listDecks, openDeck } from '../lib/transport/hid-win.mjs';

const REPORT_ID = 6;
const RPC_CHANNEL = 2;
const RECOVERY_CHANNEL = 9;
/** Bytes of payload one report carries on any channel. */
const PAYLOAD_MAX = 61;
/** Bytes of one erase/commit unit. */
const SECTOR = 4096;

const APP_BASE = 0x1202_0000;
const APP_END = 0x1300_0000;
const BONDS_START = 0x1270_0000;
const BONDS_END = 0x1272_0000;

const OP_HELLO = 1;
const OP_BEGIN = 2;
const OP_DATA = 3;
const OP_COMMIT = 4;
const OP_FINISH = 5;
const OP_BOOT = 6;
const OP_SPARSE = 8;

const STATUS = ['ok', 'bad arguments', 'crc mismatch', 'flash error', 'verify error'];

const log = (message) => process.stdout.write(`flash: ${message}\n`);
const fail = (message) => {
  process.stderr.write(`flash: ${message}\n`);
  process.exit(1);
};

// ---- image ----------------------------------------------------------------

/**
 * The flash contents an ELF describes: its PT_LOAD segments by physical
 * address, gaps filled with 0xFF, exactly what sftool would flash.
 * @param {Buffer} data
 * @returns {Buffer}
 */
function imageFromElf(data) {
  if (data.length < 52 || data.subarray(0, 7).toString('latin1') !== '\x7fELF\x01\x01\x01') {
    fail('not a 32-bit little-endian ELF');
  }
  const phoff = data.readUInt32LE(0x1c);
  const phentsize = data.readUInt16LE(0x2a);
  const phnum = data.readUInt16LE(0x2c);
  if (phentsize < 32 || phoff + phentsize * phnum > data.length) fail('invalid ELF program headers');

  const segments = [];
  let executable = false;
  for (let i = 0; i < phnum; i += 1) {
    const at = phoff + i * phentsize;
    const type = data.readUInt32LE(at);
    const offset = data.readUInt32LE(at + 4);
    const vaddr = data.readUInt32LE(at + 8);
    const paddr = data.readUInt32LE(at + 12);
    const filesz = data.readUInt32LE(at + 16);
    const flags = data.readUInt32LE(at + 24);
    if (type !== 1 || filesz === 0) continue;
    if (offset + filesz > data.length) fail('truncated ELF segment');
    if (paddr < APP_BASE || paddr + filesz > APP_END) {
      if (paddr >= 0x2000_0000 && paddr < 0x7000_0000) continue; // RAM/PSRAM only
      fail(`segment at 0x${paddr.toString(16)} (${filesz} bytes) is outside the application window`);
    }
    if (paddr < BONDS_END && paddr + filesz > BONDS_START) fail('ELF segment overlaps protected Bluetooth storage');
    segments.push([paddr, data.subarray(offset, offset + filesz)]);
    executable = executable || ((flags & 1) === 1 && (vaddr === paddr || (vaddr >= 0x6000_0000 && vaddr < 0x6080_0000)));
  }
  if (segments.length === 0) fail('no flash segments in the ELF');
  if (!executable) fail('no executable flash or PSRAM application segment');
  segments.sort((a, b) => a[0] - b[0]);
  if (segments[0][0] !== APP_BASE) {
    fail(`the image starts at 0x${segments[0][0].toString(16)}, expected the vector table at 0x${APP_BASE.toString(16)}`);
  }
  const end = Math.max(...segments.map(([addr, body]) => addr + body.length));
  const image = Buffer.alloc(end - APP_BASE, 0xff);
  let previous = APP_BASE;
  for (const [addr, body] of segments) {
    if (addr < previous) fail('overlapping flash segments');
    body.copy(image, addr - APP_BASE);
    previous = addr + body.length;
  }
  return image;
}

/** The board an image names in its boot banner, or null. */
function imageBoard(image) {
  const boards = ['Rev A', 'Rev B'].filter((name) => image.includes(Buffer.from(`OpenWalkieTalkie ${name} (`)));
  return boards.length === 1 ? boards[0] : null;
}

/**
 * Load and validate an image without touching the deck.
 * @param {string} path ELF or raw `.bin` for 0x12020000.
 * @returns {{ image: Buffer, board: string, elf: boolean }}
 */
function loadImage(path) {
  const data = readFileSync(path);
  const elf = data.subarray(0, 4).toString('latin1') === '\x7fELF';
  const image = elf ? imageFromElf(data) : data;
  if (image.length < 8) fail('image is too short for an application vector table');
  const sp = image.readUInt32LE(0);
  const pc = image.readUInt32LE(4);
  if (sp < 0x2000_0000 || sp > 0x2008_0000) fail(`the image's vector table has SP 0x${sp.toString(16)}, outside SRAM`);
  if ((pc & 1) === 0) fail('the reset vector is not a Thumb address');
  const reset = pc & ~1;
  if (reset < APP_BASE || reset >= APP_BASE + image.length) fail('the reset vector points outside the image');
  if (reset >= BONDS_START && reset < BONDS_END) fail('the reset vector points into protected Bluetooth storage');
  if (image.length > APP_END - APP_BASE) fail('image larger than the application window');
  const bonds = image.subarray(BONDS_START - APP_BASE, BONDS_END - APP_BASE);
  if (bonds.length > 0 && bonds.some((byte) => byte !== 0xff)) fail('image is not 0xFF over the protected Bluetooth stores');
  const board = imageBoard(image);
  if (!board) fail('image must name exactly one board: Rev A or Rev B (not the LilyGo dev-board build)');
  return { image, board, elf };
}

// ---- recovery link --------------------------------------------------------

/** One open vendor HID collection, in either application or recovery mode. */
class Link {
  constructor(transport) {
    this.transport = transport;
    /** Bytes still to be delivered on each channel, and a waiter list. */
    this.inbox = new Map();
    this.waiters = [];
    this.closed = false;
  }

  static async open() {
    const deck = listDecks()[0];
    if (!deck) fail('no OpenWalkieTalkie on USB (VID 1209 / PID 5754); check the cable');
    const transport = await openDeck({ path: deck.path });
    const link = new Link(transport);
    await transport.start((report) => link.onReport(report));
    return link;
  }

  onReport(report) {
    if (!report) {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter.undefined;
      return;
    }
    if (report[0] !== REPORT_ID) return;
    const channel = report[1];
    const len = report[2];
    if (len > report.length - 3) return;
    const chunk = Buffer.from(report.subarray(3, 3 + len));
    const buffered = this.inbox.get(channel) ?? Buffer.alloc(0);
    this.inbox.set(channel, Buffer.concat([buffered, chunk]));
    this.wake();
  }

  wake() {
    for (const waiter of this.waiters.slice()) waiter();
  }

  async send(channel, payload) {
    if (payload.length > PAYLOAD_MAX) throw new RangeError('payload too long');
    const report = Buffer.alloc(REPORT_BYTES);
    report[0] = REPORT_ID;
    report[1] = channel;
    report[2] = payload.length;
    Buffer.from(payload).copy(report, 3);
    await this.transport.write(report);
  }

  /** The next payload on `channel`, or null after `timeoutMs`. */
  async recv(channel, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const buffered = this.inbox.get(channel);
      if (buffered && buffered.length > 0) {
        this.inbox.set(channel, Buffer.alloc(0));
        return buffered;
      }
      if (this.closed) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** One JSON-RPC request on channel 2. */
  async rpc(method, params = {}, timeoutMs = 3000) {
    const request = Buffer.from(JSON.stringify({ method, params, id: 1 }) + '\n', 'utf8');
    for (let at = 0; at < request.length; at += PAYLOAD_MAX) {
      await this.send(RPC_CHANNEL, request.subarray(at, at + PAYLOAD_MAX));
    }
    const reply = await this.recv(RPC_CHANNEL, timeoutMs);
    if (!reply) return null;
    try {
      return JSON.parse(reply.toString('utf8').split('\n')[0]);
    } catch {
      return { raw: reply.toString('utf8') };
    }
  }

  /** `{ protocol, imageValid, capabilities }` from a deck in recovery, else null. */
  async hello(timeoutMs = 1000) {
    await this.send(RECOVERY_CHANNEL, Buffer.from([OP_HELLO]));
    const reply = await this.recv(RECOVERY_CHANNEL, timeoutMs);
    if (!reply || reply.length < 7 || reply[0] !== OP_HELLO) return null;
    if (reply.subarray(1, 5).toString('latin1') !== 'OWTB') return null;
    return {
      protocol: reply[5],
      imageValid: reply[6] === 1,
      capabilities: reply.length >= 8 ? reply[7] : 0,
    };
  }

  /** Send a recovery command and wait for its own op code back. */
  async command(op, payload = Buffer.alloc(0), timeoutMs = 5000) {
    await this.send(RECOVERY_CHANNEL, Buffer.concat([Buffer.from([op]), payload]));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail(`no reply to recovery command ${op}`);
      const reply = await this.recv(RECOVERY_CHANNEL, remaining);
      if (!reply) fail(`no reply to recovery command ${op}`);
      if (reply[0] === op) return reply.subarray(1);
    }
  }

  async close() {
    this.closed = true;
    this.wake();
    await this.transport.stop();
  }
}

// ---- flashing -------------------------------------------------------------

/**
 * Write the application window and verify every sector.
 * @param {Link} link a link already in recovery.
 * @param {Buffer} image
 * @param {{ onProgress?: (done: number, total: number) => void }} [options]
 */
async function download(link, image, hello, options = {}) {
  const capabilities = hello?.capabilities ?? 0;
  const begin = Buffer.alloc(4);
  begin.writeUInt32LE(image.length);
  const status = await link.command(OP_BEGIN, begin);
  if (status[0] !== 0) fail(`begin failed: ${STATUS[status[0]] ?? status[0]}`);
  log(`${image.length} bytes, ${Math.ceil(image.length / SECTOR)} sectors`);

  const started = Date.now();
  for (let offset = 0; offset < image.length; offset += SECTOR) {
    const addr = APP_BASE + offset;
    if (addr >= BONDS_START && addr < BONDS_END) continue;
    const chunk = image.subarray(offset, offset + SECTOR);
    const sparse = (capabilities & 1) !== 0 && chunk.every((byte) => byte === 0xff);
    if (!sparse) {
      for (let at = 0; at < chunk.length; at += PAYLOAD_MAX - 4) {
        const piece = chunk.subarray(at, at + PAYLOAD_MAX - 4);
        const header = Buffer.from([OP_DATA, at & 0xff, at >> 8, piece.length]);
        await link.send(RECOVERY_CHANNEL, Buffer.concat([header, piece]));
      }
    }
    const commit = Buffer.alloc(10);
    commit.writeUInt32LE(addr, 0);
    commit.writeUInt32LE(chunk.length, 4);
    commit.writeUInt32LE(crc32(chunk) >>> 0, 8);
    const reply = await link.command(sparse ? OP_SPARSE : OP_COMMIT, commit, 10000);
    if (reply[0] !== 0) fail(`sector 0x${addr.toString(16)}: ${STATUS[reply[0]] ?? reply[0]}`);
    if (reply.length >= 5 && reply.readUInt32LE(1) !== addr) fail(`sector 0x${addr.toString(16)}: acknowledged another address`);
    if (options.onProgress) options.onProgress(Math.min(offset + SECTOR, image.length), image.length);
  }

  const finish = await link.command(OP_FINISH, Buffer.alloc(0), 10000);
  if (finish[0] !== 0) fail(`finish: ${STATUS[finish[0]] ?? finish[0]}`);
  if (finish.length >= 2 && finish[1] !== 1) fail('finish: the bootloader says the image is not valid');
  const seconds = (Date.now() - started) / 1000;
  log(`done in ${seconds.toFixed(1)} s (${Math.round(image.length / 1024 / Math.max(seconds, 0.001))} KB/s); vectors checked, rebooting`);
}

/** Ask a running deck to reboot into its recovery mode. */
async function requestRecovery(link) {
  const reply = await link.rpc('sys.reboot', { mode: 'recovery' });
  log(`sys.reboot: ${JSON.stringify(reply)}`);
}

/** Wait for the deck to come back as a recovery-mode device. */
async function waitForRecovery(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const deck = listDecks()[0];
    if (!deck) continue;
    let link = null;
    try {
      link = await Link.open();
      const hello = await link.hello(800);
      if (hello) return { link, hello };
      await link.close();
    } catch {
      if (link) await link.close().catch(() => {});
    }
  }
  return null;
}

// ---- cli ------------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const positional = argv.filter((arg) => !arg.startsWith('--'));

if (flags.has('--help') || (!flags.has('--status') && positional.length === 0)) {
  process.stdout.write(`usage: node bin/flash.mjs <image.elf|.bin> [--dry-run] [--no-request]
       node bin/flash.mjs --status

  --status       report what is attached and whether it is in recovery
  --dry-run      validate the image and stop; touches nothing
  --no-request   the deck is already in recovery (buttons, or a broken image)
`);
  process.exit(0);
}

if (flags.has('--status')) {
  const decks = listDecks();
  if (decks.length === 0) {
    log('not attached (no 1209:5754 interface on USB)');
    process.exit(0);
  }
  const link = await Link.open();
  const recovery = await link.hello(1200);
  if (recovery) {
    log(`attached in recovery: protocol ${recovery.protocol}, image valid: ${recovery.imageValid}, capabilities 0x${recovery.capabilities.toString(16)}`);
  } else {
    const version = await link.rpc('sys.version');
    log(`attached, running: ${JSON.stringify(version?.result ?? version)}`);
  }
  await link.close();
  process.exit(0);
}

const { image, board, elf } = loadImage(positional[0]);
log(`${positional[0]}: ${elf ? 'ELF' : 'raw image'}, board ${board}, ${image.length} bytes`);

if (flags.has('--dry-run')) {
  log('dry run: the image validates; nothing was written');
  process.exit(0);
}

let link = await Link.open();
let hello = await link.hello(1200);

if (!hello && !flags.has('--no-request')) {
  log('the deck is running its application; asking it to reboot into recovery');
  const version = await link.rpc('sys.version');
  log(`running: ${JSON.stringify(version?.result ?? version)}`);
  await requestRecovery(link);
  await link.close();
  const recovered = await waitForRecovery();
  if (!recovered) fail('the deck did not come back in recovery mode; hold SHIFT and CANCEL while powering on, then retry with --no-request');
  ({ link, hello } = recovered);
  log(`recovery: protocol ${hello.protocol}, image valid: ${hello.imageValid}`);
} else if (!hello) {
  fail('the deck is not in recovery mode');
}

if (hello.protocol !== 2) {
  log(`warning: recovery protocol ${hello.protocol}, expected 2; the bootloader may be too old for this image`);
}

let lastPercent = -1;
await download(link, image, hello, {
  onProgress: (done, total) => {
    const percent = (done * 100) / total;
    if (percent - lastPercent >= 5) {
      lastPercent = percent;
      log(`${String(Math.floor(percent)).padStart(3)}% (${done}/${total} bytes)`);
    }
  },
});

// Wait for the application to come back and name itself.
const deadline = Date.now() + 20000;
let reported = null;
while (Date.now() < deadline && !reported) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!listDecks()[0]) continue;
  let probe = null;
  try {
    probe = await Link.open();
    const sys = await probe.rpc('sys.version', {}, 1500);
    const result = sys?.result;
    if (result?.version) reported = result;
  } catch {
    // still booting
  } finally {
    if (probe) await probe.close().catch(() => {});
  }
}
if (reported) log(`application is back: ${reported.version} · ${reported.board}`);
else log('flash written and verified; the application has not answered yet');

await link.close().catch(() => {});
process.exit(0);
