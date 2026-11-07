import { toHex } from './bytes.js';

let debugLogger = null;

export function setDebugLogger(logger) {
  if (logger !== null && typeof logger !== 'function') throw new TypeError('Logger must be a function or null.');
  debugLogger = logger;
}

export function debugLog(...values) {
  try { debugLogger?.(...values); } catch (_) { /* Logging must not interrupt USB I/O. */ }
}

export function logHidTx(handlerName, reportId, data) {
  if (debugLogger) return debugLog(`USB Device PEQ: [${handlerName}] TX reportId=${reportId} bytes=[${toHex(data)}]`);
}

export function logHidRx(handlerName, data) {
  if (debugLogger) return debugLog(`USB Device PEQ: [${handlerName}] RX bytes=[${toHex(data)}]`);
}
