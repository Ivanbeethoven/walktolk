import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const route = '/deck/usb';
const require = createRequire(import.meta.url);

export function remotePort(ctx, log, secret = readFileSync(join(homedir(), '.dsh', 'deck-bridge.key'), 'utf8').trim()) {
  const { WebSocketServer } = require('ws');
  if (secret.length < 32) throw new Error('missing deck pairing key');
  const expected = Buffer.from('Bearer ' + secret);
  // A BLE microphone frame carries up to 166 bytes of audio protocol data.
  const server = new WebSocketServer({ noServer: true, maxPayload: 169, perMessageDeflate: false });
  let peer, receive, state;
  let bluetooth = false;
  let stopped = false;
  const upgrade = (req, socket, head) => {
    const presented = Buffer.from(req.headers.authorization ?? '');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (stopped || peer) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    server.handleUpgrade(req, socket, head, (ws) => {
      peer = ws;
      const ble = req.headers['x-deck-transport'] === 'ble';
      bluetooth = ble;
      log(`phone ${ble ? 'BLE' : 'USB'} bridge connected`);
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        if (peer !== ws) return;
        peer = null;
        state?.(false);
        log(`phone ${ble ? 'BLE' : 'USB'} bridge disconnected`);
      });
      ws.on('message', (data, binary) => {
        if (peer !== ws || stopped) return;
        const hid = data.length === 64 && (data[1] === 5 || data[1] === 7) && data[2] <= 61;
        const mic = ble && data[1] === 7 && data[2] >= 1 && data[2] <= 166 && data.length === 3 + data[2];
        if (!binary || data[0] !== 6 || (!hid && !mic)) {
          ws.close(1002, 'invalid HID report');
          return;
        }
        receive(data);
      });
      state?.(true);
    });
  };
  return {
    // Android writes each control fragment with a GATT response from the peripheral.
    get paceMs() { return bluetooth ? 60 : 0; },
    start(onReport, onState) {
      receive = onReport;
      state = onState;
      ctx.inject(['webServer'], (scope) => scope.effect(() => {
        const unregister = scope.webServer.registerUpgrade({ path: route, handler: upgrade });
        log('phone USB route ready');
        return () => { unregister(); peer?.terminate(); };
      }, 'deck USB WebSocket'));
    },
    write(report) {
      if (peer?.readyState !== 1) return;
      if (peer.bufferedAmount > 64 * 256) { peer.terminate(); return; }
      return new Promise((resolve, reject) => peer.send(report, { binary: true }, e => e ? reject(e) : resolve()));
    },
    stop() {
      stopped = true;
      peer?.terminate();
      server.close();
    },
  };
}
