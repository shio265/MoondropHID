import { test, spyOn } from 'bun:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createClient, getSupportedDevices, isSupported, HidError, setDebugLogger } from '../src/index.js';
import { fakeDevice } from './smoke.js';
import { nativeProtocol, registerProtocol } from '../src/internal/protocols.js';

const filter = { type: 'PK', freq: 1000, gain: -3, q: 1 };
const config = () => ({ filters: [{ ...filter }], globalGain: 0 });
const hasCode = code => error => error instanceof HidError && error.code === code;

function transport(model = 'MOONRIVER 3', { vendorId = 0x35D8, protocol = 'moondrop' } = {}) {
  const raw = fakeDevice(model, vendorId, protocol);
  const events = new EventTarget();
  const hid = {
    raw, requests: 0, selected: [raw], devices: [raw],
    async requestDevice() { this.requests++; return this.selected; },
    async getDevices() { return this.devices; },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    unplug() {
      raw.opened = false;
      this.devices = [];
      const event = new Event('disconnect');
      Object.defineProperty(event, 'device', { value: raw });
      events.dispatchEvent(event);
    }
  };
  return hid;
}

test('imports without browser globals; unsupported calls fail explicitly', () => {
  const script = `delete globalThis.navigator; delete globalThis.window;
    const {createClient,isSupported}=await import('./src/index.js');
    if(isSupported()) throw Error('Unexpected WebHID');
    try {await createClient().connect(); throw Error('Expected error');}
    catch(e) {if(e.code!=='UNSUPPORTED_ENVIRONMENT') throw e;}`;
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url))
  });
  assert.equal(result.exitCode, 0, result.stderr.toString());
});

test('metadata lists 21 products and is deeply immutable', () => {
  const products = getSupportedDevices();
  assert.equal(products.length, 21);
  assert.equal(products.find(p => p.model === 'DAWN PRO 2').protocol, 'walkplay');
  assert.equal(products.find(p => p.model === 'DAWN PRO2').protocol, 'native');
  assert.deepEqual(products.find(p => p.model === 'MOONRIVER 3').slots, [{ id: 7, name: 'Custom' }]);
  assert.equal(products.find(p => p.model === 'FreeDSP').capabilities.supportsRead, false);
  assert.equal(products.find(p => p.model === 'FreeDSP').limits.supportsManualGlobalGain, false);
  assert.throws(() => { products[0].limits.filterTypes.push('invalid'); }, TypeError);
});

test('picker is requested synchronously from connect; connect never writes', async () => {
  const hid = transport();
  const client = createClient({ hid });
  assert.equal(isSupported(hid), true);
  const connecting = client.connect();
  assert.equal(hid.requests, 1);
  const info = await connecting;
  assert.equal(info.model, 'MOONRIVER 3');
  assert.equal(client.connected, true);
  assert.equal(hid.raw.reports.length, 0);
  assert.equal(await client.connect(), info);
  assert.equal(hid.requests, 1);
  await client.disconnect();
  assert.equal(client.device, null);
  assert.equal(hid.raw.opened, false);
});

test('cancelled and unsupported chooser selections do not open devices', async () => {
  const cancelled = transport();
  cancelled.selected = [];
  assert.equal(await createClient({ hid: cancelled }).connect(), null);
  assert.equal(cancelled.raw.opens, 0);
  const unsupported = transport('Another brand');
  await assert.rejects(createClient({ hid: unsupported }).connect(), hasCode('UNSUPPORTED_DEVICE'));
  assert.equal(unsupported.raw.opens, 0);
});

test('experimental products require opt-in before opening HID', async () => {
  const hid = transport('MD-QT-042', { protocol: 'walkplay' });
  await assert.rejects(createClient({ hid }).connect(), hasCode('EXPERIMENTAL_DEVICE'));
  assert.equal(hid.raw.opens, 0);
  const client = createClient({ hid, allowExperimental: true });
  assert.equal((await client.connect()).experimental, true);
  await client.disconnect();
});

test('connection errors retain their cause; repeated connect cannot race the picker', async () => {
  const hid = transport();
  let rejectPicker;
  hid.requestDevice = () => new Promise((resolve, reject) => { rejectPicker = reject; });
  const client = createClient({ hid });
  const first = client.connect();
  await assert.rejects(client.connect(), hasCode('BUSY'));
  await assert.rejects(client.readConfig(), hasCode('BUSY'));
  const cause = new Error('Permission denied');
  rejectPicker(cause);
  await assert.rejects(first, error => error.code === 'CONNECTION_FAILED' && error.cause === cause);
  hid.requestDevice = async () => { throw Object.assign(new Error('Cancelled'), { name: 'NotFoundError' }); };
  assert.equal(await client.connect(), null);
});

