// KT Micro register protocol: CDSP and Chu2 DSP.
import { requestReport } from '../hid/transport.js';
import { logHidTx } from '../utils/logger.js';
import { delay } from '../utils/timing.js';

export const registerProtocol = (function () {
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
