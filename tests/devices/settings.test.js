import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { buildExtras } from '../../src/devices/settings.js';
import { prepareFilters } from '../../src/devices/filters.js';

test('setting wrappers stay bound to their own device', async () => {
  const handler = {
    async readMicGain(device) { return device.gain; },
    async setMicGain(device, gain) { device.gain = gain; },
    async setOutputGain(device, gain) { device.output = gain; }
  };
  const modelConfig = { peqConstraintsRef: 'walkplayPeq8Band10dBFullShelves' };
  const first = { modelConfig, gain: 3 };
  const second = { modelConfig, gain: -2 };
  const a = buildExtras(handler, first);
  const b = buildExtras(handler, second);
  assert.equal(await a.micGain.get(), 3);
  await a.micGain.set(4);
  assert.equal(await b.micGain.get(), -2);
  assert.equal(a.outputGain.supported, true);
  await a.outputGain.set(-3);
  assert.equal(first.output, -3);
  assert.equal(second.output, undefined);
});

test('disabled settings and missing handler methods reject instead of issuing calls', async () => {
  const extras = buildExtras({}, { modelConfig: {
    peqConstraintsRef: 'walkplayPeq8Band10dBFullShelves', micGain: { supported: false }
  } });
  assert.equal(extras.micGain.supported, false);
  await assert.rejects(extras.micGain.get(), error => error.code === 'NOT_IMPLEMENTED');
  await assert.rejects(extras.dacFilter.set('FAST-LL'), error => error.code === 'NOT_IMPLEMENTED');
  assert.equal(extras.outputGain.supported, false);
  await assert.rejects(extras.outputGain.set(0), error => error.code === 'NOT_IMPLEMENTED');
});

test('device filter preparation preserves fallbacks and pads the custom bank', () => {
  const input = [{ type: 'LSQ', freq: 120, gain: 6, q: 0.7 }];
  const original = structuredClone(input);
  const warnings = [];
  const modelConfig = { maxFilters: 2, supportsLSFilter: false, supportsHSFilter: true,
    deviceHandlesPregain: true, defaultResetFiltersValues: [{ gain: 0, freq: 100, q: 1, filterType: 'PK' }] };
  const output = prepareFilters(input, modelConfig, -3, {
    logger: { log() {}, warn(message) { warnings.push(message); } }
  });
  assert.deepEqual(output[0], { ...input[0], type: 'PK', gain: 0 });
  assert.deepEqual(output[1], modelConfig.defaultResetFiltersValues[0]);
  assert.notEqual(output[1], modelConfig.defaultResetFiltersValues[0]);
  assert.deepEqual(input, original);
  assert.equal(warnings.length, 1);
});
