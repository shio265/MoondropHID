import { test, spyOn } from 'bun:test';
import assert from 'node:assert/strict';
import { runSmokeTests } from './smoke.js';
import { runContractTests } from './contract.js';

async function quietly(action) {
  const spies = ['log', 'warn', 'error'].map(name => spyOn(console, name).mockImplementation(() => {}));
  try { return await action(); }
  finally { for (const spy of spies) spy.mockRestore(); }
}

test('original 14 smoke checks still pass', async () => {
  const result = await quietly(runSmokeTests);
  assert.equal(result.ok, true);
  assert.equal(result.passed.length, 14);
});

test('21 model definitions and 202 original wire reports remain unchanged', async () => {
  const result = await quietly(runContractTests);
  assert.equal(result.models, 21);
  assert.equal(result.reports, 202);
});
