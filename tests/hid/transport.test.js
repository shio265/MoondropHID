import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { requestReport } from '../../src/hid/transport.js';
import { fakeDevice } from '../helpers/device.js';

function reply(device, data, reportId = 0x99) {
  const event = new Event('inputreport');
  Object.defineProperties(event, { data: { value: data }, reportId: { value: reportId } });
  device.dispatchEvent(event);
}

test('requestReport registers before sending and matches bounded payloads, not report IDs', async () => {
  const device = fakeDevice('MOONRIVER 3');
  device.sendReport = () => {
    assert.equal(device.inputReportListeners.size, 1);
    reply(device, new DataView(new Uint8Array([0x80, 0x09, 1]).buffer));
    const buffer = new Uint8Array([0xAA, 0xAA, 0x80, 0x0F, 7, 0xBB]);
    reply(device, new DataView(buffer.buffer, 2, 3));
  };
  const result = await requestReport(device, 0x4B, new Uint8Array([0x80, 0x0F]),
    data => data[0] === 0x80 && data[1] === 0x0F, 'test');
  assert.deepEqual([...result], [0x80, 0x0F, 7]);
  assert.equal(device.inputReportListeners.size, 0);
});

test('requestReport ignores unrelated replies and removes listeners on timeout', async () => {
  const device = fakeDevice('MOONRIVER 3');
  device.sendReport = async () => reply(device, new DataView(new Uint8Array([0, 0, 0]).buffer));
  await assert.rejects(requestReport(device, 0x4B, new Uint8Array([0x80, 0x0F]),
    data => data[0] === 0x80, 'test', 20), /Timeout waiting for HID response/);
  assert.equal(device.inputReportListeners.size, 0);
});

test('requestReport retains synchronous and asynchronous send errors without leaking listeners', async () => {
  for (const asynchronous of [false, true]) {
    const device = fakeDevice('MOONRIVER 3');
    const cause = new Error('Send failed');
    device.sendReport = asynchronous ? () => Promise.reject(cause) : () => { throw cause; };
    await assert.rejects(requestReport(device, 0x4B, new Uint8Array([0x80, 0x0F]),
      () => true, 'test'), error => error === cause);
    assert.equal(device.inputReportListeners.size, 0);
  }
});
