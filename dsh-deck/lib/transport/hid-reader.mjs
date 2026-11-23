/**
 * Blocking HID reader for one deck interface.
 *
 * A blocking `ReadFile` cannot be polled and cannot be interrupted from the
 * other side, so it runs here, on its own thread, and pushes reports to the
 * parent one at a time. Overlapped I/O is not an option: on the deck's HID
 * driver an overlapped read completes immediately with zero bytes, while a
 * plain blocking read delivers the report.
 *
 * The parent terminates this worker on close; the handle then dies with the
 * thread, which is why nothing is torn down explicitly.
 *
 * @module dsh-deck/transport/hid-reader
 */

import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const koffi = require(workerData.koffiPath);

const kernel32 = koffi.load('kernel32.dll');
const CreateFileW = kernel32.func(
  'void *CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *sa, uint32_t disposition, uint32_t flags, void *template)');
const ReadFile = kernel32.func(
  'bool ReadFile(void *file, uint8_t *buffer, uint32_t bytes, _Out_ uint32_t *read, void *overlapped)');
const GetLastError = kernel32.func('uint32_t GetLastError()');

const GENERIC_READ = 0x8000_0000;
const GENERIC_WRITE = 0x4000_0000;
const FILE_SHARE_READ = 0x01;
const FILE_SHARE_WRITE = 0x02;
const OPEN_EXISTING = 3;

const handle = CreateFileW(workerData.path, GENERIC_READ | GENERIC_WRITE,
  FILE_SHARE_READ | FILE_SHARE_WRITE, null, OPEN_EXISTING, 0, null);
if (!handle) {
  parentPort.postMessage({ type: 'fatal', error: `cannot open the deck (Win32 error ${kernel32.GetLastError()})` });
} else {
  const buffer = Buffer.alloc(workerData.bytes);
  parentPort.postMessage({ type: 'open' });
  for (;;) {
    const read = [0];
    const ok = ReadFile(handle, buffer, buffer.length, read, null);
    if (!ok) {
      parentPort.postMessage({ type: 'error', code: GetLastError() });
      break;
    }
    if (read[0] > 0) {
      parentPort.postMessage({ type: 'report', bytes: Array.from(buffer.subarray(0, read[0])) });
    }
  }
}