test('native read returns complete EQ configuration with signed gain', async () => {
  const hid = transport();
  const client = createClient({ hid });
  await client.connect();
  const result = await client.readConfig();
  assert.equal(result.filters.length, 8);
  assert.deepEqual(result.filters[0], { ...filter, disabled: false });
  assert.equal(result.globalGain, -2);
  assert.equal(result.slot, 7);
  assert.equal(result.complete, true);
  await client.disconnect();
});

test('write pads unused filters, snapshots input, and does not double-apply pregain', async () => {
  const hid = transport();
  const client = createClient({ hid });
  await client.connect();
  const input = { filters: [{ ...filter }], globalGain: -3 };
  const writing = client.writeConfig(input);
  input.filters[0].freq = 5000;
  const result = await writing;
  assert.equal(hid.raw.reports.length, 17);
  assert.equal(hid.raw.reports[0].bytes[27] | (hid.raw.reports[0].bytes[28] << 8), 1000);
  assert.equal(result.filtersWritten, 8);
  assert.equal(result.globalGainApplied, false);
  assert.equal(result.verified, false);
  assert.equal(input.filters.length, 1);
  await client.disconnect();
});

test('manual pregain can be reset to zero and transport write failures are not hidden', async () => {
  const hid = transport('FreeDSP Mini');
  const client = createClient({ hid });
  await client.connect();
  assert.equal((await client.writeConfig(config())).globalGainApplied, true);
  assert.deepEqual(hid.raw.reports.find(r => r.bytes[1] === 0x23).bytes, [1, 0x23, 0, 0, 0]);
  const send = hid.raw.sendReport.bind(hid.raw);
  hid.raw.reports = [];
  hid.raw.sendReport = async (id, bytes) => {
    if (bytes[1] === 0x23) throw new Error('Gain write failed');
    return send(id, bytes);
  };
  await assert.rejects(client.writeConfig(config()), hasCode('IO_ERROR'));
  assert.equal(hid.raw.reports.some(r => r.bytes.length === 2 && r.bytes[1] === 1), false);
  await client.disconnect();
});

test('invalid EQ data is rejected before sending any HID report', async () => {
  const hid = transport();
  const client = createClient({ hid });
  await client.connect();
  for (const input of [
    { filters: [] }, { filters: new Array(1) },
    { filters: Array.from({ length: 9 }, () => ({ ...filter })) },
    { filters: [{ ...filter, freq: NaN }] }, { filters: [{ ...filter, freq: 20.5 }] },
    { filters: [{ ...filter, q: 0 }] }, { filters: [{ ...filter, gain: Infinity }] },
    { filters: [{ ...filter, gain: 13 }] }, { filters: [{ ...filter, type: 'unknown' }] },
    { filters: [{ ...filter, disabled: 'false' }] }, { filters: [filter], globalGain: null },
    { filters: [filter], globalGain: -129 }
  ]) {
    await assert.rejects(client.writeConfig(input), hasCode('INVALID_CONFIG'));
  }
  await assert.rejects(client.writeConfig(config(), { slot: 999 }), hasCode('INVALID_CONFIG'));
  assert.equal(hid.raw.reports.length, 0);
  await client.disconnect();
});

test('disabled bands are written as harmless flat filters', async () => {
  const hid = transport();
  const client = createClient({ hid });
  await client.connect();
  await client.writeConfig({ filters: [{ type: 'PK', freq: 0, q: 0, gain: 12, disabled: true }] });
  const packet = hid.raw.reports[0].bytes;
  assert.equal(packet[27], 100);
  assert.equal(packet[31] | packet[32], 0);
  await client.disconnect();
});

test('write-only devices cannot be read as fake configuration backups', async () => {
  const hid = transport('FreeDSP', { protocol: 'conexant' });
  const client = createClient({ hid });
  await client.connect();
  await assert.rejects(client.readConfig(), hasCode('UNSUPPORTED_READ'));
  await assert.rejects(client.writeConfig({ filters: [filter], globalGain: -3 }), hasCode('UNSUPPORTED_OPERATION'));
  assert.equal(hid.raw.reports.length, 0);
  await client.disconnect();
});

