import { logHidRx, logHidTx } from '../utils/logger.js';

export function isSupported(hid = globalThis.navigator?.hid) {
  return !!hid && typeof hid.requestDevice === 'function' && typeof hid.getDevices === 'function';
}

// Register before sending, and clean up on response, timeout or transport error.
// Copy only the DataView slice; browser report buffers need not start at offset 0.
export function requestReport(device, reportId, packet, matches, handlerName, timeout = 1000) {
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
