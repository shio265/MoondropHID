// Moondrop HID by shio265.
// Consolidated USB protocols. Each implementation keeps its own packet format,
// numeric encoding, response matching and commit sequence.
import {
  compensateFreqForWrite, decompensateFreqFromRead,
  compensateQForWrite, decompensateQFromRead
} from './dsp.js';

let debugLogger = null;

export function setDebugLogger(logger) {
  if (logger !== null && typeof logger !== 'function') throw new TypeError('Logger must be a function or null.');
  debugLogger = logger;
}

function debugLog(...values) {
  try { debugLogger?.(...values); } catch (_) { /* Logging must not interrupt USB I/O. */ }
}

function toHex(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data?.buffer ?? data ?? []);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function logHidTx(handlerName, reportId, data) {
  if (debugLogger) return debugLog(`USB Device PEQ: [${handlerName}] TX reportId=${reportId} bytes=[${toHex(data)}]`);
}

function logHidRx(handlerName, data) {
  if (debugLogger) return debugLog(`USB Device PEQ: [${handlerName}] RX bytes=[${toHex(data)}]`);
}

// Register before sending, and clean up on response, timeout or transport error.
// Copy only the DataView slice; browser report buffers need not start at offset 0.
function requestReport(device, reportId, packet, matches, handlerName, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      device.removeEventListener('inputreport', onReport);
    };
    const fail = error => { cleanup(); reject(error); };
    const onReport = event => {
      // Match the response payload; some firmware uses a different input report ID.
      const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength).slice();
      logHidRx(handlerName, data);
      if (!matches(data)) return;
      cleanup();
      resolve(data);
    };
    const timer = setTimeout(() => fail(new Error('Timeout waiting for HID response.')), timeout);
    device.addEventListener('inputreport', onReport);
    try {
      logHidTx(handlerName, reportId, packet);
      Promise.resolve(device.sendReport(reportId, packet)).catch(fail);
    } catch (error) { fail(error); }
  });
}