test('unsupported filters and bypass operations fail instead of silently changing behavior', async () => {
  const hid = transport('Rays');
  const client = createClient({ hid });
  await client.connect();
  await assert.rejects(client.writeConfig({ filters: [{ ...filter, type: 'LSQ' }] }), hasCode('INVALID_CONFIG'));
  await assert.rejects(client.setEqEnabled(false), hasCode('UNSUPPORTED_OPERATION'));
  assert.equal(hid.raw.reports.length, 0);
  await client.disconnect();
});

test('per-client queue prevents read/write interleaving and disconnect waits for queued work', async () => {
  const hid = transport();
  const client = createClient({ hid });
  await client.connect();
  const reading = client.readConfig();
  const writing = client.writeConfig(config());
  const closing = client.disconnect();
  await Promise.all([reading, writing, closing]);
  assert.equal(hid.raw.reports.findIndex(report => report.bytes[0] === 1), 10);
  assert.equal(client.connected, false);
});

test('client instances do not share connection state', async () => {
  const first = transport();
  const second = transport('Marigold');
  const a = createClient({ hid: first });
  const b = createClient({ hid: second });
  await a.connect();
  await b.connect();
  await a.disconnect();
  assert.equal(b.connected, true);
  assert.equal(second.raw.opened, true);
  await b.disconnect();
});

test('disconnect observers are isolated and subscriptions can be removed', async () => {
  const hid = transport();
  const client = createClient({ hid });
  const events = [];
  client.subscribe(() => { throw new Error('Observer failure'); });
  const unsubscribe = client.subscribe(event => events.push(event));
  await client.connect();
  hid.unplug();
  assert.equal(client.connected, false);
  assert.equal(events[1].reason, 'device-disconnected');
  await assert.rejects(client.readConfig(), hasCode('NOT_CONNECTED'));
  unsubscribe();
  await client.connect();
  assert.equal(events.length, 2);
  await client.disconnect();
});

test('transport read failures clean up listeners and the operation queue recovers', async () => {
  const hid = transport();
  const client = createClient({ hid });
  await client.connect();
  const send = hid.raw.sendReport.bind(hid.raw);
  hid.raw.sendReport = async () => { throw new Error('Read failed'); };
  await assert.rejects(client.getCurrentSlot(), hasCode('IO_ERROR'));
  assert.equal(hid.raw.inputReportListeners.size, 0);
  hid.raw.sendReport = send;
  assert.equal(await client.getCurrentSlot(), 7);
  await client.disconnect();
});

test('a different physical device with identical IDs is never substituted', async () => {
  const hid = transport();
  const client = createClient({ hid });
  await client.connect();
  const replacement = fakeDevice('MOONRIVER 3');
  hid.devices = [replacement];
  await assert.rejects(client.writeConfig(config()), hasCode('DEVICE_DISCONNECTED'));
  assert.equal(replacement.opens, 0);
  assert.equal(replacement.reports.length, 0);
  assert.equal(client.connected, false);
  await hid.raw.close();
});

test('disconnect during an in-flight operation rejects without leaking the report listener', async () => {
  const hid = transport();
  const client = createClient({ hid });
  await client.connect();
  let rejectSend;
  hid.raw.sendReport = () => new Promise((resolve, reject) => { rejectSend = reject; });
  const reading = client.getCurrentSlot();
  await new Promise(resolve => setImmediate(resolve));
  hid.unplug();
  rejectSend(new Error('Unplugged'));
  await assert.rejects(reading, hasCode('DEVICE_DISCONNECTED'));
  assert.equal(hid.raw.inputReportListeners.size, 0);
});

test('report decoding respects DataView byteOffset and byteLength', async () => {
  const hid = transport();
  const dispatch = hid.raw.dispatchEvent.bind(hid.raw);
  hid.raw.dispatchEvent = event => {
    const buffer = new Uint8Array(event.data.byteLength + 12);
    buffer.set(new Uint8Array(event.data.buffer), 5);
    const shifted = new Event('inputreport');
    Object.defineProperties(shifted, {
      data: { value: new DataView(buffer.buffer, 5, event.data.byteLength) },
      reportId: { value: event.reportId }
    });
    return dispatch(shifted);
  };
  const client = createClient({ hid });
  await client.connect();
  assert.equal((await client.readConfig()).filters[0].freq, 1000);
  await client.disconnect();
});

