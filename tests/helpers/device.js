// In-memory WebHID device. No real USB access is performed.
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
