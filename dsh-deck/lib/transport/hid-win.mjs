/**
 * Windows HID transport: the deck's vendor collection over USB.
 *
 * Talks to the Win32 HID API (`hid.dll` + `setupapi.dll`) through koffi, which
 * ships with DeepSeek Harness. No native build, no npm install: the only native
 * code is Windows itself.
 *
 * The deck is `VID 0x1209 / PID 0x5754`, one vendor collection (usage page
 * 0xFF00, 64-byte reports) with report id 6. It is deliberately not a keyboard,
 * so opening it needs no Input Monitoring grant and no administrator rights.
 *
 * Two threads, because this driver insists on it:
 *   - writes are synchronous on this thread (an overlapped write completes with
 *     zero bytes, a plain one writes all 64);
 *   - reads block, so they live in a worker (`hid-reader.mjs`) and arrive here
 *     as messages.
 *
 * @module dsh-deck/transport/hid-win
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const here = new URL('.', import.meta.url);

/** HID report length, report id included. */
export const REPORT_BYTES = 64;
/** The deck's USB identity. */
export const VENDOR_ID = 0x1209;
export const PRODUCT_ID = 0x5754;

const DIGCF_PRESENT = 0x02;
const DIGCF_DEVICEINTERFACE = 0x10;
const GENERIC_READ = 0x8000_0000;
const GENERIC_WRITE = 0x4000_0000;
const FILE_SHARE_READ = 0x01;
const FILE_SHARE_WRITE = 0x02;
const OPEN_EXISTING = 3;

/**
 * Locate koffi: the plugin's own dependency first, then the copy the Harness
 * already carries (same ABI as the running Node).
 * @returns {any} the koffi module.
 */
export function loadKoffi() {
  const candidates = ['koffi', process.env.DSH_KOFFI, bundledKoffi()].filter(Boolean);
  let last;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`koffi not found (tried ${candidates.join(', ')}): ${last?.message ?? 'no error'}`);
}

/** Absolute path of the koffi copy to load, for the reader worker. */
export function koffiPath() {
  for (const candidate of ['koffi', process.env.DSH_KOFFI, bundledKoffi()].filter(Boolean)) {
    try {
      return require.resolve(candidate);
    } catch {
      // try the next candidate
    }
  }
  loadKoffi(); // throws with a useful message
  return require.resolve(bundledKoffi());
}

function bundledKoffi() {
  const base = process.env.LOCALAPPDATA;
  if (!base) return undefined;
  return path.join(base, 'Programs', 'DeepSeek Harness', 'resources',
    'app.asar.unpacked', 'dsh', 'node_modules', 'koffi');
}

let apis = null;

/** Bind the Win32 entry points once. */
function bind() {
  if (apis) return apis;
  const koffi = loadKoffi();
  const hid = koffi.load('hid.dll');
  const setupapi = koffi.load('setupapi.dll');
  const kernel32 = koffi.load('kernel32.dll');

  const GUID = koffi.struct('GUID', {
    Data1: 'uint32',
    Data2: 'uint16',
    Data3: 'uint16',
    Data4: 'uint8[8]',
  });
  const SP_DEVICE_INTERFACE_DATA = koffi.struct('SP_DEVICE_INTERFACE_DATA', {
    cbSize: 'uint32',
    InterfaceClassGuid: GUID,
    Flags: 'uint32',
    Reserved: 'uintptr_t',
  });
  const HIDD_ATTRIBUTES = koffi.struct('HIDD_ATTRIBUTES', {
    Size: 'uint32',
    VendorID: 'uint16',
    ProductID: 'uint16',
    VersionNumber: 'uint16',
  });

  apis = {
    hidGuid: {
      Data1: 0x4d1e55b2,
      Data2: 0xf16f,
      Data3: 0x11cf,
      Data4: [0x88, 0xcb, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30],
    },
    SetupDiGetClassDevsW: setupapi.func(
      'void *SetupDiGetClassDevsW(const GUID *classGuid, const void *enumerator, void *hwnd, uint32_t flags)'),
    SetupDiEnumDeviceInterfaces: setupapi.func(
      'bool SetupDiEnumDeviceInterfaces(void *set, void *devInfo, const GUID *classGuid, uint32_t member, _Inout_ SP_DEVICE_INTERFACE_DATA *data)'),
    SetupDiGetDeviceInterfaceDetailW: setupapi.func(
      'bool SetupDiGetDeviceInterfaceDetailW(void *set, _Inout_ SP_DEVICE_INTERFACE_DATA *data, void *detail, uint32_t detailSize, _Out_ uint32_t *required, void *devInfo)'),
    SetupDiDestroyDeviceInfoList: setupapi.func('bool SetupDiDestroyDeviceInfoList(void *set)'),
    CreateFileW: kernel32.func(
      'void *CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *sa, uint32_t disposition, uint32_t flags, void *template)'),
    CloseHandle: kernel32.func('bool CloseHandle(void *handle)'),
    WriteFile: kernel32.func(
      'bool WriteFile(void *file, const uint8_t *buffer, uint32_t bytes, _Out_ uint32_t *written, void *overlapped)'),
    GetLastError: kernel32.func('uint32_t GetLastError()'),
    HidD_GetAttributes: hid.func(
      'bool HidD_GetAttributes(void *device, _Inout_ HIDD_ATTRIBUTES *attributes)'),
    HidD_FlushQueue: hid.func('bool HidD_FlushQueue(void *device)'),
  };
  return apis;
}

