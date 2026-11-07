import { test, spyOn } from 'bun:test';
import assert from 'node:assert/strict';
import { createClient } from '../../src/index.js';
import { transport } from '../helpers/transport.js';
import { deferred } from '../helpers/deferred.js';

const filter = { type: 'PK', freq: 1000, gain: -3, q: 1 };
const hasCode = code => error => error.code === code;

test('already-aborted operations reject without sending reports and do not poison the queue', async () => {
  const hid = transport();
  const client = createClient({ hid });
  const controller = new AbortController();
  controller.abort('User cancelled');
  await client.connect();
  try {
    await assert.rejects(client.readConfig({ signal: controller.signal }), error =>
      error.code === 'ABORTED' && !error.details.mayHaveWritten && error.details.reportsSent === 0);
    await assert.rejects(client.writeConfig({ filters: [filter] }, { signal: controller.signal }), hasCode('ABORTED'));
    assert.equal(hid.raw.reports.length, 0);
    assert.equal(client.getDiagnostics().pendingOperations, 0);
    assert.equal(await client.getCurrentSlot(), 7);
  } finally { await client.disconnect(); }
});

test('aborting a queued operation rejects promptly without removing the active operation listener', async () => {
  const hid = transport();
  const client = createClient({ hid });
  const gate = deferred(), started = deferred();
  const send = hid.raw.sendReport.bind(hid.raw);
  let calls = 0;
  hid.raw.sendReport = (...args) => {
    if (++calls !== 1) return send(...args);
    started.resolve();
    return gate.promise.then(() => send(...args));
  };
  await client.connect();
  const first = client.getCurrentSlot();
  try {
    await started.promise;
    const controller = new AbortController();
    const queued = client.writeConfig({ filters: [filter] }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(queued, hasCode('ABORTED'));
    assert.equal(calls, 1);
    assert.equal(hid.raw.inputReportListeners.size, 1);
    gate.resolve();
    assert.equal(await first, 7);
    assert.equal(await client.getCurrentSlot(), 7);
  } finally { gate.resolve(); await first.catch(() => {}); await client.disconnect(); }
});

test('operation timeouts include queue wait time', async () => {
  const hid = transport();
  const client = createClient({ hid });
  const gate = deferred(), started = deferred();
  const send = hid.raw.sendReport.bind(hid.raw);
  let calls = 0;
  hid.raw.sendReport = (...args) => {
    if (++calls !== 1) return send(...args);
    started.resolve();
    return gate.promise.then(() => send(...args));
  };
  await client.connect();
  const first = client.getCurrentSlot();
  try {
    await started.promise;
    await assert.rejects(client.readConfig({ timeoutMs: 20 }), error => error.code === 'TIMEOUT' && !error.details.mayHaveWritten);
    assert.equal(calls, 1);
    gate.resolve();
    await first;
  } finally { gate.resolve(); await first.catch(() => {}); await client.disconnect(); }
});

test('cancelling an in-flight send does not let the next operation overlap its native promise', async () => {
  const hid = transport();
  const client = createClient({ hid });
  const gate = deferred(), started = deferred();
  const controller = new AbortController();
  const send = hid.raw.sendReport.bind(hid.raw);
  let calls = 0;
  hid.raw.sendReport = (...args) => {
    if (++calls !== 1) return send(...args);
    started.resolve();
    return gate.promise.then(() => send(...args));
  };
  await client.connect();
  const reading = client.getCurrentSlot({ signal: controller.signal });
  try {
    await started.promise;
    controller.abort();
    await assert.rejects(reading, hasCode('ABORTED'));
    assert.equal(hid.raw.inputReportListeners.size, 0);
    const next = client.getCurrentSlot();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1, 'The native send is still outstanding');
    assert.equal(client.getDiagnostics().activeOperation.status, 'cancelled');
    gate.resolve();
    assert.equal(await next, 7);
    assert.equal(calls, 2);
  } finally { gate.resolve(); await reading.catch(() => {}); await client.disconnect(); }
});

test('active read deadlines remove report listeners and allow subsequent operations', async () => {
  const hid = transport();
  const client = createClient({ hid });
  const send = hid.raw.sendReport.bind(hid.raw);
  hid.raw.sendReport = async () => {};
  await client.connect();
  try {
    await assert.rejects(client.readConfig({ timeoutMs: 20 }), hasCode('TIMEOUT'));
    assert.equal(hid.raw.inputReportListeners.size, 0);
    assert.equal(client.connected, true);
    hid.raw.sendReport = send;
    assert.equal(await client.getCurrentSlot(), 7);
  } finally { await client.disconnect(); }
});

test('cancelling a native reopen holds the queue until open settles and never starts the cancelled write', async () => {
  const hid = transport();
  const client = createClient({ hid });
  const gate = deferred(), started = deferred();
  const controller = new AbortController();
  await client.connect();
  hid.raw.opened = false;
  hid.raw.open = async () => { started.resolve(); await gate.promise; hid.raw.opened = true; };
  const writing = client.writeConfig({ filters: [filter] }, { signal: controller.signal });
  try {
    await started.promise;
    controller.abort();
    await assert.rejects(writing, error => error.code === 'ABORTED' && !error.details.mayHaveWritten);
    const next = client.getCurrentSlot();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hid.raw.reports.length, 0);
    gate.resolve();
    assert.equal(await next, 7);
    assert.equal(hid.raw.reports.length, 1);
  } finally { gate.resolve(); await writing.catch(() => {}); await client.disconnect(); }
});