// Native PEQ protocol: Marigold, Rays, MOONRIVER 3, FreeDSP Pro/Mini, DAWN PRO2.
const nativeProtocol = (function () {
  // Retain upstream diagnostic calls, but make verbose output opt-in for SDK users.
  const console = { log: debugLog, warn: (...values) => globalThis.console.warn(...values) };
  const FILTER_COUNT = 8;
  const REPORT_ID = 0x4b;
  const COMMAND_WRITE = 1;
  const COMMAND_READ = 128;
  const COMMAND_UPDATE_EQ = 9;
  const COMMAND_UPDATE_EQ_COEFF_TO_REG = 10;
  const COMMAND_SAVE_EQ_TO_FLASH = 1;
  const COMMAND_SAVE_OFFSET_TO_FLASH = 4;
  const COMMAND_SET_DAC_OFFSET = 3;
  const COMMAND_CLEAR_FLASH = 0x05;
  const COMMAND_CHANNEL_BALANCE = 0x16;
  const COMMAND_DAC_GAIN = 0x19;
  const COMMAND_DAC_MODE = 0x1D;
  const COMMAND_PRE_GAIN = 0x23;
  const COMMAND_LED_SWITCH = 0x18;
  const COMMAND_DAC_FILTER = 0x11;
  const COMMAND_VER = 0x0C;
  const COMMAND_RESET_EQ = 0x05;
  const COMMAND_RESET_FLASH = 0x17;
  const COMMAND_UPGRADE = 0xFF;
  const COMMAND_ACTIVE_EQ = 15;

  function buildReadPacket(filterIndex) {
    return new Uint8Array([COMMAND_READ, COMMAND_UPDATE_EQ, 0x18, 0x00, filterIndex, 0x00]);
  }

  function decodeFilterResponse(data) {
    const e = new Int8Array(data.buffer);

    const rawFreq = (e[27] & 0xff) | ((e[28] & 0xff) << 8);
    const freq = rawFreq;

    const q = ((e[30] << 8) | (e[29] & 255)) / 256;  // 16-bit fixed-point
    const gain = ((e[32] << 8) | (e[31] & 255)) / 256;
    const filterType = convertToFilterType(e[33]);
    const valid = freq > 10 && freq < 24000 && !isNaN(gain) && !isNaN(q);

    return {
      type: filterType,
      freq: valid ? freq : 0,
      q: valid ? q : 1.0,
      gain: valid ? gain : 0.0,
      disabled: !valid
    };
  }

  function convertToFilterType(byte) {
    switch (byte) {
      case 1: return "LSQ"; // Low Shelf (if seen in future captures)
      case 2: return "PK"; // Peaking
      case 3: return "HSQ"; // High Shelf (future-proof)
      default: return "PK";
    }
  }

  async function getCurrentSlot(deviceDetails) {
    const device = deviceDetails.rawDevice;
    const request = new Uint8Array([0x80, 0x0F, 0x00]); // READ, SET_ACTIVE_EQ, bLength = 0
    const data = await requestReport(device, REPORT_ID, request,
      data => data.length >= 4 && data[0] === 0x80 && data[1] === 0x0F, 'Moondrop');
    return data[3];
  }

  async function readFullFilter(device, filterIndex) {
    const packet = buildReadPacket(filterIndex);
    const data = await requestReport(device, REPORT_ID, packet,
      data => data.length >= 34 && data[0] === COMMAND_READ && data[1] === COMMAND_UPDATE_EQ && data[4] === filterIndex, 'Moondrop');
    return decodeFilterResponse(data);
  }

  async function readPregain(device) {
    const data = await requestReport(device, REPORT_ID,
      new Uint8Array([COMMAND_READ, COMMAND_SET_DAC_OFFSET]),
      data => data.length >= 5 && data[0] === COMMAND_READ && data[1] === COMMAND_SET_DAC_OFFSET, 'Moondrop');
    const r = new Int8Array(data.buffer);
    return (r[4] << 8 | r[3] & 255) / 256;
  }

  async function writePregain(device, value) {
    const val = Math.round(value * 256);
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_PRE_GAIN, 0, val & 255, (val >> 8) & 255]);
    console.log(`USB Device PEQ: Moondrop sending writePregain command:`, request);
    logHidTx('Moondrop', REPORT_ID, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function pullFromDevice(deviceDetails) {
    const device = deviceDetails.rawDevice;
    const filters = [];

    for (let i = 0; i < deviceDetails.modelConfig.maxFilters; i++) {
      const filter = await readFullFilter(device, i);
      filters.push(filter);
    }

    let globalGain = 0;
    let globalGainError;
    try {
      globalGain = await readPregain(device);
    } catch (e) {
      globalGainError = e;
      console.warn("USB Device PEQ: Moondrop failed to read pregain, defaulting to 0:", e);
    }

    const result = {
      filters,
      globalGain
    };
    if (globalGainError) Object.defineProperty(result, 'globalGainError', { value: globalGainError });
    return result;
  }

  function toLittleEndianBytes(value, scale = 1) {
    const v = Math.round(value * scale);
    return [v & 0xff, (v >> 8) & 0xff];
  }

  function toSignedLittleEndianBytes(value, scale = 1) {
    let v = Math.round(value * scale);
    if (v < 0) v += 0x10000;
    return [v & 0xff, (v >> 8) & 0xff];
  }

  // type defaults to 'PK' for back-compat with any caller still passing 3 args.
  // LSQ/HSQ previously fell through to this same peaking formula regardless
  // of type — that was a bug: shelf filters need their own coefficients, not
  // a peaking filter tagged with a shelf type byte. See walkplayHidHandler.js's
  // computeIIRFilter() for the full writeup of the shelf-alpha fix applied here
  // (verified against a real WebAudio BiquadFilterNode on real device captures).
  function encodeBiquad(freq, gain, q, type = 'PK') {
    const A = Math.pow(10, gain / 40);
    const w0 = (2 * Math.PI * freq) / 96000;
    const sinW0 = Math.sin(w0);
    const cosW0 = Math.cos(w0);
    const alpha = sinW0 / (2 * q); // peaking-EQ alpha — correct for PK, NOT for LSQ/HSQ

    let a0, a1, a2, b0, b1, b2;

    if (type === 'LSQ' || type === 'HSQ') {
      const shelfAlpha = (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
      const s = 2 * Math.sqrt(A) * shelfAlpha;
      if (type === 'LSQ') {
        b0 =    A * ((A + 1) - (A - 1) * cosW0 + s);
        b1 =  2*A * ((A - 1) - (A + 1) * cosW0);
        b2 =    A * ((A + 1) - (A - 1) * cosW0 - s);
        a0 =         (A + 1) + (A - 1) * cosW0 + s;
        a1 =    -2 * ((A - 1) + (A + 1) * cosW0);
        a2 =         (A + 1) + (A - 1) * cosW0 - s;
      } else { // HSQ
        b0 =     A * ((A + 1) + (A - 1) * cosW0 + s);
        b1 =  -2*A * ((A - 1) + (A + 1) * cosW0);
        b2 =     A * ((A + 1) + (A - 1) * cosW0 - s);
        a0 =          (A + 1) - (A - 1) * cosW0 + s;
        a1 =      2 * ((A - 1) - (A + 1) * cosW0);
        a2 =          (A + 1) - (A - 1) * cosW0 - s;
      }
    } else { // PK (default) — original formula, unchanged
      b0 = 1 + alpha * A;
      b1 = -2 * cosW0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosW0;
      a2 = 1 - alpha / A;
    }

    const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0, na1 = a1 / a0, na2 = a2 / a0;
    return [nb0, nb1, nb2, -na1, -na2].map(c => Math.round(c * 1073741824));
  }

  // Alternate coefficient formula seen in a different vendor's reversed web tool (used there
  // for a Savitech-chipset device, see savitechUsbHidHandler.js). Same peaking-EQ shape but
  // A = 10^(gain/20) instead of 10^(gain/40). NOT wired up anywhere yet - modelConfig.biquadFormula
  // must be explicitly set to "savitechStyle" to opt in, and nothing does that today. Exists so
  // it can be A/B tested against the default formula above without touching working devices.
  // NOTE: peaking-only, same as encodeBiquad() was before its LSQ/HSQ fix above — if this is
  // ever wired up for a device that also uses shelf filters, it needs the same fix, but nothing
  // does today so it's untouched (no real capture data exists to verify a shelf fix against this
  // formula's different A=10^(gain/20) convention).
  function encodeBiquadSavitechStyle(freq, gain, q) {
    const A = Math.pow(10, gain / 20);
    const w0 = (2 * Math.PI * freq) / 96000;
    const alpha = Math.sin(w0) / (2 * q);
    const sqrtA = Math.sqrt(A);
    const alphaA = alpha * sqrtA;
    const alphaOverA = alpha / sqrtA;
    const norm = 1 / (alphaOverA + 1);
    const cosW0 = Math.cos(w0);

    const b0 = (1 + alphaA) * norm;
    const b1 = -2 * cosW0 * norm;
    const b2 = (1 - alphaA) * norm;
    const a1 = 2 * cosW0 * norm;
    const a2 = -(1 - alphaOverA) * norm;

    return [b0, b1, b2, a1, a2].map(c => Math.round(c * 1073741824));
  }

  function encodeBiquadForModel(freq, gain, q, type, modelConfig) {
    return modelConfig?.biquadFormula === "savitechStyle"
      ? encodeBiquadSavitechStyle(freq, gain, q)
      : encodeBiquad(freq, gain, q, type);
  }

  function encodeToByteArray(coeffs) {
    const arr = new Uint8Array(20);
    for (let i = 0; i < coeffs.length; i++) {
      const val = coeffs[i];
      arr[i * 4] = val & 0xff;
      arr[i * 4 + 1] = (val >> 8) & 0xff;
      arr[i * 4 + 2] = (val >> 16) & 0xff;
      arr[i * 4 + 3] = (val >> 24) & 0xff;
    }
    return arr;
  }

  function buildWritePacket(filterIndex, { freq, gain, q, type }, modelConfig) {
    const packet = new Uint8Array(63);
    packet[0] = COMMAND_WRITE;
    packet[1] = COMMAND_UPDATE_EQ;
    packet[2] = 0x18; // bLength
    packet[3] = 0x00;
    packet[4] = filterIndex;
    packet[5] = 0x00;
    packet[6] = 0x00;

    const coeffs = encodeToByteArray(encodeBiquadForModel(freq, gain, q, type, modelConfig));
    packet.set(coeffs, 7);

    packet[27] = freq & 0xff;
    packet[28] = (freq >> 8) & 0xff;
    const qVal = Math.round(q * 256);
    packet[29] = qVal & 255;
    packet[30] = (qVal >> 8) & 255;

    const gainVal = Math.round(gain * 256);
    packet[31] = gainVal & 255;
    packet[32] = (gainVal >> 8) & 255;
    packet[33] = convertFromFilterType(type); // 2 by default
    packet[34] = 0;
    packet[35] = 7; // peqIndex

    return packet;
  }

  function convertFromFilterType(filterType) {
    const mapping = {"PK": 2, "LSQ": 1, "HSQ": 3};
    return mapping[filterType] !== undefined ? mapping[filterType] : 2;
  }

  function buildEnablePacket(filterIndex) {
    const packet = new Uint8Array(63);
    packet[0] = COMMAND_WRITE;
    packet[1] = COMMAND_UPDATE_EQ_COEFF_TO_REG;
    packet[2] = filterIndex;
    packet[3] = 0;
    packet[4] = 255;
    packet[5] = 255;
    packet[6] = 255;
    return packet;
  }

  function buildSavePacket() {
    return new Uint8Array([COMMAND_WRITE, COMMAND_SAVE_EQ_TO_FLASH]);
  }

  async function pushToDevice(deviceDetails, phoneObj, slot, globalGain, filters) {
    const device = deviceDetails.rawDevice;

    for (let i = 0; i < filters.length && i < deviceDetails.modelConfig.maxFilters; i++) {
      const writeFilter = buildWritePacket(i, filters[i], deviceDetails.modelConfig);
      console.log(`USB Device PEQ: Moondrop sending filter ${i} data:`, filters[i], writeFilter);
      logHidTx('Moondrop', REPORT_ID, writeFilter);
      await device.sendReport(REPORT_ID, writeFilter);

      const enable = buildEnablePacket(i);
      console.log(`USB Device PEQ: Moondrop sending enable command for filter ${i}:`, enable);
      logHidTx('Moondrop', REPORT_ID, enable);
      await device.sendReport(REPORT_ID, enable);
    }

    // Moondrop devices with supportGlobalGain:true (all except Old Fashioned) automatically
    // compute gain headroom from the written biquad coefficients. Writing an explicit pregain
    // on top of that causes double gain reduction. Only write pregain when deviceHandlesPregain
    // is explicitly false (meaning the host must manage it).
    if (deviceDetails.modelConfig.deviceHandlesPregain === false) {
      await writePregain(device, globalGain);
      console.log(`USB Device PEQ: Moondrop set pregain to ${globalGain}`);
    }

    const save = buildSavePacket();
    console.log(`USB Device PEQ: Moondrop sending save command:`, save);
    logHidTx('Moondrop', REPORT_ID, save);
    await device.sendReport(REPORT_ID, save);

    console.log(`USB Device PEQ: Moondrop successfully pushed ${filters.length} filters to device`);
    return false;
  }

  async function readVer(device) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([COMMAND_READ, COMMAND_VER]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading version");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        logHidRx('Moondrop', data);
        console.log(`USB Device PEQ: Moondrop onInputReport received version data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_VER) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const version = `${data[3]}.${data[4]}.${data[5]}`;
        console.log(`USB Device PEQ: Moondrop version: ${version}`);
        resolve(version);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readVer command:`, request);
      logHidTx('Moondrop', REPORT_ID, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function readChannelBalance(device, lr) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([COMMAND_READ, COMMAND_CHANNEL_BALANCE, 0, lr]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading channel balance");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        logHidRx('Moondrop', data);
        console.log(`USB Device PEQ: Moondrop onInputReport received channel balance data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_CHANNEL_BALANCE) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const balance = data[5];
        console.log(`USB Device PEQ: Moondrop channel balance value: ${balance}`);
        resolve(balance);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readChannelBalance command:`, request);
      logHidTx('Moondrop', REPORT_ID, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function writeChannelBalance(device, lr, db) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_CHANNEL_BALANCE, 0, lr, 0, db, 0]);
    console.log(`USB Device PEQ: Moondrop sending writeChannelBalance command:`, request);
    logHidTx('Moondrop', REPORT_ID, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function readDACGain(device) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([COMMAND_READ, COMMAND_DAC_GAIN, 0]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading DAC gain");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        logHidRx('Moondrop', data);
        console.log(`USB Device PEQ: Moondrop onInputReport received DAC gain data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_DAC_GAIN) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const gain = data[3];
        console.log(`USB Device PEQ: Moondrop DAC gain value: ${gain}`);
        resolve(gain);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readDACGain command:`, request);
      logHidTx('Moondrop', REPORT_ID, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function writeDACGain(device, vl) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_DAC_GAIN, 1, vl]);
    console.log(`USB Device PEQ: Moondrop sending writeDACGain command:`, request);
    logHidTx('Moondrop', REPORT_ID, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function readDACMode(device) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([COMMAND_READ, COMMAND_DAC_MODE, 0]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading DAC mode");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        logHidRx('Moondrop', data);
        console.log(`USB Device PEQ: Moondrop onInputReport received DAC mode data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_DAC_MODE) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const mode = data[3];
        console.log(`USB Device PEQ: Moondrop DAC mode value: ${mode}`);
        resolve(mode);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readDACMode command:`, request);
      logHidTx('Moondrop', REPORT_ID, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function writeDACMode(device, vl) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_DAC_MODE, 1, vl]);
    console.log(`USB Device PEQ: Moondrop sending writeDACMode command:`, request);
    logHidTx('Moondrop', REPORT_ID, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function readLEDSwitch(device) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([COMMAND_READ, COMMAND_LED_SWITCH, 0]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading LED switch");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        logHidRx('Moondrop', data);
        console.log(`USB Device PEQ: Moondrop onInputReport received LED switch data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_LED_SWITCH) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const ledSwitch = data[3];
        console.log(`USB Device PEQ: Moondrop LED switch value: ${ledSwitch}`);
        resolve(ledSwitch);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readLEDSwitch command:`, request);
      logHidTx('Moondrop', REPORT_ID, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function writeLEDSwitch(device, vl) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_LED_SWITCH, 1, vl]);
    console.log(`USB Device PEQ: Moondrop sending writeLEDSwitch command:`, request);
    logHidTx('Moondrop', REPORT_ID, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function readDACFilter(device) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([COMMAND_READ, COMMAND_DAC_FILTER, 0]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading DAC filter");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        logHidRx('Moondrop', data);
        console.log(`USB Device PEQ: Moondrop onInputReport received DAC filter data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_DAC_FILTER) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const filter = data[3];
        console.log(`USB Device PEQ: Moondrop DAC filter value: ${filter}`);
        resolve(filter);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readDACFilter command:`, request);
      logHidTx('Moondrop', REPORT_ID, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function writeDACFilter(device, vl) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_DAC_FILTER, 1, vl]);
    console.log(`USB Device PEQ: Moondrop sending writeDACFilter command:`, request);
    logHidTx('Moondrop', REPORT_ID, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function resetEQ(device) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_RESET_EQ, 1, 4, 0]);
    console.log(`USB Device PEQ: Moondrop sending resetEQ command:`, request);
    logHidTx('Moondrop', REPORT_ID, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function resetFlash(device) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_RESET_FLASH, 0]);
    console.log(`USB Device PEQ: Moondrop sending resetFlash command:`, request);
    logHidTx('Moondrop', REPORT_ID, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function setEQIndex(device, index) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_ACTIVE_EQ, index]);
    console.log(`USB Device PEQ: Moondrop sending setEQIndex command for slot ${index}:`, request);
    logHidTx('Moondrop', REPORT_ID, request);
    await device.sendReport(REPORT_ID, request);
  }

  return {
    getCurrentSlot,
    setEQIndex,
    pullFromDevice,
    pushToDevice,
    enablePEQ: async () => {}
  };
})();

// WalkPlay protocol: DAWN PRO 2, MOONDROP HiFi with PD, MD-QT-042.
const walkplayProtocol = (function () {
  const REPORT_ID = 0x4B;
  const READ = 0x80;
  const WRITE = 0x01;
  const END = 0x00;
  const CMD = {
    FLASH_EQ: 0x01, MIC_GAIN: 0x02, GLOBAL_GAIN: 0x03, PEQ_VALUES: 0x09,
    TEMP_WRITE: 0x0A, VERSION: 0x0C, GET_SLOT: 0x0F, DAC_FILTER: 0x11,
    DAC_BALANCE: 0x16, GAIN_MODE: 0x19, DENOISE: 0x1B, DAC_WORK_MODE: 0x1D
  };

  const getCurrentSlot = async (deviceDetails) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error('Device not connected.');
    let response = await requestReport(device, REPORT_ID, new Uint8Array([READ, CMD.VERSION, END]),
      data => data.length >= 6 && data[1] === CMD.VERSION, 'Walkplay', 2000);
    const version = String.fromCharCode(...response.slice(3, 6));
    const versionNumber = parseFloat(version);
    deviceDetails.version = versionNumber;
    response = await requestReport(device, REPORT_ID, new Uint8Array([READ, CMD.PEQ_VALUES, END]),
      data => data.length >= 36 && data[1] === CMD.PEQ_VALUES, 'Walkplay', 2000);
    return response ? response[35] : -1;
  };

  const pushToDevice = async (deviceDetails, phoneObj, slot, globalGain, filtersToWrite) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error('Device not connected.');
    if (typeof slot === 'string') slot = parseInt(slot, 10);
    for (let i = 0; i < filtersToWrite.length; i++) {
      const filter = filtersToWrite[i] || {};
      const filterToWrite = normalizeFilterForWrite(filter, deviceDetails.modelConfig);
      const bArr = filter.disabled
        ? new Array(20).fill(0)
        : computeIIRFilter(i, filterToWrite.freq, filterToWrite.gain, filterToWrite.q, filterToWrite.type);
      const packet = [
        WRITE, CMD.PEQ_VALUES, 0x18, 0x00, i, 0x00, 0x00, ...bArr,
        ...convertToByteArray(filterToWrite.freq, 2),
        ...convertToByteArray(Math.round(filterToWrite.q * 256), 2),
        ...convertToByteArray(Math.round(filterToWrite.gain * 256), 2),
        convertFromFilterType(filterToWrite.type), 0x00,
        (deviceDetails.modelConfig && typeof deviceDetails.modelConfig.defaultIndex !== 'undefined')
          ? deviceDetails.modelConfig.defaultIndex : slot,
        END
      ];
      await sendReport(device, REPORT_ID, packet);
      await delay(20);
    }
    await delay(100);
    if (deviceDetails.modelConfig.deviceHandlesPregain === false) {
      await writeGlobalGain(device, globalGain);
      await delay(50);
    }
    // Order matters: this sequence persists the EQ while leaving it enabled.
    await sendReport(device, REPORT_ID, [WRITE, 0x05, END]);
    await delay(20);
    await sendReport(device, REPORT_ID, [WRITE, 0x17, END]);
    await delay(20);
    await sendReport(device, REPORT_ID, [WRITE, CMD.TEMP_WRITE, 0x04, 0x00, 0x00, 0xFF, 0xFF, END]);
    await delay(50);
    await sendReport(device, REPORT_ID, [WRITE, CMD.FLASH_EQ, 0x01, END]);
  };

  const setMicGain = async (deviceDetails, value) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error('Device not connected.');
    let t;
    if (value === 15) t = 32767;
    else if (value === -15) t = 32769;
    else {
      let r = Math.round(value * (32767 / 15));
      r = Math.max(-32767, Math.min(32767, r));
      t = r < 0 ? r + 65536 : r;
    }
    await sendReport(device, REPORT_ID, [WRITE, CMD.MIC_GAIN, 0x02, t & 0xFF, (t >> 8) & 0xFF]);
  };

  const readMicGain = async (deviceDetails) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error('Device not connected.');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        device.removeEventListener('inputreport', onReport);
        reject('Timeout reading mic gain');
      }, 1000);
      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        logHidRx('Walkplay', data);
        if (data[0] !== READ || data[1] !== CMD.MIC_GAIN) return;
        clearTimeout(timeout);
        device.removeEventListener('inputreport', onReport);
        const raw = data[2] | (data[3] << 8);
        const signed = raw > 32767 ? raw - 65536 : raw;
        resolve(Math.round((signed * 15 / 32767) * 100) / 100);
      };
      device.addEventListener('inputreport', onReport);
      sendReport(device, REPORT_ID, [READ, CMD.MIC_GAIN, 0x00]).catch(reject);
    });
  };

  function convertFromFilterType(filterType) {
    const mapping = { PK: 2, LSQ: 1, HSQ: 3, LP: 4, HP: 5 };
    return mapping[filterType] !== undefined ? mapping[filterType] : 2;
  }

  function normalizeFilterForWrite(filter = {}, modelConfig) {
    if (filter.disabled) return { freq: 0, q: 0, gain: 0, type: 'PK' };
    const requestedFreq = Number.isFinite(filter.freq) ? filter.freq : 0;
    const gain = Number.isFinite(filter.gain) ? filter.gain : 0;
    const q = Number.isFinite(filter.q) ? filter.q : 0;
    const type = filter.type || filter.filterType || 'PK';
    const freqToSend = requestedFreq > 0
      ? compensateFreqForWrite(requestedFreq, modelConfig, { label: 'WalkPlay' }) : requestedFreq;
    return {
      freq: freqToSend,
      q: q > 0
        ? compensateQForWrite(q, gain, type, modelConfig, { label: 'WalkPlay', freq: freqToSend }) : q,
      gain,
      type
    };
  }

  const pullFromDevice = async (deviceDetails, slot = -1) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error('Device not connected.');
    const filters = [];
    const onFilterReport = (event) => {
      const data = new Uint8Array(event.data.buffer);
      logHidRx('Walkplay', data);
      if (data[1] !== CMD.PEQ_VALUES) return;
      if (data.length >= 34) {
        const filter = parseFilterPacket(data, deviceDetails.modelConfig);
        filters[filter.filterIndex] = filter;
      }
    };
    device.addEventListener('inputreport', onFilterReport);
    try {
      for (let i = 0; i < deviceDetails.modelConfig.maxFilters; i++) {
        await sendReport(device, REPORT_ID, [READ, CMD.PEQ_VALUES, 0x00, 0x00, i, END]);
        await delay(50);
      }
      await delay(100);
      const result = await waitForFilters(
        () => filters.filter(f => f !== undefined).length === deviceDetails.modelConfig.maxFilters,
        device, 10000,
        () => ({ filters, globalGain: 0, currentSlot: slot, deviceDetails: deviceDetails.modelConfig })
      );
      try {
        result.globalGain = await readGlobalGain(device);
      } catch (error) {
        Object.defineProperty(result, 'globalGainError', { value: error });
        console.warn(`USB Device PEQ: Walkplay failed to read global gain: ${error}`);
      }
      return result;
    } finally {
      device.removeEventListener('inputreport', onFilterReport);
    }
  };

  function parseFilterPacket(packet, modelConfig) {
    if (packet.length < 34) throw new Error('Packet too short to contain filter data.');
    const filterIndex = packet[4];
    const freqRaw = packet[27] | (packet[28] << 8);
    const freq = freqRaw > 0 ? decompensateFreqFromRead(freqRaw, modelConfig) : freqRaw;
    let gainRaw = packet[31] | (packet[32] << 8);
    if (gainRaw > 32767) gainRaw -= 65536;
    const gain = Math.round((gainRaw / 256) * 100) / 100;
    const type = convertToFilterType(packet[33]);
    const qRaw = packet[29] | (packet[30] << 8);
    const qStored = Math.round((qRaw / 256) * 100) / 100;
    const q = qStored > 0
      ? decompensateQFromRead(qStored, gain, type, modelConfig, { freq: freqRaw }) : qStored;
    if (freq === 65535 && qRaw === 65535 && gainRaw === -1) {
      return { filterIndex, freq: 0, q: 0, gain: 0, type, disabled: true };
    }
    const valid = !(freq === 65535 || freq === 0 || q === 0 || (freq === 0 && q === 0 && gain === 0));
    return {
      filterIndex, freq: valid ? freq : 0, q: valid ? q : 0,
      gain: valid ? gain : 0, type, disabled: !valid
    };
  }

  function convertToFilterType(byte) {
    switch (byte) {
      case 1: return 'LSQ';
      case 2: return 'PK';
      case 3: return 'HSQ';
      case 4: return 'LP';
      case 5: return 'HP';
      default: return 'PK';
    }
  }

  const enablePEQ = async (deviceDetails, enable, slotId) => {
    if (!enable) slotId = 0x00;
    await sendReport(deviceDetails.rawDevice, REPORT_ID, [WRITE, CMD.FLASH_EQ, enable ? 1 : 0, slotId, END]);
  };

  async function sendReport(device, reportId, packet) {
    if (!device) throw new Error('Device not connected.');
    const data = new Uint8Array(packet);
    logHidTx('Walkplay', reportId, data);
    await device.sendReport(reportId, data);
  }

  async function readGlobalGain(device) {
    const data = await requestReport(device, REPORT_ID, new Uint8Array([READ, CMD.GLOBAL_GAIN, 0]),
      data => data.length >= 5 && data[0] === READ && data[1] === CMD.GLOBAL_GAIN, 'Walkplay', 100);
    return new Int8Array([data[4]])[0];
  }

  async function writeGlobalGain(device, value) {
    await sendReport(device, REPORT_ID, [WRITE, CMD.GLOBAL_GAIN, 0x02, 0x00, Math.round(value)]);
  }

  const setDacFilter = async (deviceDetails, filterType) => {
    const filterMap = { 'FAST-LL': 1, 'FAST-PC': 2, 'SLOW-LL': 3, 'SLOW-PC': 4, 'NON-OS': 5 };
    await sendReport(deviceDetails.rawDevice, REPORT_ID, [WRITE, CMD.DAC_FILTER, 0x01, filterMap[filterType] ?? 1]);
  };

  const setDacBalance = async (deviceDetails, leftDelta, rightDelta) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error('Device not connected.');
    if (leftDelta > 0) {
      await sendReport(device, REPORT_ID, [WRITE, CMD.DAC_BALANCE, 0x04, 0x01, 0x00, leftDelta & 0xFF, 0x00]);
      await sendReport(device, REPORT_ID, [WRITE, CMD.DAC_BALANCE, 0x04, 0x00, 0x00, 0x00, 0x00]);
    } else if (rightDelta > 0) {
      await sendReport(device, REPORT_ID, [WRITE, CMD.DAC_BALANCE, 0x04, 0x01, 0x00, 0x00, 0x00]);
      await sendReport(device, REPORT_ID, [WRITE, CMD.DAC_BALANCE, 0x04, 0x00, 0x00, rightDelta & 0xFF, 0x00]);
    } else {
      await sendReport(device, REPORT_ID, [WRITE, CMD.DAC_BALANCE, 0x04, 0x00, 0x01, 0x00, 0x00]);
      await sendReport(device, REPORT_ID, [WRITE, CMD.DAC_BALANCE, 0x04, 0x00, 0x00, 0x00, 0x00]);
    }
  };

  const setDenoiseEnabled = async (deviceDetails, enabled) => {
    await sendReport(deviceDetails.rawDevice, REPORT_ID, [WRITE, CMD.DENOISE, 0x01, enabled ? 0x01 : 0x00]);
  };

  const readDenoiseEnabled = async (deviceDetails) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error('Device not connected.');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        device.removeEventListener('inputreport', onReport);
        reject('Timeout reading denoise state');
      }, 2000);
      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        logHidRx('Walkplay', data);
        if (data[0] !== READ || data[1] !== CMD.DENOISE) return;
        clearTimeout(timeout);
        device.removeEventListener('inputreport', onReport);
        resolve(data[3] === 0x01);
      };
      device.addEventListener('inputreport', onReport);
      sendReport(device, REPORT_ID, [READ, CMD.DENOISE, 0x00]).catch(reject);
    });
  };

  const readDacFilter = async (deviceDetails) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error('Device not connected.');
    const names = { 1: 'FAST-LL', 2: 'FAST-PC', 3: 'SLOW-LL', 4: 'SLOW-PC', 5: 'NON-OS' };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        device.removeEventListener('inputreport', onReport);
        reject('Timeout reading DAC filter');
      }, 2000);
      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        logHidRx('Walkplay', data);
        if (data[0] !== READ || data[1] !== CMD.DAC_FILTER) return;
        clearTimeout(timeout);
        device.removeEventListener('inputreport', onReport);
        resolve(names[data[3]] ?? null);
      };
      device.addEventListener('inputreport', onReport);
      sendReport(device, REPORT_ID, [READ, CMD.DAC_FILTER]).catch(reject);
    });
  };

  const setDacWorkMode = async (deviceDetails, mode) => {
    await sendReport(deviceDetails.rawDevice, REPORT_ID, [WRITE, CMD.DAC_WORK_MODE, 0x01, mode & 0xFF]);
  };

  const readDacWorkMode = async (deviceDetails) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error('Device not connected.');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        device.removeEventListener('inputreport', onReport);
        reject('Timeout reading DAC work mode');
      }, 2000);
      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        logHidRx('Walkplay', data);
        if (data[0] !== READ || data[1] !== CMD.DAC_WORK_MODE) return;
        clearTimeout(timeout);
        device.removeEventListener('inputreport', onReport);
        resolve(data[3]);
      };
      device.addEventListener('inputreport', onReport);
      sendReport(device, REPORT_ID, [READ, CMD.DAC_WORK_MODE]).catch(reject);
    });
  };

  const setOutputGain = async (deviceDetails, gainDb) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error('Device not connected.');
    await writeGlobalGain(device, gainDb);
  };

  const setGainMode = async (deviceDetails, enabled) => {
    await sendReport(deviceDetails.rawDevice, REPORT_ID, [WRITE, CMD.GAIN_MODE, 0x01, enabled ? 0x01 : 0x00]);
  };

  const readGainMode = async (deviceDetails) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error('Device not connected.');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        device.removeEventListener('inputreport', onReport);
        reject('Timeout reading gain mode');
      }, 2000);
      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        logHidRx('Walkplay', data);
        if (data[0] !== READ || data[1] !== CMD.GAIN_MODE) return;
        clearTimeout(timeout);
        device.removeEventListener('inputreport', onReport);
        resolve(data[3] === 0x01);
      };
      device.addEventListener('inputreport', onReport);
      sendReport(device, REPORT_ID, [READ, CMD.GAIN_MODE, 0x00]).catch(reject);
    });
  };

  return {
    pushToDevice, pullFromDevice, getCurrentSlot, enablePEQ, setMicGain, readMicGain,
    setDacFilter, readDacFilter, setDacBalance, setDenoiseEnabled, readDenoiseEnabled,
    setDacWorkMode, readDacWorkMode, setOutputGain, setGainMode, readGainMode
  };
})();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForFilters(condition, device, timeout, callback) {
  return new Promise((resolve, reject) => {
    let interval;
    const timer = setTimeout(() => {
      clearInterval(interval);
      const result = callback(device);
      if (!condition()) {
        result.complete = false;
        result.receivedCount = result.filters.filter(f => f !== undefined).length;
        result.expectedCount = device.max;
      } else {
        result.complete = true;
      }
      resolve(result);
    }, timeout);
    interval = setInterval(() => {
      if (condition()) {
        clearTimeout(timer);
        clearInterval(interval);
        const result = callback(device);
        result.complete = true;
        resolve(result);
      }
    }, 10);
  });
}