/**
 * Enumerate present HID interfaces with their vendor and product id.
 * @returns {Array<{ path: string, vendorId: number, productId: number }>}
 */
export function listDevices() {
  const api = bind();
  const set = api.SetupDiGetClassDevsW(api.hidGuid, null, null, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
  if (!set) return [];
  const found = [];
  try {
    for (let index = 0; ; index += 1) {
      const data = { cbSize: 32, InterfaceClassGuid: api.hidGuid, Flags: 0, Reserved: 0 };
      if (!api.SetupDiEnumDeviceInterfaces(set, null, api.hidGuid, index, data)) break;
      const required = [0];
      api.SetupDiGetDeviceInterfaceDetailW(set, data, null, 0, required, null);
      if (!required[0]) continue;
      const detail = Buffer.alloc(Math.max(required[0], 8));
      detail.writeUInt32LE(process.arch === 'x64' ? 8 : 6, 0);
      if (!api.SetupDiGetDeviceInterfaceDetailW(set, data, detail, detail.length, required, null)) continue;
      const devicePath = detail.toString('utf16le', 4).replace(/\u0000+$/, '');
      const handle = api.CreateFileW(devicePath, GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, null, OPEN_EXISTING, 0, null);
      if (!handle) continue;
      const attributes = { Size: 12, VendorID: 0, ProductID: 0, VersionNumber: 0 };
      const ok = api.HidD_GetAttributes(handle, attributes);
      api.CloseHandle(handle);
      if (!ok) continue;
      found.push({ path: devicePath, vendorId: attributes.VendorID, productId: attributes.ProductID });
    }
  } finally {
    api.SetupDiDestroyDeviceInfoList(set);
  }
  return found;
}

/** @returns {Array<object>} the deck's own interfaces, if any are plugged in. */
export function listDecks() {
  return listDevices().filter((device) => device.vendorId === VENDOR_ID && device.productId === PRODUCT_ID);
}

/**
 * Open the deck's HID interface.
 * @param {{ path?: string, log?: (message: string) => void }} [options]
 * @returns {Promise<object>} a transport for `DeckLink`.
 */
export async function openDeck(options = {}) {
  const api = bind();
  const target = options.path ?? listDecks()[0]?.path;
  if (!target) {
    throw new Error('no OpenWalkieTalkie on USB (VID 1209 / PID 5754); check the cable and that the deck is awake');
  }
  const handle = api.CreateFileW(target, GENERIC_READ | GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE, null, OPEN_EXISTING, 0, null);
  if (!handle) throw new Error(`cannot open the deck (Win32 error ${api.GetLastError()})`);
  api.HidD_FlushQueue(handle);

  let running = true;
  const worker = new Worker(new URL('hid-reader.mjs', here), {
    workerData: { path: target, bytes: REPORT_BYTES, koffiPath: koffiPath() },
  });
  worker.unref();

  return {
    path: target,
    async start(onReport) {
      worker.on('message', (message) => {
        if (!running) return;
        if (message?.type === 'report') onReport(Uint8Array.from(message.bytes));
        else if (message?.type === 'fatal') options.log?.(message.error);
        else if (message?.type === 'error') onReport(null);
      });
      worker.on('error', (error) => options.log?.(`reader failed: ${error?.message ?? error}`));
    },
    async write(report) {
      const out = Buffer.from(report);
      if (out.length !== REPORT_BYTES) throw new RangeError(`report must be ${REPORT_BYTES} bytes`);
      const written = [0];
      if (!api.WriteFile(handle, out, out.length, written, null)) {
        throw new Error(`WriteFile failed (Win32 error ${api.GetLastError()})`);
      }
      if (written[0] !== out.length) {
        throw new Error(`WriteFile wrote ${written[0]} of ${out.length} bytes`);
      }
    },
    async stop() {
      running = false;
      await worker.terminate().catch(() => {});
      api.CloseHandle(handle);
    },
  };
}
