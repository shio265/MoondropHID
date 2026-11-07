// Conexant protocol: FreeDSP and ECHO-B (write-only).
import { logHidTx } from '../utils/logger.js';
import { delay } from '../utils/timing.js';

export const conexantProtocol = (function () {
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
