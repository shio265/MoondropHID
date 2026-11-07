// Legacy register protocol: Old Fashioned. Gain is int8, not KT Micro's int16.
import { requestReport } from '../hid/transport.js';
import { logHidTx } from '../utils/logger.js';
import { markWrite, operationDelay, reportProgress } from '../hid/operations.js';

export const legacyProtocol = (function () {
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

  function sleep(device, ms = DELAY_MS) {
    return operationDelay(device, ms);
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
    await sleep(device);
    const data2 = await readRegister(device, regAddr + 1);
    const q = data2.getInt16(DATA_SLOT_Q, true) / SCALE_Q;
    return { freq, gain, q, type: 'PK' };
  }

  async function pullFromDevice(deviceDetails) {
    const filters = [];
    const filterCount = deviceDetails.modelConfig.maxFilters || 5;
    for (let i = 0; i < filterCount; i++) {
      filters.push(await readSingleFilter(deviceDetails.rawDevice, i));
      reportProgress(deviceDetails, 'read', i + 1, filterCount);
      await sleep(deviceDetails.rawDevice);
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
    await sleep(device);
    await writeRegister(device, regAddr + 1, view => {
      view.setInt16(DATA_SLOT_Q, Math.round(q * SCALE_Q), true);
    });
    await sleep(device);
  }

  async function saveToFlash(device) {
    const packet = createPacket(view => view.setUint8(CMD, SAVE_REG));
    logHidTx('MoondropOldFashioned', REPORT_ID, packet);
    await device.sendReport(REPORT_ID, packet);
  }

  async function pushToDevice(deviceDetails, phoneObj, slot, globalGain, filters) {
    const filterCount = deviceDetails.modelConfig.maxFilters || 5;
    markWrite(deviceDetails);
    for (let i = 0; i < filters.length && i < filterCount; i++) {
      await writeSingleFilter(deviceDetails.rawDevice, i, filters[i]);
      reportProgress(deviceDetails, 'write', i + 1, filterCount);
    }
    reportProgress(deviceDetails, 'commit', 0, 1);
    await saveToFlash(deviceDetails.rawDevice);
    reportProgress(deviceDetails, 'commit', 1, 1);
    return false;
  }

  async function getCurrentSlot(deviceDetails) {
    return 0;
  }

  return { pullFromDevice, pushToDevice, getCurrentSlot, enablePEQ: async () => {} };
})();
