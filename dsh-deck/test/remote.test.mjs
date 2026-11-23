import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';

import { DeckLink, SETTLE_MS, SYNCED_AGAIN_MS } from '../lib/link.mjs';
import { frame } from '../lib/protocol.mjs';
import { remotePort } from '../lib/transport/remote.mjs';
import { FakeDeck } from '../lib/transport/sim.mjs';

const TEST_KEY = 'test-pairing-key-for-unit-tests-only-0123456789';
const ROUTE = '/deck/usb';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture() {
  const httpServer = createServer();
  let unregister = () => {};
  const webServer = {
    registerUpgrade({ path, handler }) {
      const route = (request, socket, head) => {
        let pathname;
        try {
          pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        } catch {
          socket.destroy();
          return;
        }
        if (pathname === path) handler(request, socket, head);
      };
      httpServer.on('upgrade', route);
      return () => httpServer.off('upgrade', route);
    },
  };
  const ctx = {
    inject(_services, register) {
      register({
        webServer,
        effect(effect) {
          unregister = effect() ?? (() => {});
          return unregister;
        },
      });
    },
  };
  const logs = [];
  const port = remotePort(ctx, (message) => logs.push(String(message)), TEST_KEY);
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  const clients = [];
  let stopped = false;
  return {
    httpServer,
    logs,
    port,
    clients,
    url: `ws://127.0.0.1:${address.port}${ROUTE}`,
    openClient(key = TEST_KEY, extraHeaders = {}) {
      const client = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${key}`, ...extraHeaders },
      });
      client.on('error', () => {});
      clients.push(client);
      return client;
    },
    async close({ stopPort = true } = {}) {
      if (stopped) return;
      stopped = true;
      if (stopPort) port.stop();
      unregister();
      for (const client of clients) {
        if (client.readyState === WebSocket.CONNECTING || client.readyState === WebSocket.OPEN) {
          client.terminate();
        }
      }
      if (httpServer.listening) {
        await new Promise((resolve) => httpServer.close(() => resolve()));
      }
    },
  };
}

function waitForOpen(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('WebSocket open timed out')), timeoutMs);
    const onOpen = () => finish(null, socket);
    const onError = (error) => finish(error);
    function finish(error, value) {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve(value);
    }
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}

function waitForEvent(target, event, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`${event} event timed out`)), timeoutMs);
    const handler = (...args) => finish(null, args);
    function finish(error, value) {
      clearTimeout(timer);
      target.off(event, handler);
      if (error) reject(error);
      else resolve(value);
    }
    target.once(event, handler);
  });
}

async function waitUntil(predicate, label, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function rejectedStatus(url, key) {
  const client = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
  client.on('error', () => {});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.terminate();
      reject(new Error('WebSocket rejection timed out'));
    }, 2500);
    client.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      const status = response.statusCode;
      response.resume();
      resolve(status);
    });
    client.once('open', () => {
      clearTimeout(timer);
      client.terminate();
      resolve(101);
    });
  });
}

function report(channel, payload) {
  assert.ok(payload.length <= 61);
  const bytes = Buffer.alloc(64);
  bytes[0] = 6;
  bytes[1] = channel;
  bytes[2] = payload.length;
  Buffer.from(payload).copy(bytes, 3);
  return bytes;
}

function bleReport(channel, payload) {
  const bytes = Buffer.alloc(3 + payload.length);
  bytes[0] = 6;
  bytes[1] = channel;
  bytes[2] = payload.length;
  Buffer.from(payload).copy(bytes, 3);
  return bytes;
}

async function openFakeDeckBridge(fixtureValue, deck) {
  let currentSocket = null;
  const bridgeErrors = [];
  await deck.start((bytes) => {
    if (currentSocket?.readyState === WebSocket.OPEN) currentSocket.send(bytes, { binary: true });
  });
  const open = async () => {
    const socket = fixtureValue.openClient();
    currentSocket = socket;
    socket.on('message', (data, binary) => {
      if (!binary) {
        bridgeErrors.push(new Error('host sent a text WebSocket frame'));
        return;
      }
      deck.write(new Uint8Array(data)).catch((error) => bridgeErrors.push(error));
    });
    socket.on('close', () => {
      if (currentSocket === socket) currentSocket = null;
    });
    await waitForOpen(socket);
    return socket;
  };
  return { open, bridgeErrors };
}

test('remotePort rejects a wrong pairing key without claiming a peer', async () => {
  const server = await fixture();
  const states = [];
  try {
    server.port.start(() => {}, (connected) => states.push(connected));
    const status = await rejectedStatus(server.url, 'wrong-test-pairing-key-0123456789abcdef');
    assert.equal(status, 403);
    assert.deepEqual(states, []);
    assert.ok(server.logs.some((line) => line === 'phone USB route ready'));
  } finally {
    await server.close();
  }
});

test('remotePort admits one authenticated peer at a time', async () => {
  const server = await fixture();
  const states = [];
  try {
    server.port.start(() => {}, (connected) => states.push(connected));
    const first = server.openClient();
    await waitForOpen(first);
    await waitUntil(() => states.length === 1, 'first peer connection');

    const status = await rejectedStatus(server.url, TEST_KEY);
    assert.equal(status, 409);
    assert.deepEqual(states, [true]);
    assert.equal(first.readyState, WebSocket.OPEN);

    const disconnected = waitForEvent(first, 'close');
    first.close();
    await disconnected;
    await waitUntil(() => states.length === 2, 'first peer disconnect');
    assert.deepEqual(states, [true, false]);
  } finally {
    await server.close();
  }
});

test('remotePort carries channel 5 and channel 7 reports in both directions', async () => {
  const server = await fixture();
  const received = [];
  try {
    server.port.start((bytes) => received.push(Buffer.from(bytes)), () => {});
    const client = server.openClient();
    const outbound = [];
    client.on('message', (data, binary) => outbound.push({ bytes: Buffer.from(data), binary }));
    await waitForOpen(client);

    const incomingFive = frame('{"m":"phone"}')[0];
    const incomingSeven = report(7, [0x11, 0x22, 0x33, 0x44]);
    client.send(incomingFive, { binary: true });
    client.send(incomingSeven, { binary: true });
    await waitUntil(() => received.length === 2, 'both inbound reports');
    assert.deepEqual(received, [incomingFive, incomingSeven]);

    const outgoingFive = frame('{"m":"host"}')[0];
    const outgoingSeven = report(7, [0xa1, 0xb2, 0xc3]);
    await server.port.write(outgoingFive);
    await server.port.write(outgoingSeven);
    await waitUntil(() => outbound.length === 2, 'both outbound reports');
    assert.ok(outbound.every((item) => item.binary));
    assert.deepEqual(outbound.map((item) => item.bytes), [outgoingFive, outgoingSeven]);
  } finally {
    await server.close();
  }
});

test('remotePort accepts opted-in BLE voice frames up to 166 bytes and keeps channel 5 reports', async () => {
  const server = await fixture();
  const received = [];
  const outbound = [];
  try {
    server.port.start((bytes) => received.push(Buffer.from(bytes)), () => {});
    const client = server.openClient(TEST_KEY, { 'x-deck-transport': 'ble' });
    client.on('message', (data, binary) => outbound.push({ bytes: Buffer.from(data), binary }));
    await waitForOpen(client);

    const incomingFive = frame('{"m":"phone"}')[0];
    const incomingVoice = bleReport(7, Uint8Array.from({ length: 166 }, (_, index) => index & 0xff));
    client.send(incomingFive, { binary: true });
    client.send(incomingVoice, { binary: true });
    await waitUntil(() => received.length === 2, 'BLE control and maximum voice reports');
    assert.deepEqual(received, [incomingFive, incomingVoice]);

    const outgoingFive = frame('{"m":"host"}')[0];
    await server.port.write(outgoingFive);
    await waitUntil(() => outbound.length === 1, 'BLE peer receives a control report');
    assert.equal(outbound[0].binary, true);
    assert.deepEqual(outbound[0].bytes, outgoingFive);
  } finally {
    await server.close();
  }
});

test('remotePort rejects BLE frames with a bad length, wrong channel or payload over 166 bytes', async () => {
  const malformed = [
    {
      name: 'BLE declared length shorter than the exact payload',
      data: bleReport(7, Buffer.alloc(166)),
      mutate: (bytes) => { bytes[2] = 165; },
    },
    {
      name: 'BLE trailing byte beyond the declared payload',
      data: bleReport(7, Buffer.alloc(166)).subarray(0, 168),
    },
    { name: 'BLE wrong channel', data: bleReport(4, Buffer.from([0x01])) },
    { name: 'BLE payload over 166 bytes', data: bleReport(7, Buffer.alloc(167)) },
  ];
  const server = await fixture();
  const received = [];
  const states = [];
  try {
    server.port.start((bytes) => received.push(Buffer.from(bytes)), (connected) => states.push(connected));
    for (const invalid of malformed) {
      const client = server.openClient(TEST_KEY, { 'x-deck-transport': 'ble' });
      await waitForOpen(client);
      await waitUntil(() => states.at(-1) === true, `${invalid.name} peer connection`);
      const bytes = Buffer.from(invalid.data);
      invalid.mutate?.(bytes);
      const closed = waitForEvent(client, 'close');
      client.send(bytes, { binary: true });
      const [code] = await closed;
      assert.ok(code === 1002 || code === 1009, `${invalid.name} closes with a protocol or size error`);
      await waitUntil(() => states.at(-1) === false, `${invalid.name} peer release`);
    }
    assert.deepEqual(received, []);
  } finally {
    await server.close();
  }
});

test('remotePort rejects an unpadded BLE voice frame from a standard USB peer', async () => {
  const server = await fixture();
  const received = [];
  const states = [];
  try {
    server.port.start((bytes) => received.push(Buffer.from(bytes)), (connected) => states.push(connected));
    const client = server.openClient();
    await waitForOpen(client);
    await waitUntil(() => states.at(-1) === true, 'USB peer connection');

    const closed = waitForEvent(client, 'close');
    client.send(bleReport(7, Buffer.alloc(166)), { binary: true });
    const [code] = await closed;
    assert.ok(code === 1002 || code === 1009, 'USB peer closes with a protocol or size error');
    await waitUntil(() => states.at(-1) === false, 'USB peer release');
    assert.deepEqual(received, []);
  } finally {
    await server.close();
  }
});

test('remotePort clears the peer on disconnect and accepts a reconnect', async () => {
  const server = await fixture();
  const states = [];
  try {
    server.port.start(() => {}, (connected) => states.push(connected));
    const first = server.openClient();
    await waitForOpen(first);
    await waitUntil(() => states.length === 1, 'initial connection');

    const disconnected = waitForEvent(first, 'close');
    first.close();
    await disconnected;
    await waitUntil(() => states.length === 2, 'initial disconnect');

    const second = server.openClient();
    await waitForOpen(second);
    await waitUntil(() => states.length === 3, 'reconnection');
    assert.deepEqual(states, [true, false, true]);
    assert.equal(second.readyState, WebSocket.OPEN);
  } finally {
    await server.close();
  }
});

test('remotePort changes its report pace when reconnecting between USB and BLE', async () => {
  const server = await fixture();
  const states = [];
  try {
    server.port.start(() => {}, (connected) => states.push(connected));

    const usb = server.openClient();
    await waitForOpen(usb);
    await waitUntil(() => states.at(-1) === true, 'USB peer connection');
    assert.equal(server.port.paceMs, 0);
    const usbClosed = waitForEvent(usb, 'close');
    usb.close();
    await usbClosed;
    await waitUntil(() => states.at(-1) === false, 'USB peer disconnect');

    const ble = server.openClient(TEST_KEY, { 'x-deck-transport': 'ble' });
    await waitForOpen(ble);
    await waitUntil(() => states.at(-1) === true, 'BLE peer connection');
    assert.equal(server.port.paceMs, 60);
    const bleClosed = waitForEvent(ble, 'close');
    ble.close();
    await bleClosed;
    await waitUntil(() => states.at(-1) === false, 'BLE peer disconnect');

    const reconnectedUsb = server.openClient();
    await waitForOpen(reconnectedUsb);
    await waitUntil(() => states.at(-1) === true, 'USB peer reconnect');
    assert.equal(server.port.paceMs, 0, 'the new USB peer replaces BLE pacing');
  } finally {
    await server.close();
  }
});

test('remotePort closes malformed HID WebSocket messages without forwarding them', async () => {
  const malformed = [
    { name: 'short report', data: Buffer.from([6, 5, 1, 0]), binary: true },
    { name: 'wrong report id', data: report(5, [0x01]), binary: true, mutate: (bytes) => { bytes[0] = 7; } },
    { name: 'wrong channel', data: report(4, [0x01]), binary: true },
    { name: 'oversized payload length', data: report(5, []), binary: true, mutate: (bytes) => { bytes[2] = 62; } },
    { name: 'text frame', data: 'not a HID report', binary: false },
  ];
  const server = await fixture();
  const received = [];
  const states = [];
  try {
    server.port.start((bytes) => received.push(Buffer.from(bytes)), (connected) => states.push(connected));
    for (const invalid of malformed) {
      const client = server.openClient();
      await waitForOpen(client);
      await waitUntil(() => states.at(-1) === true, `${invalid.name} peer connection`);
      const bytes = Buffer.isBuffer(invalid.data) ? Buffer.from(invalid.data) : invalid.data;
      invalid.mutate?.(bytes);
      const closed = waitForEvent(client, 'close');
      client.send(bytes, { binary: invalid.binary });
      const [code] = await closed;
      assert.equal(code, 1002, `${invalid.name} closes with a protocol error`);
      await waitUntil(() => states.at(-1) === false, `${invalid.name} peer release`);
    }
    assert.deepEqual(received, []);
  } finally {
    await server.close();
  }
});

test('DeckLink drops stale sync work on disconnect and becomes ready after reconnect', async () => {
  const server = await fixture();
  let releaseFirstSync;
  let firstSyncStarted;
  const firstSyncPromise = new Promise((resolve) => { releaseFirstSync = resolve; });
  const firstSyncStartedPromise = new Promise((resolve) => { firstSyncStarted = resolve; });
  let syncCalls = 0;
  const link = new DeckLink(server.port, {
    sync() {
      syncCalls++;
      if (syncCalls === 1) {
        firstSyncStarted();
        return firstSyncPromise;
      }
      return [];
    },
  });
  const deck = new FakeDeck();
  const lostCount = { value: 0 };
  link.on('lost', () => { lostCount.value++; });
  let started = false;
  try {
    await link.start();
    started = true;
    const bridge = await openFakeDeckBridge(server, deck);
    const firstSocket = await bridge.open();
    await Promise.race([
      firstSyncStartedPromise,
      delay(2500).then(() => { throw new Error('first sync did not start'); }),
    ]);
    assert.equal(link.ready, false, 'link remains unready while the first sync is pending');

    const closed = waitForEvent(firstSocket, 'close');
    firstSocket.close();
    await closed;
    await waitUntil(() => lostCount.value >= 2, 'link generation reset on disconnect');
    assert.equal(link.ready, false, 'disconnect clears readiness');

    releaseFirstSync([]);
    await delay(SETTLE_MS + 50);
    assert.equal(link.ready, false, 'stale sync completion cannot restore readiness');
    assert.equal(deck.received.some((message) => message.m === 'synced'), false,
      'stale generation sends no synced message');

    const ready = waitForEvent(link, 'ready', SETTLE_MS + SYNCED_AGAIN_MS + 2000);
    const secondSocket = await bridge.open();
    await ready;
    assert.equal(syncCalls, 2, 'new connection starts a fresh sync');
    assert.equal(link.ready, true, 'new generation reaches ready');
    assert.deepEqual(bridge.bridgeErrors, []);

    const finalClose = waitForEvent(secondSocket, 'close');
    secondSocket.close();
    await finalClose;
    await waitUntil(() => lostCount.value >= 4, 'ready link disconnect');
    assert.equal(link.ready, false, 'a ready link releases readiness when its peer disconnects');
  } finally {
    if (started) await link.stop();
    await server.close({ stopPort: false });
  }
});



