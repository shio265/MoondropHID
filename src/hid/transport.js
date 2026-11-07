import { logHidRx, logHidTx } from '../utils/logger.js';
import { HidError } from '../utils/errors.js';
import { operationFor } from './operations.js';

export function isSupported(hid = globalThis.navigator?.hid) {
  return !!hid && typeof hid.requestDevice === 'function' && typeof hid.getDevices === 'function';
}

// Register before sending, and clean up on response, timeout or transport error.
// Copy only the DataView slice; browser report buffers need not start at offset 0.
export function requestReport(device, reportId, packet, matches, handlerName, timeout = 1000) {
  const operation = operationFor(device);
  return new Promise((resolve, reject) => {
    operation?.throwIfAborted();
    let timer;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      device.removeEventListener('inputreport', onReport);
      operation?.signal.removeEventListener('abort', onAbort);
    };
    const fail = error => { if (settled) return; settled = true; cleanup(); reject(error); };
    const onAbort = () => fail(operation.error);
    const onReport = event => {
      if (settled) return;
      try {
        // Match the payload; some firmware uses a different input report ID.
        const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength).slice();
        logHidRx(handlerName, data);
        if (!matches(data)) return;
        settled = true;
        cleanup();
        resolve(data);
      } catch (error) { fail(error); }
    };
    timer = setTimeout(() => fail(new HidError('TIMEOUT', 'Timeout waiting for HID response.',
      { details: { ...operation?.details(), reportId, timeoutMs: timeout } })), timeout);
    operation?.signal.addEventListener('abort', onAbort, { once: true });
    device.addEventListener('inputreport', onReport);
    try {
      logHidTx(handlerName, reportId, packet);
      Promise.resolve(device.sendReport(reportId, packet)).catch(fail);
    } catch (error) { fail(error); }
  });
}
