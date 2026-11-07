// WalkPlay: DAWN PRO 2, MOONDROP HiFi with PD, MD-QT-042.
import { requestReport } from '../hid/transport.js';
import { logHidTx, logHidRx } from '../utils/logger.js';
import { delay } from '../utils/timing.js';
import { convertToByteArray } from '../utils/bytes.js';
import { compensateFreqForWrite, decompensateFreqFromRead,
  compensateQForWrite, decompensateQFromRead } from '../utils/compensation.js';

export const walkplayProtocol = (function () {
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
      }, 1000);
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
        resolve(data[3] === 0x01);
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

function quantizer(dArr, dArr2) {
  const iArr = dArr.map(d => Math.round(d * 1073741824));
  const iArr2 = dArr2.map(d => Math.round(d * 1073741824));
  return [iArr2[0], iArr2[1], iArr2[2], -iArr[1], -iArr[2]];
}
