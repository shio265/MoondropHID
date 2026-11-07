import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '../../src/index.js';
import { transport } from '../helpers/transport.js';
import { memoryTransport } from '../helpers/memory.js';

test('the shared README example connects, reads, writes and disconnects using the public entry', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const code = [...readme.matchAll(/```js\r?\n([\s\S]*?)\r?\n```/g)]
    .map(match => match[1]).find(block => block.includes('const dac = createClient();'));
  assert.ok(code, 'README must contain the shared client example');
  const hid = transport();
  const originalHid = Object.getOwnPropertyDescriptor(navigator, 'hid');
  Object.defineProperty(navigator, 'hid', { configurable: true, value: hid });
  const buttons = { '#connect': {}, '#save': {}, '#disconnect': {} };
  const output = [];
  let client;
  try {
    const run = new Function('createClient', 'document', 'console', code + '\nreturn dac;');
    client = run(createClient, { querySelector(selector) {
      assert.ok(Object.hasOwn(buttons, selector), `Unexpected button: ${selector}`);
      return buttons[selector];
    } }, { log(...args) { output.push(args); }, error(error) { throw error; } });
    assert.equal(hid.requests, 0, 'Loading the example must not prompt for USB access');
    const connecting = buttons['#connect'].onclick();
    assert.equal(hid.requests, 1, 'The click handler must reach the chooser synchronously');
    await connecting;
    assert.equal(output[0][1], 'MOONRIVER 3');
    assert.equal(output[1][0].filters.length, 8);
    await buttons['#save'].onclick();
    assert.equal(output[2][0].verified, false);
    assert.equal(hid.raw.reports.length, 27);
    await buttons['#disconnect'].onclick();
    assert.equal(client.connected, false);
    assert.equal(hid.raw.opened, false);
    assert.equal(hid.raw.inputReportListeners.size, 0);
  } finally {
    if (client?.connected) await client.disconnect();
    if (originalHid) Object.defineProperty(navigator, 'hid', originalHid);
    else delete navigator.hid;
  }
});

test('the optional README example verifies writes and supports its cancel button', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const code = [...readme.matchAll(/```js\r?\n([\s\S]*?)\r?\n```/g)]
    .map(match => match[1]).find(block => block.includes('const controller = new AbortController();'));
  assert.ok(code, 'README must document verification and operation controls');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('dac', 'config', 'cancelButton', 'console', code + '\nreturn result;');
  const hid = memoryTransport();
  const client = createClient({ hid });
  const config = { filters: [{ type: 'PK', freq: 1000, gain: -3, q: 1 }], globalGain: 0 };
  const cancelButton = {};
  const output = [];
  await client.connect();
  try {
    const result = await run(client, config, cancelButton, { log(...args) { output.push(args); } });
    assert.equal(result.verified, true);
    assert.deepEqual(output.at(-1), [true, 'verified']);
    assert.ok(output.some(([phase, completed]) => phase === 'verify' && completed === 8));
    await assert.rejects(run(client, config, cancelButton, { log(phase, completed) {
      if (phase === 'write' && completed === 1) cancelButton.onclick();
    } }), error => error.code === 'ABORTED');
  } finally { await client.disconnect(); }
});
