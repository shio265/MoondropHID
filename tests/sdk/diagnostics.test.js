import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createClient, getSupportedDevices, inspectDevice, HidError } from '../../src/index.js';
import { transport } from '../helpers/transport.js';

const hasCode = code => error => error instanceof HidError && error.code === code;

test('inspection invokes the chooser synchronously and returns copied descriptors without opening HID', async () => {
  const hid = transport();
  let chooserOptions;
  hid.requestDevice = options => { hid.requests++; chooserOptions = options; return Promise.resolve(hid.selected); };
  hid.getDevices = async () => { throw new Error('Inspection must not enumerate granted devices'); };
  hid.raw.collections = [{ usagePage: 0xFF00, usage: 1,
    inputReports: [{ reportId: 0x4B, items: [{ secret: 'not copied' }] }],
    outputReports: [{ reportId: 1 }], featureReports: [{ reportId: 2 }],
    children: [{ usagePage: 0x0C, usage: 3 }] }];
  Object.defineProperty(hid.raw, 'serialNumber', { get() { throw new Error('Serial numbers must not be read'); } });
  const inspecting = inspectDevice({ hid });
  assert.equal(hid.requests, 1);
  assert.deepEqual(chooserOptions, { filters: [] });
  const result = await inspecting;
  assert.equal(result.supported, true);
  assert.equal(result.device.model, 'MOONRIVER 3');
  assert.equal(result.device.protocol, 'native');
  assert.equal(result.opened, false);
  assert.deepEqual(result.collections[0], { usagePage: 0xFF00, usage: 1,
    inputReportIds: [0x4B], outputReportIds: [1], featureReportIds: [2],
    children: [{ usagePage: 0x0C, usage: 3, inputReportIds: [], outputReportIds: [], featureReportIds: [], children: [] }] });
  assert.equal(hid.raw.opens, 0);
  assert.equal(hid.raw.reports.length, 0);
  assert.throws(() => result.collections[0].inputReportIds.push(99), TypeError);
  assert.throws(() => { result.device.limits.maxFilters = 99; }, TypeError);
  hid.raw.collections[0].inputReports[0].reportId = 9;
  assert.equal(result.collections[0].inputReportIds[0], 0x4B);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('unknown devices are inspectable but are never registered, opened or written', async () => {
  for (const [model, vendorId] of [['Unknown DAC', 0x35D8], ['MOONRIVER 3', 0x9999]]) {
    const hid = transport(model, { vendorId });
    const result = await inspectDevice({ hid });
    assert.equal(result.productName, model);
    assert.equal(result.vendorId, vendorId);
    assert.equal(result.supported, false);
    assert.equal(result.device, null);
    assert.equal(hid.raw.opens, 0);
    assert.equal(hid.raw.reports.length, 0);
  }
  assert.equal(getSupportedDevices().length, 21);
});

test('inspection handles chooser cancellation and reports typed transport/environment failures', async () => {
  const hid = transport();
  hid.selected = [];
  assert.equal(await inspectDevice({ hid }), null);
  for (const name of ['NotFoundError', 'AbortError']) {
    hid.requestDevice = async () => { throw new DOMException('Cancelled', name); };
    assert.equal(await inspectDevice({ hid }), null);
  }
  const cause = new Error('Chooser failed');
  hid.requestDevice = async () => { throw cause; };
  await assert.rejects(inspectDevice({ hid }), error => hasCode('CONNECTION_FAILED')(error) && error.cause === cause);
  await assert.rejects(inspectDevice({ hid: {} }), hasCode('UNSUPPORTED_ENVIRONMENT'));
  const script = `delete globalThis.navigator; delete globalThis.window;
    const {inspectDevice,createClient}=await import('./src/index.js');
    try {await inspectDevice(); throw Error('Expected unsupported environment');}
    catch(e) {if(e.code!=='UNSUPPORTED_ENVIRONMENT') throw e;}
    const client=createClient();
    try {await client.connect();} catch(e) {if(e.code!=='UNSUPPORTED_ENVIRONMENT') throw e;}
    if(client.getDiagnostics().lastError.code!=='UNSUPPORTED_ENVIRONMENT') throw Error('Missing diagnostic');
    globalThis.isSecureContext=false;
    try {await inspectDevice(); throw Error('Expected secure context error');}
    catch(e) {if(e.code!=='INSECURE_CONTEXT') throw e;}`;
  const result = Bun.spawnSync([process.execPath, '-e', script], { cwd: fileURLToPath(new URL('../../', import.meta.url)) });
  assert.equal(result.exitCode, 0, result.stderr.toString());
});

test('diagnostics snapshots are synchronous, inert, serializable and immutable before and after connection', async () => {
  const hid = transport();
  const client = createClient({ hid });
  const initial = client.getDiagnostics({ includeLogs: true });
  assert.equal(initial.schemaVersion, 1);
  assert.equal(initial.connected, false);
  assert.equal(initial.device, null);
  assert.equal(initial.lastDevice, null);
  assert.equal(initial.pendingOperations, 0);
  assert.equal(initial.activeOperation, null);
  assert.equal(initial.lastError, null);
  assert.deepEqual(initial.logs, []);
  assert.equal(initial.environment.webHidSupported, true);
  assert.equal(hid.requests, 0);
  assert.equal(hid.raw.opens, 0);
  await client.connect();
  try {
    await client.getCurrentSlot();
    const before = hid.raw.reports.length;
    const snapshot = client.getDiagnostics({ includeLogs: true });
    assert.equal(snapshot.connected, true);
    assert.equal(snapshot.device, client.device);
    assert.equal(snapshot.lastDevice.opened, true);
    assert.equal(snapshot.logging.enabled, false);
    assert.equal(snapshot.logging.retainedEntries, 0);
    assert.deepEqual(snapshot.logs, []);
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
    assert.throws(() => { snapshot.lastDevice.collections[0].usagePage = 0; }, TypeError);
    assert.equal(hid.raw.reports.length, before);
    assert.equal(hid.requests, 1);
    assert.ok(!Object.hasOwn(snapshot.lastDevice, 'rawDevice'));
  } finally { await client.disconnect(); }
  const closed = client.getDiagnostics();
  assert.equal(closed.connected, false);
  assert.equal(closed.device, null);
  assert.equal(closed.lastDevice.productName, 'MOONRIVER 3');
  assert.equal(closed.lastDevice.opened, false);
});

test('an unsupported connection retains descriptor diagnostics without exposing native handles or exception secrets', async () => {
  const hid = transport('Unknown DAC');
  hid.raw.serialNumber = 'private-serial-number';
  hid.raw.privateData = 'private-native-handle-data';
  const client = createClient({ hid, diagnostics: true });
  await assert.rejects(client.connect(), hasCode('UNSUPPORTED_DEVICE'));
  const report = client.getDiagnostics({ includeLogs: true });
  assert.equal(report.lastDevice.supported, false);
  assert.equal(report.lastDevice.device, null);
  assert.equal(report.lastError.code, 'UNSUPPORTED_DEVICE');
  assert.equal(report.lastError.operation, 'connect');
  assert.equal(hid.raw.opens, 0);
  assert.deepEqual(report.logs, []);
  const serialized = JSON.stringify(report);
  for (const forbidden of ['private-serial-number', 'private-native-handle-data', 'rawDevice', 'serialNumber', 'stack', 'cause']) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
  hid.requestDevice = async () => { throw new Error('private-exception-token'); };
  await assert.rejects(client.connect(), hasCode('CONNECTION_FAILED'));
  assert.ok(!JSON.stringify(client.getDiagnostics()).includes('private-exception-token'));
});

test('wire capture is opt-in, bounded and omitted from snapshots unless explicitly requested', async () => {
  const hid = transport();
  const client = createClient({ hid, diagnostics: { maxEntries: 3 } });
  await client.connect();
  try {
    await client.getCurrentSlot();
    const first = client.getDiagnostics({ includeLogs: true });
    assert.deepEqual(first.logs.map(entry => entry.direction), ['tx', 'rx']);
    assert.deepEqual(first.logs[0].bytes, [0x80, 0x0F, 0]);
    assert.equal(first.logs[0].operation, 'getCurrentSlot');
    assert.equal(first.logs[0].reportId, 0x4B);
    assert.equal(first.logs[0].truncated, false);
    assert.equal(typeof first.logs[0].timestamp, 'number');
    await client.getCurrentSlot();
    const second = client.getDiagnostics({ includeLogs: true });
    assert.deepEqual(second.logs.map(entry => entry.direction), ['rx', 'tx', 'rx']);
    assert.deepEqual(second.logs.map(entry => entry.operationId), [1, 2, 2]);
    assert.equal(second.logging.retainedEntries, 3);
    assert.equal(second.logging.maxEntries, 3);
    assert.deepEqual(client.getDiagnostics().logs, []);
    assert.equal(first.logs.length, 2, 'Older snapshots must not change');
    assert.throws(() => { second.logs[0].bytes[0] = 0; }, TypeError);
    assert.throws(() => second.logs.pop(), TypeError);
  } finally { await client.disconnect(); }
});

test('diagnostics capture and last errors are isolated per client', async () => {
  const hidA = transport(), hidB = transport('Marigold');
  const a = createClient({ hid: hidA, diagnostics: true });
  const b = createClient({ hid: hidB, diagnostics: true });
  await a.connect();
  await b.connect();
  try {
    await a.getCurrentSlot();
    assert.equal(a.getDiagnostics({ includeLogs: true }).logs.length, 2);
    assert.equal(b.getDiagnostics({ includeLogs: true }).logs.length, 0);
    hidA.raw.sendReport = async () => { throw new Error('private-I/O-cause'); };
    await assert.rejects(a.getCurrentSlot(), hasCode('IO_ERROR'));
    assert.equal(a.getDiagnostics().lastError.code, 'IO_ERROR');
    assert.equal(a.getDiagnostics().lastError.operationId, 2);
    assert.ok(!JSON.stringify(a.getDiagnostics()).includes('private-I/O-cause'));
    assert.equal(b.getDiagnostics().lastError, null);
    await b.getCurrentSlot();
    assert.equal(b.getDiagnostics({ includeLogs: true }).logs[0].operationId, 1);
    assert.equal(a.getDiagnostics().pendingOperations, 0);
    assert.equal(a.getDiagnostics().activeOperation, null);
  } finally { await a.disconnect(); await b.disconnect(); }
});

test('overlapping WalkPlay response listeners capture each RX event only once', async () => {
  const hid = transport('DAWN PRO 2', { protocol: 'walkplay' });
  const client = createClient({ hid, diagnostics: true });
  await client.connect();
  try {
    await client.readConfig();
    const logs = client.getDiagnostics({ includeLogs: true }).logs;
    assert.equal(logs.filter(entry => entry.direction === 'tx').length, 11);
    assert.equal(logs.filter(entry => entry.direction === 'rx').length, 11);
    assert.equal(logs.filter(entry => entry.direction === 'rx' && entry.bytes[1] === 0x03).length, 1);
    assert.equal(hid.raw.inputReportListeners.size, 0);
  } finally { await client.disconnect(); }
});

test('wire diagnostics use only the DataView slice and truncate oversized reports', async () => {
  const hid = transport();
  const dispatch = hid.raw.dispatchEvent.bind(hid.raw);
  const buffer = new Uint8Array(320).fill(0xAA);
  const payload = buffer.subarray(5, 305);
  payload.fill(0x5A);
  hid.raw.dispatchEvent = event => {
    payload.set(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
    const shifted = new Event('inputreport');
    Object.defineProperties(shifted, { data: { value: new DataView(buffer.buffer, 5, 300) },
      reportId: { value: event.reportId } });
    return dispatch(shifted);
  };
  const client = createClient({ hid, diagnostics: true });
  await client.connect();
  try {
    assert.equal(await client.getCurrentSlot(), 7);
    const entry = client.getDiagnostics({ includeLogs: true }).logs[1];
    assert.equal(entry.byteLength, 300);
    assert.equal(entry.bytes.length, 256);
    assert.equal(entry.truncated, true);
    assert.deepEqual(entry.bytes, [...payload.subarray(0, 256)]);
    payload.fill(0);
    assert.equal(entry.bytes[0], 0x80);
  } finally { await client.disconnect(); }
});

test('early validation, cloning and pre-aborted errors are included in diagnostics without their causes', async () => {
  const hid = transport();
  const client = createClient({ hid });
  const controller = new AbortController();
  controller.abort(new Error('private-abort-reason'));
  await assert.rejects(client.readConfig({ signal: controller.signal }), hasCode('ABORTED'));
  assert.equal(client.getDiagnostics().lastError.code, 'ABORTED');
  await assert.rejects(client.readConfig({ timeoutMs: 0 }), hasCode('INVALID_CONFIG'));
  assert.equal(client.getDiagnostics().lastError.code, 'INVALID_CONFIG');
  await assert.rejects(client.writeConfig({ filters: [], private: () => {} }), hasCode('INVALID_CONFIG'));
  assert.equal(client.getDiagnostics().lastError.operation, 'writeConfig');
  await assert.rejects(client.writeSetting('gainMode', () => {}), hasCode('INVALID_CONFIG'));
  assert.equal(client.getDiagnostics().lastError.operation, 'writeSetting');
  assert.ok(!JSON.stringify(client.getDiagnostics()).includes('private-abort-reason'));
  assert.equal(hid.requests, 0);
  assert.equal(hid.raw.reports.length, 0);
});

test('diagnostics configuration and snapshot options reject malformed values', () => {
  for (const diagnostics of [null, [], 1, 'yes', { maxEntries: 0 }, { maxEntries: 501 }, { maxEntries: 1.5 }, { maxEntries: NaN }]) {
    assert.throws(() => createClient({ diagnostics }), hasCode('INVALID_CONFIG'));
  }
  assert.equal(createClient({ diagnostics: true }).getDiagnostics().logging.maxEntries, 100);
  assert.equal(createClient({ diagnostics: { maxEntries: 500 } }).getDiagnostics().logging.maxEntries, 500);
  const client = createClient();
  for (const options of [null, [], true, { includeLogs: 'yes' }]) {
    assert.throws(() => client.getDiagnostics(options), hasCode('INVALID_CONFIG'));
  }
});

test('descriptor diagnostics bound cyclic or excessive descriptor trees', async () => {
  const hid = transport('Unknown DAC');
  const collection = { usagePage: 0xFF00, inputReports: Array.from({ length: 300 }, (_, reportId) => ({ reportId })) };
  collection.children = [collection];
  hid.raw.collections = Array(70).fill(collection);
  const result = await inspectDevice({ hid });
  assert.equal(result.collections.length, 64);
  assert.equal(result.collections[0].inputReportIds.length, 256);
  let current = result.collections[0];
  for (let depth = 0; depth < 8; depth++) current = current.children[0];
  assert.deepEqual(current.children, []);
  assert.doesNotThrow(() => JSON.stringify(result));
});
