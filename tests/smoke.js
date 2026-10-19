// Browser-only smoke tests. All HID access is replaced with in-memory mocks.
import { usbHidDeviceHandlerConfig, handlerNameFor,
  loadPeqConstraintsConfig, resolveConstraints } from '../src/internal/config.js';
// Isolate connector state from any real connection in the page's main module.
import { UsbHIDConnector } from '../src/internal/connection.js?mock-tests';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function fakeDevice(productName, vendorId = 0x35D8, protocol = 'moondrop') {
  const device = new EventTarget();
  const inputReportListeners = new Set();
  const addListener = device.addEventListener.bind(device);
  const removeListener = device.removeEventListener.bind(device);
  device.addEventListener = (type, callback, options) => {
    if (type === 'inputreport') inputReportListeners.add(callback);
    addListener(type, callback, options);
  };
  device.removeEventListener = (type, callback, options) => {
    if (type === 'inputreport') inputReportListeners.delete(callback);
    removeListener(type, callback, options);
  };
  Object.assign(device, {
    inputReportListeners,
    productName,
    vendorId,
    productId: 0x1234,
    collections: [{ usagePage: 0xFF00 }],
    opened: false,
    opens: 0,
    reports: [],
    async open() { this.opened = true; this.opens++; },
    async close() { this.opened = false; },
    async sendReport(reportId, payload) {
      const request = new Uint8Array(payload);
      this.reports.push({ reportId, bytes: [...request] });
      const data = new Uint8Array(63);
      const view = new DataView(data.buffer);

      if (protocol === 'ktmicro' || protocol === 'legacy') {
        if (request[4] !== 0x52 && !(request[4] === 0x57 && request[0] === 0x24)) return;
        data.set(request);
        const reg = request[0];
        if (reg === 0x24) data[6] = 3;
        else if (reg === 0x66) data[6] = 0xFE;
        else if ((reg - 0x26) % 2 === 0) {
          view.setInt16(6, -30, true);
          if (protocol === 'legacy') view.setInt8(6, -30);
          view.setUint16(8, 1000 + ((reg - 0x26) / 2) * 100, true);
        } else {
          view.setUint16(6, 1000, true);
          data[8] = 0;
        }
      } else {
        if (request[0] !== 0x80) return;
        data[0] = 0x80;
        data[1] = request[1];
        if (request[1] === 0x09) {
          const index = request[4] ?? 0;
          data[4] = index;
          view.setUint16(27, 1000 + index * 100, true);
          view.setUint16(29, 256, true);
          view.setInt16(31, -3 * 256, true);
          data[33] = 2;
          data[35] = 101;
        } else if (request[1] === 0x03) {
          if (protocol === 'walkplay') data[4] = 0xFE;
          else view.setInt16(3, -2 * 256, true);
        } else if (request[1] === 0x0C) {
          data.set([49, 46, 48], 3);
        } else if (request[1] === 0x0F) {
          data[3] = 7;
        } else if (request[1] === 0x11) {
          data[3] = 3;
        } else if (request[1] === 0x02) {
          view.setInt16(2, 0, true);
        } else if (request[1] === 0x1D || request[1] === 0x19 || request[1] === 0x1B) {
          data[3] = 0;
        } else {
          throw new Error(`Unexpected mock read command ${request[1]}`);
        }
      }

      const event = new Event('inputreport');
      Object.defineProperties(event, {
        data: { value: new DataView(data.buffer) },
        reportId: { value: reportId }
      });
      this.dispatchEvent(event);
    }
  });
  return device;
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
