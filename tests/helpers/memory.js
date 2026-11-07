import { transport } from './transport.js';

// Stateful mock: replies are derived from bytes actually written, not the verification implementation.
export function memoryTransport(model = 'MOONRIVER 3', { protocol = 'moondrop', vendorId = 0x35D8 } = {}) {
  const hid = transport(model, { protocol, vendorId });
  const state = { bands: new Map(), registers: new Map(), globalGain: -2,
    slot: protocol === 'walkplay' ? 101 : protocol === 'ktmicro' ? 3 : protocol === 'legacy' ? 0 : 7,
    onRead: null };
  hid.memory = state;
  hid.raw.sendReport = async (reportId, payload) => {
    const request = new Uint8Array(payload);
    hid.raw.reports.push({ reportId, bytes: [...request] });
    const data = new Uint8Array(63);
    const view = new DataView(data.buffer);
    if (protocol === 'ktmicro' || protocol === 'legacy') {
      const register = request[0];
      if (request[4] === 0x57) {
        state.registers.set(register, request.slice());
        if (register !== 0x24) {
          if (register === 0x66) state.globalGain = new Int8Array([request[6]])[0];
          return;
        }
        state.slot = request[6];
      } else if (request[4] !== 0x52) return;
      const stored = state.registers.get(register);
      data.set(stored ?? request);
      data[4] = request[4];
      if (register === 0x24) data[6] = state.slot;
      else if (register === 0x66) data[6] = state.globalGain & 0xFF;
      else if (!stored && (register - 0x26) % 2 === 0) {
        view.setInt16(6, -30, true);
        if (protocol === 'legacy') view.setInt8(6, -30);
        view.setUint16(8, 1000 + ((register - 0x26) / 2) * 100, true);
      } else if (!stored) view.setUint16(6, 1000, true);
    } else {
      if (request[0] === 1) {
        if (request[1] === 0x09) state.bands.set(request[4], request.slice());
        if (request[1] === 0x23) state.globalGain = new DataView(request.buffer).getInt16(3, true) / 256;
        if (protocol === 'walkplay' && request[1] === 0x03) state.globalGain = new Int8Array([request[4]])[0];
        return;
      }
      if (request[0] !== 0x80) return;
      data[0] = 0x80;
      data[1] = request[1];
      if (request[1] === 0x09) {
        const index = request[4] ?? 0;
        const stored = state.bands.get(index);
        if (stored) data.set(stored);
        else {
          view.setUint16(27, 1000 + index * 100, true);
          view.setUint16(29, 256, true);
          view.setInt16(31, -3 * 256, true);
          data[33] = 2;
        }
        data[0] = 0x80;
        data[4] = index;
        data[35] = state.slot;
      } else if (request[1] === 0x03) {
        if (protocol === 'walkplay') data[4] = state.globalGain & 0xFF;
        else view.setInt16(3, Math.round(state.globalGain * 256), true);
      } else if (request[1] === 0x0C) data.set([49, 46, 48], 3);
      else if (request[1] === 0x0F) data[3] = state.slot;
      else if (request[1] === 0x11) data[3] = 3;
    }
    state.onRead?.(data, request);
    const event = new Event('inputreport');
    Object.defineProperties(event, { data: { value: new DataView(data.buffer) }, reportId: { value: reportId } });
    hid.raw.dispatchEvent(event);
  };
  return hid;
}
