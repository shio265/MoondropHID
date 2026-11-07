// Browser-only smoke tests. All HID access is replaced with in-memory mocks.
import { usbHidDeviceHandlerConfig } from '../../src/config/registry.js';
import { handlerNameFor } from '../../src/handlers/index.js';
import { loadPeqConstraintsConfig, resolveConstraints } from '../../src/config/constraints.js';
import { fakeDevice } from '../helpers/device.js';
// Isolate connector state from any real connection in the page's main module.
import { UsbHIDConnector } from '../../src/hid/connection.js?mock-tests';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function runSmokeTests() {
  const passed = [];
  const check = (condition, message) => { assert(condition, message); passed.push(message); };
  const config = await loadPeqConstraintsConfig();
  const connector = await UsbHIDConnector;
  const originalHid = Object.getOwnPropertyDescriptor(navigator, 'hid');
  let selected = null;
  let chooserFilters = [];

  Object.defineProperty(navigator, 'hid', {
    configurable: true,
    value: {
      async requestDevice({ filters }) { chooserFilters = filters; return selected ? [selected] : []; },
      async getDevices() { return selected ? [selected] : []; }
    }
  });

  try {
    const entries = usbHidDeviceHandlerConfig.flatMap(vendor =>
      Object.entries(vendor.devices).map(([name, entry]) => ({ name, entry, vendor }))
    );
    check(entries.length === 21, 'Registry contains exactly 21 upstream Moondrop names');
    check(Object.keys(config.constraints).length === 7, 'Only seven required constraint profiles remain');
    const handlers = new Set();
    const profiles = new Set();

    for (const { name, entry, vendor } of entries) {
      assert(entry.manufacturer === 'Moondrop', `Non-Moondrop entry: ${name}`);
      selected = fakeDevice(name, vendor.vendorIds[0]);
      const connected = await connector.getDeviceConnected();
      assert(connected?.model === name && selected.opens === 1, `Failed to resolve ${name}`);
      const profile = connected.modelConfig.peqConstraintsRef;
      assert(config.constraints[profile], `Missing profile for ${name}`);
      assert(connected.modelConfig.maxFilters === config.constraints[profile].peqConstraints.maxFilters,
        `Incorrect band count for ${name}`);
      for (const method of ['pullFromDevice', 'pushToDevice', 'getCurrentSlot', 'enablePEQ']) {
        assert(typeof connected.handler[method] === 'function', `Missing ${method} for ${name}`);
      }
      assert(handlerNameFor(connected.handler), `Unidentified handler for ${name}`);
      handlers.add(connected.handlerName);
      profiles.add(profile);
      if (name === 'Old Fashioned') {
        assert(connected.handlerName === 'oldFashionedUsbHidHandler', 'Old Fashioned export mismatch');
      }
      if (name === 'DAWN PRO2') {
        assert(connected.handlerName === 'moondropUsbHidHandler', 'DAWN PRO2 handler changed');
      }
      if (name === 'DAWN PRO 2') {
        assert(connected.handlerName === 'walkplayUsbHID', 'DAWN PRO 2 handler changed');
      }
      if (name === 'Rays') {
        const c = resolveConstraints(connected.modelConfig);
        assert(!c.supportsLSFilter && !c.supportsHSFilter && c.deviceHandlesPregain, 'Rays overrides lost');
      }
      if (name === 'FreeDSP' || name === 'ECHO-B') {
        assert(resolveConstraints(connected.modelConfig).supportsRead === false, `${name} must remain write-only`);
      }
      if (name === 'CDSP' || name === 'Chu2 DSP') {
        assert(connected.modelConfig.compensate2X === false, `${name} frequency override lost`);
      }
      await connector.disconnectDevice();
    }
    check(handlers.size === 5 && profiles.size === 7, 'Every retained handler and profile is used');
    passed.push('All 21 models resolve with their handler, band count and selected overrides');

    for (const [name, vid] of [
      ['FIIO KA17', 0x35D8], ['TANCHJIM-SPACE PRO', 0x35D8],
      ['Kiwi Ears-Allegro PRO', 0x31B2], ['Unknown DAC', 0x35D8],
      ['__proto__', 0x35D8], ['constructor', 0x35D8], ['MOONRIVER 3', 0xFFFF]
    ]) {
      selected = fakeDevice(name, vid);
      const result = await connector.getDeviceConnected();
      assert(result?.unsupported === true && selected.opens === 0 && selected.reports.length === 0,
        `Device outside registry was opened: ${name}`);
    }
    check(chooserFilters.length > 0, 'Chooser filters are populated');
    passed.push('Other brands, unknown names and unknown VIDs are rejected before opening HID');
    selected = null;
    check((await connector.getDeviceConnected())?.cancelled === true, 'Cancelling the chooser is handled');

    selected = fakeDevice('MOONRIVER 3');
    const moondrop = await connector.getDeviceConnected();
    check(await connector.getCurrentSlot(moondrop) === 7, 'Moondrop active slot decodes correctly');
    const pulled = await connector.pullFromDevice(moondrop, 7);
    check(pulled.filters.length === 8 && pulled.filters[0].freq === 1000 &&
      pulled.filters[0].q === 1 && pulled.filters[0].gain === -3 && pulled.globalGain === -2,
    'Moondrop read decodes frequency, Q, signed gain and pregain');
    selected.reports = [];
    await connector.pushToDevice(moondrop, null, 7, 0, [{ type: 'PK', freq: 1000, q: 1, gain: -3 }]);
    const nativeWrites = selected.reports;
    check(nativeWrites.length === 17 && nativeWrites[0].reportId === 0x4B &&
      nativeWrites[0].bytes.length === 63 && nativeWrites[1].bytes[1] === 0x0A &&
      JSON.stringify(nativeWrites.at(-1).bytes) === '[1,1]',
    'Moondrop push pads eight bands, applies each band and sends the save command');
    await connector.disconnectDevice();

    selected = fakeDevice('DAWN PRO 2', 0x35D8, 'walkplay');
    const walkplay = await connector.getDeviceConnected();
    check(await connector.getCurrentSlot(walkplay) === 101, 'WalkPlay version/slot reads work');
    const walkplayPull = await connector.pullFromDevice(walkplay, 101);
    check(walkplayPull.complete && walkplayPull.filters.length === 8 &&
      walkplayPull.filters[0].gain === -3 && walkplayPull.globalGain === -2,
    'WalkPlay pull collects eight bands and reads signed global gain');
    selected.reports = [];
    await connector.pushToDevice(walkplay, null, 101, -2, [{ type: 'PK', freq: 1000, q: 1, gain: -3 }]);
    check(selected.reports[0].bytes[35] === 101 &&
      JSON.stringify(selected.reports.slice(-4).map(r => r.bytes)) ===
        '[[1,5,0],[1,23,0],[1,10,4,0,0,255,255,0],[1,1,1,0]]',
    'WalkPlay push preserves the selected preset and its distinct commit sequence');
    await connector.disconnectDevice();

    selected = fakeDevice('CDSP', 0x31B2, 'ktmicro');
    const ktmicro = await connector.getDeviceConnected();
    const ktPull = await connector.pullFromDevice(ktmicro, 3);
    check(ktPull.filters.length === 5 && ktPull.filters[0].freq === 1000 &&
      ktPull.filters[0].q === 1 && ktPull.filters[0].gain === -3 && ktPull.globalGain === -2 &&
      selected.reports.every(r => r.reportId === 0x4B && r.bytes.length === 10),
    'CDSP reads five bands using KT Micro register packets');

    return { ok: true, passed, realUsbAccess: false };
  } finally {
    await connector.disconnectDevice();
    if (originalHid) Object.defineProperty(navigator, 'hid', originalHid);
    else delete navigator.hid;
  }
}