test('DAC settings expose real readable/writable capabilities and validate values', async () => {
  const hid = transport('DAWN PRO 2', { protocol: 'walkplay' });
  const client = createClient({ hid });
  const info = await client.connect();
  assert.equal(info.capabilities.settings.dacFilter.readable, true);
  assert.equal(await client.readSetting('dacFilter'), 'SLOW-LL');
  await client.writeSetting('dacFilter', 'SLOW-PC');
  assert.deepEqual(hid.raw.reports.at(-1).bytes, [1, 0x11, 1, 4]);
  await client.writeSetting('dacBalance', { left: 0, right: 5 });
  await client.setEqEnabled(false);
  const before = hid.raw.reports.length;
  await assert.rejects(client.writeSetting('dacBalance', { left: 1, right: 2 }), hasCode('INVALID_CONFIG'));
  await assert.rejects(client.writeSetting('dacFilter', 'invalid'), hasCode('INVALID_CONFIG'));
  await assert.rejects(client.writeSetting('micGain', 16), hasCode('INVALID_CONFIG'));
  await assert.rejects(client.writeSetting('dacWorkMode', 3), hasCode('INVALID_CONFIG'));
  await assert.rejects(client.readSetting('outputGain'), hasCode('UNSUPPORTED_OPERATION'));
  await assert.rejects(client.writeSetting('__proto__', true), hasCode('UNSUPPORTED_OPERATION'));
  assert.equal(hid.raw.reports.length, before);
  await client.disconnect();
});

test('failed close does not report a disconnected state', async () => {
  const hid = transport();
  const client = createClient({ hid });
  await client.connect();
  const close = hid.raw.close.bind(hid.raw);
  hid.raw.close = async () => { throw new Error('Cannot close'); };
  await assert.rejects(client.disconnect(), hasCode('IO_ERROR'));
  assert.equal(client.connected, true);
  hid.raw.close = close;
  await client.disconnect();
});

test('diagnostics are opt-in and logging errors cannot interrupt a write', async () => {
  const hid = transport();
  const client = createClient({ hid });
  await client.connect();
  let messages = 0;
  setDebugLogger(() => { messages++; throw new Error('Logger failure'); });
  try { await client.writeConfig(config()); }
  finally { setDebugLogger(null); }
  assert.ok(messages > 0);
  assert.throws(() => setDebugLogger(true), TypeError);
  await client.disconnect();
});

test('connected observers can immediately enqueue reads', async () => {
  const hid = transport();
  const client = createClient({ hid });
  let reading;
  client.subscribe(event => {
    if (event.type === 'connected') reading = client.getCurrentSlot();
  });
  await client.connect();
  assert.equal(await reading, 7);
  await client.disconnect();
});

test('missing bands and failed global gain reads are not exposed as complete backups', async () => {
  const hid = transport();
  const client = createClient({ hid });
  await client.connect();
  const pull = nativeProtocol.pullFromDevice;
  nativeProtocol.pullFromDevice = async () => ({ filters: [filter], globalGain: 0 });
  try { await assert.rejects(client.readConfig(), hasCode('INCOMPLETE_READ')); }
  finally { nativeProtocol.pullFromDevice = pull; }
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  const send = hid.raw.sendReport.bind(hid.raw);
  hid.raw.sendReport = async (id, bytes) => {
    if (bytes[0] === 0x80 && bytes[1] === 0x03) throw new Error('No global gain response');
    return send(id, bytes);
  };
  try {
    await assert.rejects(client.readConfig(), error => error.code === 'INCOMPLETE_READ' && error.details.field === 'globalGain');
    await client.disconnect();
  } finally { warning.mockRestore(); }
});

test('write-reset disconnects are reported as successful sends, not I/O failures', async () => {
  const hid = transport('CDSP', { vendorId: 0x31B2, protocol: 'ktmicro' });
  const client = createClient({ hid });
  const events = [];
  client.subscribe(event => events.push(event));
  await client.connect();
  const push = registerProtocol.pushToDevice;
  registerProtocol.pushToDevice = async () => true;
  try {
    const result = await client.writeConfig(config());
    assert.equal(result.disconnected, true);
    assert.equal(client.connected, false);
    assert.equal(events.at(-1).reason, 'write-reset');
  } finally { registerProtocol.pushToDevice = push; }
});

test('reconnecting after physical unplug reaches the chooser without awaiting a stale close', async () => {
  const hid = transport();
  const client = createClient({ hid });
  await client.connect();
  hid.unplug();
  hid.raw.close = () => new Promise(() => {});
  const opening = client.connect();
  assert.equal(hid.requests, 2);
  await opening;
  hid.raw.close = async () => { hid.raw.opened = false; };
  await client.disconnect();
});
