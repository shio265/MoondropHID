// Byte-level regression tests. The fixture hash was captured before consolidation.
import { fakeDevice } from './smoke.js';

const EXPECTED_HASH = '68b890b31778c3918f183cebabc8b42fd98a47b42eff9e201eb3e7d5d48c1f9e';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export async function hashContract(contract) {
  const data = new TextEncoder().encode(JSON.stringify(canonical(contract)));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function captureContract({
  connectorPath = '../src/internal/connection.js?contract-tests',
  registryPath = '../src/internal/config.js',
  constraintsPath = registryPath,
  constraintsDataPath
} = {}) {
  const registry = await import(new URL(registryPath, import.meta.url));
  const constraints = await import(new URL(constraintsPath, import.meta.url));
  const { UsbHIDConnector } = await import(new URL(connectorPath, import.meta.url));
  const connector = await UsbHIDConnector;
  const config = await constraints.loadPeqConstraintsConfig(
    constraintsDataPath ? new URL(constraintsDataPath, import.meta.url).href : undefined
  );
  const originalHid = Object.getOwnPropertyDescriptor(navigator, 'hid');
  let selected;
  Object.defineProperty(navigator, 'hid', {
    configurable: true,
    value: {
      async requestDevice() { return [selected]; },
      async getDevices() { return [selected]; }
    }
  });

  try {
    const models = [];
    for (const vendor of registry.usbHidDeviceHandlerConfig) {
      for (const name of Object.keys(vendor.devices)) {
        selected = fakeDevice(name, vendor.vendorIds[0]);
        const device = await connector.getDeviceConnected();
        if (!device?.rawDevice) throw new Error(`Failed to connect mock ${name}`);
        models.push({ name, manufacturer: device.manufacturer, config: device.modelConfig });
        await connector.disconnectDevice();
      }
    }

    const cases = [];
    for (const [name, vid, protocol] of [
      ['MOONRIVER 3', 0x35D8, 'moondrop'],
      ['FreeDSP Mini', 0x35D8, 'moondrop'],
      ['Rays', 0x35D8, 'moondrop'],
      ['DAWN PRO 2', 0x35D8, 'walkplay'],
      ['CDSP', 0x31B2, 'ktmicro'],
      ['Old Fashioned', 0x35D8, 'legacy'],
      ['FreeDSP', 0x35D8, 'conexant']
    ]) {
      selected = fakeDevice(name, vid, protocol);
      const device = await connector.getDeviceConnected();
      const slot = await connector.getCurrentSlot(device);
      const pulled = await connector.pullFromDevice(device, slot);
      await connector.pushToDevice(device, null, slot, -2, [
        { type: 'PK', freq: 1000, gain: -3, q: 1 },
        { type: 'LSQ', freq: 120, gain: 6, q: 0.7 },
        { type: 'HSQ', freq: 8000, gain: -4, q: 1 },
        { type: 'PK', freq: 2500, gain: 0, q: 1, disabled: true }
      ]);
      await connector.enablePEQ(device, false, -1);
      await connector.enablePEQ(device, true, slot);
      cases.push({ name, slot, pulled, reports: selected.reports });
      await connector.disconnectDevice();
    }

    return { config, models, cases };
  } finally {
    await connector.disconnectDevice();
    if (originalHid) Object.defineProperty(navigator, 'hid', originalHid);
    else delete navigator.hid;
  }
}

export async function runContractTests() {
  const contract = await captureContract();
  const hash = await hashContract(contract);
  if (hash !== EXPECTED_HASH) {
    throw new Error(`USB contract changed: expected ${EXPECTED_HASH}, got ${hash}`);
  }
  return {
    ok: true,
    models: contract.models.length,
    cases: contract.cases.length,
    reports: contract.cases.reduce((count, item) => count + item.reports.length, 0),
    realUsbAccess: false
  };
}
