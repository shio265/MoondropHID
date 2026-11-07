import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createClient } from '../../src/index.js';
import { nativeProtocol, registerProtocol } from '../../src/handlers/index.js';
import { memoryTransport } from '../helpers/memory.js';
import { transport } from '../helpers/transport.js';

const filter = { type: 'PK', freq: 1235, gain: -3.333, q: 0.711 };

test('opt-in verification reads all native bands, including flat padding, without double-applying pregain', async () => {
  const hid = memoryTransport();
  const client = createClient({ hid });
  await client.connect();
  const progress = [];
  try {
    const result = await client.writeConfig({ filters: [filter], globalGain: -5 },
      { verify: true, onProgress: event => progress.push(event) });
    assert.equal(result.verified, true);
    assert.equal(result.verification.status, 'verified');
    assert.equal(result.globalGainApplied, false);
    assert.equal(hid.memory.globalGain, -2);
    assert.equal(hid.raw.reports.length, 27);
    assert.deepEqual(progress.filter(event => event.phase === 'verify' && event.completed > 0)
      .map(event => event.completed), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(progress.at(-1).status, 'completed');
  } finally { await client.disconnect(); }
});

test('host-managed pregain is quantized and included in native verification', async () => {
  const hid = memoryTransport('FreeDSP Mini');
  const client = createClient({ hid });
  await client.connect();
  try {
    assert.equal((await client.writeConfig({ filters: [filter], globalGain: -2.333 }, { verify: true })).verified, true);
    hid.memory.onRead = (data, request) => {
      if (request[1] === 0x03) new DataView(data.buffer).setInt16(3, -256, true);
    };
    await assert.rejects(client.writeConfig({ filters: [filter], globalGain: -2.333 }, { verify: true }),
      error => error.code === 'VERIFICATION_FAILED' && error.details.writeCompleted &&
        error.details.verification.differences.some(item => item.field === 'globalGain'));
  } finally { await client.disconnect(); }
});

test('WalkPlay verification accounts for disabled bands, two-decimal reads and integer pregain', async () => {
  const hid = memoryTransport('DAWN PRO 2', { protocol: 'walkplay' });
  const client = createClient({ hid });
  await client.connect();
  try {
    const result = await client.writeConfig({ filters: [
      { ...filter, disabled: true }, { ...filter, type: 'LSQ', q: 0.712 }
    ], globalGain: -2.4 }, { verify: true });
    assert.equal(result.verified, true);
    assert.equal(hid.memory.globalGain, -2);
    assert.equal(hid.memory.bands.get(0)[27], 0);
  } finally { await client.disconnect(); }
});

test('register and legacy read-back use their own gain and Q encoding', async () => {
  for (const [model, protocol, vendorId] of [['CDSP', 'ktmicro', 0x31B2], ['Old Fashioned', 'legacy', 0x35D8]]) {
    const hid = memoryTransport(model, { protocol, vendorId });
    const client = createClient({ hid });
    await client.connect();
    try {
      const result = await client.writeConfig({ filters: [{ ...filter, gain: 2.34, q: 0.7533 }] }, { verify: true });
      assert.equal(result.verified, true, model);
    } finally { await client.disconnect(); }
  }
});

test('a mismatch in an omitted padding band fails verification without retrying or rolling back writes', async () => {
  const hid = memoryTransport();
  const client = createClient({ hid });
  await client.connect();
  try {
    hid.memory.onRead = (data, request) => {
      if (request[1] === 0x09 && request[4] === 7) new DataView(data.buffer).setUint16(27, 999, true);
    };
    await assert.rejects(client.writeConfig({ filters: [filter] }, { verify: true }), error => {
      assert.equal(error.code, 'VERIFICATION_FAILED');
      assert.equal(error.details.mayHaveWritten, true);
      assert.ok(error.details.verification.differences.some(item => item.field === 'filters[7].freq'));
      return true;
    });
    assert.equal(hid.raw.reports.filter(report => report.bytes.length === 2 && report.bytes[1] === 1).length, 1);
    assert.equal(client.connected, true);
    hid.memory.onRead = null;
    assert.equal((await client.readConfig()).filters[7].freq, 100);
  } finally { await client.disconnect(); }
});

test('verification rejects a different slot and incomplete read-back instead of claiming success', async () => {
  const hid = memoryTransport();
  const client = createClient({ hid });
  await client.connect();
  try {
    hid.memory.slot = 6;
    await assert.rejects(client.writeConfig({ filters: [filter] }, { verify: true }),
      error => error.code === 'VERIFICATION_FAILED' && error.details.verification.differences.some(item => item.field === 'slot'));
    hid.memory.slot = 7;
    const pull = nativeProtocol.pullFromDevice;
    nativeProtocol.pullFromDevice = async () => ({ filters: [filter], globalGain: 0 });
    try {
      await assert.rejects(client.writeConfig({ filters: [filter] }, { verify: true }),
        error => error.code === 'VERIFICATION_FAILED' && error.cause.code === 'INCOMPLETE_READ' &&
          error.details.verification.status === 'read-failed');
    } finally { nativeProtocol.pullFromDevice = pull; }
  } finally { await client.disconnect(); }
});

test('malformed and non-finite read-back values never pass verification or leak non-JSON differences', async () => {
  const hid = memoryTransport();
  const client = createClient({ hid });
  await client.connect();
  const pull = nativeProtocol.pullFromDevice;
  try {
    for (const gain of [NaN, Infinity, undefined, '-3']) {
      nativeProtocol.pullFromDevice = async () => ({ filters: Array.from({ length: 8 }, (_, index) =>
        index === 0 ? { type: 'PK', freq: 1000, gain, q: 1 } : { type: 'PK', freq: 100, gain: 0, q: 1 }), globalGain: 0 });
      await assert.rejects(client.writeConfig({ filters: [{ type: 'PK', freq: 1000, gain: -3, q: 1 }] }, { verify: true }), error => {
        assert.equal(error.code, 'VERIFICATION_FAILED');
        const differences = error.details.verification.differences;
        assert.ok(differences.some(item => item.field === 'filters[0].gain'));
        assert.deepEqual(JSON.parse(JSON.stringify(differences)), differences);
        return true;
      });
    }
  } finally { nativeProtocol.pullFromDevice = pull; await client.disconnect(); }
});

test('write-only devices return an explicit unverified result without sending read commands', async () => {
  const hid = transport('FreeDSP', { protocol: 'conexant' });
  const client = createClient({ hid });
  await client.connect();
  try {
    const result = await client.writeConfig({ filters: [filter] }, { verify: true });
    assert.equal(result.verified, false);
    assert.equal(result.verification.status, 'unsupported-read');
    assert.ok(hid.raw.reports.every(report => report.bytes[0] === 1));
  } finally { await client.disconnect(); }
});

test('a protocol-requested write reset skips verification and keeps disconnected as the final lifecycle event', async () => {
  const hid = transport('CDSP', { protocol: 'ktmicro', vendorId: 0x31B2 });
  const client = createClient({ hid });
  const events = [];
  client.subscribe(event => events.push(event));
  await client.connect();
  const push = registerProtocol.pushToDevice;
  registerProtocol.pushToDevice = async () => true;
  try {
    const result = await client.writeConfig({ filters: [filter] }, { verify: true });
    assert.equal(result.verified, false);
    assert.equal(result.verification.status, 'device-reset');
    assert.equal(client.connected, false);
    assert.equal(events.at(-1).reason, 'write-reset');
  } finally { registerProtocol.pushToDevice = push; await client.disconnect(); }
});

test('cancelling verification reports completed writes but never verified success', async () => {
  const hid = memoryTransport();
  const client = createClient({ hid });
  const controller = new AbortController();
  await client.connect();
  try {
    await assert.rejects(client.writeConfig({ filters: [filter] }, { verify: true, signal: controller.signal,
      onProgress(event) { if (event.phase === 'verify') controller.abort(); } }),
    error => error.code === 'ABORTED' && error.details.mayHaveWritten && error.details.writeCompleted);
    assert.equal(hid.raw.reports.length, 17);
    assert.equal(await client.getCurrentSlot(), 7);
  } finally { await client.disconnect(); }
});