test('cancellation from a progress subscription is terminal for every observer', async () => {
  const hid = transport();
  const client = createClient({ hid });
  const controller = new AbortController();
  const events = [];
  client.subscribe(event => {
    if (event.type === 'progress' && event.phase === 'write' && event.completed === 1) controller.abort();
  });
  client.subscribe(event => { if (event.type === 'progress') events.push(event); });
  await client.connect();
  try {
    await assert.rejects(client.writeConfig({ filters: [filter] }, { signal: controller.signal }), hasCode('ABORTED'));
    assert.equal(events.at(-1).status, 'cancelled');
    assert.equal(events.filter(event => event.status === 'cancelled').length, 1);
    assert.equal(hid.raw.reports.length, 2);
  } finally { await client.disconnect(); }
});

test('each protocol stops after a cancelled band and does not send its final apply/commit', async () => {
  for (const [model, protocol, vendorId] of [
    ['MOONRIVER 3', 'moondrop', 0x35D8], ['DAWN PRO 2', 'walkplay', 0x35D8],
    ['CDSP', 'ktmicro', 0x31B2], ['Old Fashioned', 'legacy', 0x35D8], ['FreeDSP', 'conexant', 0x35D8]
  ]) {
    const hid = transport(model, { protocol, vendorId });
    const client = createClient({ hid });
    const controller = new AbortController();
    const events = [];
    await client.connect();
    try {
      await assert.rejects(client.writeConfig({ filters: [filter] }, { signal: controller.signal,
        onProgress(event) {
          events.push(event);
          if (event.phase === 'write' && event.completed === 1) controller.abort();
        } }), error => error.code === 'ABORTED' && error.details.mayHaveWritten && !error.details.writeCompleted, model);
      const committed = hid.raw.reports.some(({ bytes }) => protocol === 'ktmicro' || protocol === 'legacy'
        ? bytes[4] === 0x53 : protocol === 'conexant' ? bytes[5] === 90 : bytes[0] === 1 && bytes[1] === 1);
      assert.equal(committed, false, model);
      assert.equal(events.at(-1).status, 'cancelled', model);
      assert.equal(hid.raw.inputReportListeners.size, 0, model);
    } finally { await client.disconnect(); }
  }
});

test('WalkPlay filter collection clears its interval and listener when cancelled while waiting for a missing band', async () => {
  const hid = transport('DAWN PRO 2', { protocol: 'walkplay' });
  const client = createClient({ hid });
  const controller = new AbortController();
  const waiting = deferred();
  const send = hid.raw.sendReport.bind(hid.raw);
  hid.raw.sendReport = (id, bytes) => bytes[0] === 0x80 && bytes[1] === 0x09 && bytes[4] === 7
    ? Promise.resolve() : send(id, bytes);
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  let interval;
  const cleared = [];
  const setSpy = spyOn(globalThis, 'setInterval').mockImplementation((...args) => {
    interval = set(...args); waiting.resolve(); return interval;
  });
  const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation(id => { cleared.push(id); return clear(id); });
  await client.connect();
  const reading = client.readConfig({ signal: controller.signal });
  try {
    await waiting.promise;
    controller.abort();
    await assert.rejects(reading, hasCode('ABORTED'));
    assert.ok(cleared.includes(interval));
    assert.equal(hid.raw.inputReportListeners.size, 0);
  } finally {
    controller.abort(); setSpy.mockRestore(); clearSpy.mockRestore();
    await reading.catch(() => {}); await client.disconnect();
  }
});

test('readSetting supports cancellation and cleans up the shared response listener', async () => {
  const hid = transport('DAWN PRO 2', { protocol: 'walkplay' });
  const client = createClient({ hid });
  const controller = new AbortController(), started = deferred();
  const send = hid.raw.sendReport.bind(hid.raw);
  hid.raw.sendReport = async () => { started.resolve(); };
  await client.connect();
  const reading = client.readSetting('dacFilter', { signal: controller.signal });
  try {
    await started.promise;
    controller.abort();
    await assert.rejects(reading, hasCode('ABORTED'));
    assert.equal(hid.raw.inputReportListeners.size, 0);
    hid.raw.sendReport = send;
    assert.equal(await client.readSetting('dacFilter'), 'SLOW-LL');
  } finally { await client.disconnect(); }
});

test('progress is immutable, band-based and shared with subscriptions; observer failures are isolated', async () => {
  const hid = transport();
  const client = createClient({ hid });
  const events = [], direct = [];
  client.subscribe(event => { if (event.type === 'progress') events.push(event); });
  client.subscribe(() => { throw new Error('Broken observer'); });
  await client.connect();
  try {
    await client.writeConfig({ filters: [filter] }, { onProgress(event) {
      direct.push(event); throw new Error('Broken callback');
    } });
    assert.deepEqual(direct, events);
    assert.deepEqual(events.filter(event => event.phase === 'write').map(event => event.completed), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(new Set(events.map(event => event.operationId)).size, 1);
    assert.equal(events.at(-1).status, 'completed');
    assert.throws(() => { events[0].completed = 99; }, TypeError);
    assert.equal(client.getDiagnostics().pendingOperations, 0);
  } finally { await client.disconnect(); }
});

test('invalid operation controls and verification flags are rejected before HID traffic', async () => {
  const hid = transport();
  const client = createClient({ hid });
  await client.connect();
  try {
    for (const options of [null, { signal: {} }, { timeoutMs: 0 }, { timeoutMs: NaN }, { onProgress: true }]) {
      await assert.rejects(client.readConfig(options), hasCode('INVALID_CONFIG'));
    }
    await assert.rejects(client.writeConfig({ filters: [filter] }, { verify: 'yes' }), hasCode('INVALID_CONFIG'));
    assert.equal(hid.raw.reports.length, 0);
  } finally { await client.disconnect(); }
});
