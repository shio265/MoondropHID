import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { HidError, fail } from '../../src/utils/errors.js';
import { immutable } from '../../src/utils/object.js';
import { convertToByteArray, toHex } from '../../src/utils/bytes.js';
import { compensateFreqForWrite, decompensateFreqFromRead,
  compensateQForWrite, decompensateQFromRead } from '../../src/utils/compensation.js';

test('byte utilities preserve little-endian encoding and diagnostics', () => {
  assert.deepEqual(convertToByteArray(0x1234, 2), [0x34, 0x12]);
  assert.deepEqual(convertToByteArray(-3, 2), [0xFD, 0xFF]);
  assert.equal(toHex(new Uint8Array([0, 0x4B, 0xFF])), '00 4b ff');
  assert.equal(toHex(null), '');
});

test('immutable freezes nested metadata while retaining its identity', () => {
  const value = { slots: [{ id: 7 }], limits: { filterTypes: ['PK'] } };
  assert.equal(immutable(value), value);
  assert.equal(Object.isFrozen(value.slots[0]), true);
  assert.throws(() => { value.limits.filterTypes.push('HSQ'); }, TypeError);
  assert.equal(immutable(null), null);
  assert.equal(immutable(7), 7);
});

test('HID errors preserve codes, details and original causes', () => {
  const cause = new Error('Transport failure');
  const details = { field: 'globalGain' };
  const error = new HidError('INCOMPLETE_READ', 'Read failed', { cause, details });
  assert.equal(error.name, 'HidError');
  assert.equal(error.cause, cause);
  assert.equal(error.details, details);
  assert.throws(() => fail('INVALID_CONFIG', 'Invalid gain', details),
    result => result instanceof HidError && result.code === 'INVALID_CONFIG' && result.details === details);
});

test('shared compensation keeps frequency and Q write/read round trips stable', () => {
  const config = { qCompensation: { model: 'constant', ratio: 0.5 },
    freqCompensation: { model: 'ratio', factor: 2 }, minQ: 0.1, maxQ: 10 };
  const q = compensateQForWrite(1, -3, 'PK', config);
  const freq = compensateFreqForWrite(1000, config);
  assert.equal(q, 2);
  assert.equal(freq, 500);
  assert.equal(decompensateQFromRead(q, -3, 'PK', config), 1);
  assert.equal(decompensateFreqFromRead(freq, config), 1000);
  assert.equal(compensateQForWrite(1, -3, 'PK', {}), 1);
  assert.equal(compensateFreqForWrite(1000, {}), 1000);
});