// Keep WalkPlay's arithmetic/quantization separate from the native protocol.
function computeIIRFilter(i, freq, gain, q, type = 'PK') {
  const bArr = new Array(20).fill(0);
  const A = Math.sqrt(Math.pow(10, gain / 20));
  const w0 = (freq * 6.283185307179586) / 96000;
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * q);
  const cosw0 = Math.cos(w0);
  let a0, a1, a2, b0, b1, b2;
  if (type === 'LSQ' || type === 'HSQ') {
    const shelfAlpha = (sinw0 / 2) * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
    const sqrtA2alpha = 2 * Math.sqrt(A) * shelfAlpha;
    if (type === 'LSQ') {
      b0 = A * ((A + 1) - (A - 1) * cosw0 + sqrtA2alpha);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosw0);
      b2 = A * ((A + 1) - (A - 1) * cosw0 - sqrtA2alpha);
      a0 = (A + 1) + (A - 1) * cosw0 + sqrtA2alpha;
      a1 = -2 * ((A - 1) + (A + 1) * cosw0);
      a2 = (A + 1) + (A - 1) * cosw0 - sqrtA2alpha;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cosw0 + sqrtA2alpha);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosw0);
      b2 = A * ((A + 1) + (A - 1) * cosw0 - sqrtA2alpha);
      a0 = (A + 1) - (A - 1) * cosw0 + sqrtA2alpha;
      a1 = 2 * ((A - 1) - (A + 1) * cosw0);
      a2 = (A + 1) - (A - 1) * cosw0 - sqrtA2alpha;
    }
  } else {
    b0 = 1 + alpha * A;
    b1 = -2 * cosw0;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cosw0;
    a2 = 1 - alpha / A;
  }
  const quantizerData = quantizer([1, a1 / a0, a2 / a0], [b0 / a0, b1 / a0, b2 / a0]);
  let index = 0;
  for (const value of quantizerData) {
    bArr[index] = value & 0xFF;
    bArr[index + 1] = (value >> 8) & 0xFF;
    bArr[index + 2] = (value >> 16) & 0xFF;
    bArr[index + 3] = (value >> 24) & 0xFF;
    index += 4;
  }
  return bArr;
}

function convertToByteArray(value, length) {
  const arr = [];
  for (let i = 0; i < length; i++) arr.push((value >> (8 * i)) & 0xFF);
  return arr;
}

function quantizer(dArr, dArr2) {
  const iArr = dArr.map(d => Math.round(d * 1073741824));
  const iArr2 = dArr2.map(d => Math.round(d * 1073741824));
  return [iArr2[0], iArr2[1], iArr2[2], -iArr[1], -iArr[2]];
}

// KT Micro register protocol: CDSP and Chu2 DSP.
const registerProtocol = (function () {
  const REPORT_ID = 0x4B;
  const COMMAND_READ = 0x52;
  const COMMAND_WRITE = 0x57;
  const COMMAND_COMMIT = 0x53;
  const COMMAND_CLEAR = 0x43;
  async function sendCommandWithResponse(device, packet, timeoutMs = 1000) {
    return requestReport(device, REPORT_ID, packet,
      data => data.length >= 10 && data[0] === packet[0] && data[4] === packet[4], 'KTMicro', timeoutMs);
  }

  function buildReadPacket(register) {
    return new Uint8Array([register, 0, 0, 0, COMMAND_READ, 0, 0, 0, 0, 0]);
  }

  function buildEnableEQPacket(slotId) {
    return new Uint8Array([0x24, 0, 0, 0, COMMAND_WRITE, 0, slotId, 0, 0, 0]);
  }

  function decodeGainFreqResponse(data, compensate2X) {
    const gainRaw = data[6] | (data[7] << 8);
    const gain = gainRaw > 0x7FFF ? gainRaw - 0x10000 : gainRaw;
    let freq = data[8] + (data[9] << 8);
    if (compensate2X) freq *= 2;
    return { gain: gain / 10.0, freq };
  }

  function decodeQResponse(data) {
    const q = (data[6] + (data[7] << 8)) / 1000.0;
    let type = 'PK';
    if (data[8] === 3) type = 'LSQ';
    else if (data[8] === 4) type = 'HSQ';
    return { q, type };
  }

  async function getCurrentSlot(deviceDetails) {
    const request = new Uint8Array([0x24, 0, 0, 0, COMMAND_READ, 0, 0x03, 0, 0, 0]);
    const data = await sendCommandWithResponse(deviceDetails.rawDevice, request);
    return data[6];
  }

  function bandRegistersFor(modelConfig, filterIndex) {
    const map = modelConfig.bandRegisters;
    if (Array.isArray(map) && map[filterIndex]) {
      return { gainFreqId: map[filterIndex].freq, qId: map[filterIndex].q };
    }
    const gainFreqId = (modelConfig.baseRegisterOffset || 0x26) + filterIndex * 2;
    return { gainFreqId, qId: gainFreqId + 1 };
  }

  async function readFullFilter(device, filterIndex, compensate2X, gainFreqId, qId) {
    const dataGainFreq = await sendCommandWithResponse(device, buildReadPacket(gainFreqId));
    const gainFreqResult = decodeGainFreqResponse(dataGainFreq, compensate2X);
    const dataQ = await sendCommandWithResponse(device, buildReadPacket(qId));
    return { ...gainFreqResult, ...decodeQResponse(dataQ) };
  }

  async function readPregain(device) {
    const data = await sendCommandWithResponse(device, buildReadPacket(0x66));
    return data[6] > 127 ? data[6] - 256 : data[6];
  }

  async function writePregain(device, value) {
    const request = new Uint8Array([0x66, 0, 0, 0, COMMAND_WRITE, 0, 0, 0, 0, 0]);
    let processedGlobalGain = Math.round(value);
    if (processedGlobalGain < 0) processedGlobalGain &= 0xFF;
    request[6] = processedGlobalGain;
    logHidTx('KTMicro', REPORT_ID, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function pullFromDevice(deviceDetails) {
    const device = deviceDetails.rawDevice;
    const filters = [];
    for (let i = 0; i < deviceDetails.modelConfig.maxFilters; i++) {
      const { gainFreqId, qId } = bandRegistersFor(deviceDetails.modelConfig, i);
      filters.push(await readFullFilter(device, i, deviceDetails.modelConfig.compensate2X, gainFreqId, qId));
    }
    return { filters, globalGain: await readPregain(device) };
  }

  function toLittleEndianBytes(value, scale = 1) {
    const v = Math.round(value * scale);
    return [v & 0xFF, (v >> 8) & 0xFF];
  }

  function toSignedLittleEndianBytes(value, scale = 1) {
    let v = Math.round(value * scale);
    if (v < 0) v += 0x10000;
    return [v & 0xFF, (v >> 8) & 0xFF];
  }

  function buildWritePacket(filterId, freq, gain) {
    const frequency = toLittleEndianBytes(freq);
    const level = toSignedLittleEndianBytes(gain, 10);
    return new Uint8Array([filterId, 0, 0, 0, COMMAND_WRITE, 0, ...level, ...frequency]);
  }

  function buildQPacket(filterId, q, type) {
    const value = toLittleEndianBytes(q, 1000);
    let filterTypeValue = 0;
    if (type === 'LSQ') filterTypeValue = 3;
    else if (type === 'HSQ') filterTypeValue = 4;
    return new Uint8Array([filterId, 0, 0, 0, COMMAND_WRITE, 0, ...value, filterTypeValue, 0]);
  }

  function buildCommand(commandCode) {
    return new Uint8Array([0, 0, 0, 0, commandCode, 0, 0, 0, 0, 0]);
  }

  async function pushClearToDevice(device) {
    await sendCommandWithResponse(device, buildCommand(COMMAND_CLEAR));
    await delay(200);
  }

  async function pushToDevice(deviceDetails, phoneObj, slot, globalGain, filters) {
    const device = deviceDetails.rawDevice;
    const currentSlot = await getCurrentSlot(deviceDetails);
    if (currentSlot === deviceDetails.modelConfig.disabledPresetId) {
      slot = deviceDetails.modelConfig.availableSlots[0].id;
      await enablePEQ(deviceDetails, true, slot);
    }
    for (let i = 0; i < filters.length; i++) {
      if (i >= deviceDetails.modelConfig.maxFilters) break;
      const { gainFreqId, qId } = bandRegistersFor(deviceDetails.modelConfig, i);
      let freqToWrite = filters[i].freq;
      if (deviceDetails.modelConfig.compensate2X) freqToWrite /= 2;
      const gain = filters[i].disabled ? 0 : filters[i].gain;
      const gainFreq = buildWritePacket(gainFreqId, freqToWrite, gain);
      const q = buildQPacket(qId, filters[i].q, filters[i].type);
      // Individual writes are fire-and-forget; some firmware never ACKs them.
      logHidTx('KTMicro', REPORT_ID, gainFreq);
      await device.sendReport(REPORT_ID, gainFreq);
      logHidTx('KTMicro', REPORT_ID, q);
      await device.sendReport(REPORT_ID, q);
    }
    if (deviceDetails.modelConfig.deviceHandlesPregain === false) await writePregain(device, globalGain);
    const commit = buildCommand(COMMAND_COMMIT);
    logHidTx('KTMicro', REPORT_ID, commit);
    await device.sendReport(REPORT_ID, commit);
    await delay(1000);
    return !!deviceDetails.modelConfig.disconnectOnSave;
  }

  const enablePEQ = async (deviceDetails, enable, slotId) => {
    if (slotId === deviceDetails.modelConfig.disabledPresetId || enable === false) {
      slotId = deviceDetails.modelConfig.disabledPresetId;
    }
    await sendCommandWithResponse(deviceDetails.rawDevice, buildEnableEQPacket(slotId));
  };

  return { getCurrentSlot, pushToDevice, pullFromDevice, enablePEQ };
})();

// Legacy register protocol: Old Fashioned. Gain is int8, not KT Micro's int16.
const legacyProtocol = (function () {
  const REPORT_ID = 75;
  const EQ_REG_BASE = 38;
  const WRITE_REG = 87;
  const SAVE_REG = 83;
  const READ_REG = 82;
  const PACKET_LEN = 10;
  const SCALE_GAIN = 10;
  const SCALE_Q = 1000;
  const DELAY_MS = 100;
  const ADDR = 0;
  const CMD = 4;
  const DATA_SLOT_GAIN = 6;
  const DATA_SLOT_Q = 6;
  const DATA_SLOT_FREQUENCY = 8;

  function sleep(ms = DELAY_MS) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getFilterRegAddr(filterIndex) {
    return EQ_REG_BASE + filterIndex * 2;
  }

  function createPacket(builder) {
    const buffer = new ArrayBuffer(PACKET_LEN);
    builder(new DataView(buffer));
    return new Uint8Array(buffer);
  }

  async function readRegister(device, addr) {
    const packet = createPacket(view => {
      view.setUint8(ADDR, addr);
      view.setUint8(CMD, READ_REG);
    });
    const data = await requestReport(device, REPORT_ID, packet,
      data => data.length >= 10 && data[0] === addr && data[4] === READ_REG, 'MoondropOldFashioned');
    return new DataView(data.buffer);
  }

  async function writeRegister(device, addr, dataBuilder) {
    const packet = createPacket(view => {
      view.setUint8(ADDR, addr);
      view.setUint8(CMD, WRITE_REG);
      dataBuilder(view);
    });
    logHidTx('MoondropOldFashioned', REPORT_ID, packet);
    await device.sendReport(REPORT_ID, packet);
  }

  async function readSingleFilter(device, filterIndex) {
    const regAddr = getFilterRegAddr(filterIndex);
    const data1 = await readRegister(device, regAddr);
    const freq = data1.getUint16(DATA_SLOT_FREQUENCY, true);
    const gain = Math.max(-12.8, Math.min(12.7, data1.getInt8(DATA_SLOT_GAIN) / SCALE_GAIN));
    await sleep();
    const data2 = await readRegister(device, regAddr + 1);
    const q = data2.getInt16(DATA_SLOT_Q, true) / SCALE_Q;
    return { freq, gain, q, type: 'PK' };
  }

  async function pullFromDevice(deviceDetails) {
    const filters = [];
    const filterCount = deviceDetails.modelConfig.maxFilters || 5;
    for (let i = 0; i < filterCount; i++) {
      filters.push(await readSingleFilter(deviceDetails.rawDevice, i));
      await sleep();
    }
    return { filters, globalGain: 0 };
  }

  async function writeSingleFilter(device, filterIndex, filter) {
    const regAddr = getFilterRegAddr(filterIndex);
    const { freq, gain, q } = filter;
    await writeRegister(device, regAddr, view => {
      const clampedGain = Math.max(-128, Math.min(127, Math.round(gain * SCALE_GAIN)));
      view.setInt8(DATA_SLOT_GAIN, clampedGain);
      view.setUint16(DATA_SLOT_FREQUENCY, freq, true);
    });
    await sleep();
    await writeRegister(device, regAddr + 1, view => {
      view.setInt16(DATA_SLOT_Q, Math.round(q * SCALE_Q), true);
    });
    await sleep();
  }

  async function saveToFlash(device) {
    const packet = createPacket(view => view.setUint8(CMD, SAVE_REG));
    logHidTx('MoondropOldFashioned', REPORT_ID, packet);
    await device.sendReport(REPORT_ID, packet);
  }

  async function pushToDevice(deviceDetails, phoneObj, slot, globalGain, filters) {
    const filterCount = deviceDetails.modelConfig.maxFilters || 5;
    for (let i = 0; i < filters.length && i < filterCount; i++) {
      await writeSingleFilter(deviceDetails.rawDevice, i, filters[i]);
    }
    await saveToFlash(deviceDetails.rawDevice);
    return false;
  }

  async function getCurrentSlot(deviceDetails) {
    return 0;
  }

  return { pullFromDevice, pushToDevice, getCurrentSlot, enablePEQ: async () => {} };
})();

// Conexant protocol: FreeDSP and ECHO-B (write-only).
const conexantProtocol = (function () {
  const REPORT_ID = 0x01;
  const PACKET_SIZE = 61;
  const HEADER_BYTES = [1, 1, 0];
  const MAGIC_NUMBER = 0xB307B0;
  const PACKET_ID_SAVE = 220;
  const PACKET_ID_RAM = 190;
  const PACKET_ID_MODE = 90;
  const SAMPLE_RATES = [
    { idx: 0x04, rate: 44100 }, { idx: 0x05, rate: 48000 },
    { idx: 0x06, rate: 96000 }, { idx: 0x07, rate: 192000 }
  ];
  const FIXED_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000];

  function getCurrentSlot(deviceDetails) {
    return Promise.resolve(0);
  }

  async function pullFromDevice(deviceDetails) {
    // These are placeholders, not values read from the device.
    const filters = FIXED_FREQUENCIES.map((freq, index) => ({
      index, freq, gain: 0, q: 1.0, type: 'PK', enabled: true, disabled: false
    }));
    return { filters, globalGain: 0, currentSlot: 0, complete: true };
  }

  async function pushToDevice(deviceDetails, phoneObj, slot, globalGain, filters) {
    const device = deviceDetails.rawDevice;
    for (let i = 0; i < filters.length && i < FIXED_FREQUENCIES.length; i++) {
      await writeFilterToFlash(device, i + 1, filters[i]);
    }
    await applyEQMode(device, 0);
    return false;
  }

  async function enablePEQ(deviceDetails, enable, slotId) {
    if (!enable) await applyEQMode(deviceDetails.rawDevice, 0);
  }

  function packPacket(packetId, dataArray) {
    const packet = new Uint8Array(PACKET_SIZE);
    let offset = 0;
    for (const byte of HEADER_BYTES) packet[offset++] = byte;
    const packed = dataArray.length | ((packetId & 0xFFF) << 16);
    packet[offset++] = packed & 0xFF;
    packet[offset++] = (packed >> 8) & 0xFF;
    packet[offset++] = (packed >> 16) & 0xFF;
    packet[offset++] = (packed >> 24) & 0xFF;
    packet[offset++] = MAGIC_NUMBER & 0xFF;
    packet[offset++] = (MAGIC_NUMBER >> 8) & 0xFF;
    packet[offset++] = (MAGIC_NUMBER >> 16) & 0xFF;
    packet[offset++] = (MAGIC_NUMBER >> 24) & 0xFF;
    for (const value of dataArray) {
      packet[offset++] = value & 0xFF;
      packet[offset++] = (value >> 8) & 0xFF;
      packet[offset++] = (value >> 16) & 0xFF;
      packet[offset++] = (value >> 24) & 0xFF;
    }
    return packet;
  }

  async function writeFilterToFlash(device, bandNumber, filter) {
    const configPacket = packPacket(PACKET_ID_SAVE, [
      0, bandNumber, filter.freq, Math.round(filter.q * 256),
      convertFromFilterType(filter.type), Math.round(filter.gain * 256)
    ]);
    logHidTx('Conexant', REPORT_ID, configPacket);
    await device.sendReport(REPORT_ID, configPacket);
    await delay(15);
    for (const info of SAMPLE_RATES) {
      const biquad = computeBiquadForRate(filter.type, filter.freq, filter.gain, filter.q, info.rate);
      const packet = packPacket(PACKET_ID_SAVE, [info.idx, bandNumber, 3, ...biquad]);
      logHidTx('Conexant', REPORT_ID, packet);
      await device.sendReport(REPORT_ID, packet);
      await delay(15);
    }
  }

  function computeBiquadForRate(type, freq, gain, q, sampleRate) {
    const A = Math.pow(10, gain / 40);
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const sin_w0 = Math.sin(w0);
    const cos_w0 = Math.cos(w0);
    const alpha = sin_w0 / (2 * q);
    let a0, a1, a2, b0, b1, b2;
    switch (type) {
      case 'PK':
        b0 = 1 + alpha * A;
        b1 = -2 * cos_w0;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cos_w0;
        a2 = 1 - alpha / A;
        break;
      case 'LSQ': {
        const shelf_alpha = (sin_w0 / 2) * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
        const two_sqrt_A_alpha = 2 * Math.sqrt(A) * shelf_alpha;
        b0 = A * ((A + 1) - (A - 1) * cos_w0 + two_sqrt_A_alpha);
        b1 = 2 * A * ((A - 1) - (A + 1) * cos_w0);
        b2 = A * ((A + 1) - (A - 1) * cos_w0 - two_sqrt_A_alpha);
        a0 = (A + 1) + (A - 1) * cos_w0 + two_sqrt_A_alpha;
        a1 = -2 * ((A - 1) + (A + 1) * cos_w0);
        a2 = (A + 1) + (A - 1) * cos_w0 - two_sqrt_A_alpha;
        break;
      }
      case 'HSQ': {
        const shelf_alpha = (sin_w0 / 2) * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
        const two_sqrt_A_alpha = 2 * Math.sqrt(A) * shelf_alpha;
        b0 = A * ((A + 1) + (A - 1) * cos_w0 + two_sqrt_A_alpha);
        b1 = -2 * A * ((A - 1) + (A + 1) * cos_w0);
        b2 = A * ((A + 1) + (A - 1) * cos_w0 - two_sqrt_A_alpha);
        a0 = (A + 1) - (A - 1) * cos_w0 + two_sqrt_A_alpha;
        a1 = 2 * ((A - 1) - (A + 1) * cos_w0);
        a2 = (A + 1) - (A - 1) * cos_w0 - two_sqrt_A_alpha;
        break;
      }
      default:
        b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
    }
    const norm = a0;
    b0 /= norm; b1 /= norm; b2 /= norm; a1 /= norm; a2 /= norm;
    return [
      Math.round(b0 * 1073741824), Math.round(b1 * 1073741824), Math.round(b2 * 1073741824),
      Math.round(-a1 * 1073741824), Math.round(-a2 * 1073741824)
    ];
  }

  async function applyEQMode(device, modeIndex) {
    const packet = packPacket(PACKET_ID_MODE, [90, modeIndex]);
    logHidTx('Conexant', REPORT_ID, packet);
    await device.sendReport(REPORT_ID, packet);
  }

  function convertFromFilterType(filterType) {
    return { PK: 0, LSQ: 1, HSQ: 2 }[filterType] || 0;
  }

  return { getCurrentSlot, pullFromDevice, pushToDevice, enablePEQ };
})();

export { nativeProtocol, walkplayProtocol, registerProtocol, legacyProtocol, conexantProtocol };
