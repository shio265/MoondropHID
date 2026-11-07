import { fail } from './errors.js';

const MAX_REPORT_BYTES = 256;
const errorMessages = {
  UNSUPPORTED_ENVIRONMENT: 'WebHID is not available.',
  INSECURE_CONTEXT: 'WebHID requires HTTPS or localhost.',
  UNSUPPORTED_DEVICE: 'The selected device is not supported.',
  EXPERIMENTAL_DEVICE: 'Experimental device access is disabled.',
  NOT_CONNECTED: 'No device is connected.',
  BUSY: 'Another operation is in progress.',
  INVALID_CONFIG: 'Invalid configuration or operation options.',
  UNSUPPORTED_READ: 'This device does not support configuration reads.',
  UNSUPPORTED_OPERATION: 'This device does not support the operation.',
  INCOMPLETE_READ: 'The device returned an incomplete configuration.',
  CONNECTION_FAILED: 'Could not connect to the selected device.',
  IO_ERROR: 'USB operation failed.',
  DEVICE_DISCONNECTED: 'The device disconnected during the operation.',
  ABORTED: 'Operation aborted.',
  TIMEOUT: 'Operation timed out.',
  VERIFICATION_FAILED: 'Read-back verification failed.'
};

export function summarizeError(error, operation, operationId) {
  const code = Object.hasOwn(errorMessages, error.code) ? error.code : 'IO_ERROR';
  // Never retain arbitrary exception messages, input values, causes or stacks.
  return { timestamp: Date.now(), code, message: errorMessages[code], operation,
    ...(operationId !== undefined ? { operationId } : {}) };
}

export function createDiagnostics(options = false) {
  if (typeof options !== 'boolean' && (!options || typeof options !== 'object' || Array.isArray(options))) {
    fail('INVALID_CONFIG', 'diagnostics must be a boolean or an options object.');
  }
  const enabled = options !== false;
  const maxEntries = typeof options === 'object' ? options.maxEntries ?? 100 : 100;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 500) {
    fail('INVALID_CONFIG', 'diagnostics.maxEntries must be an integer in [1, 500].');
  }
  const entries = [];
  return {
    summary: () => ({ enabled, maxEntries, retainedEntries: entries.length, maxReportBytes: MAX_REPORT_BYTES }),
    record(direction, reportId, data, operation) {
      if (!enabled) return;
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      entries.push({ timestamp: Date.now(), direction, reportId, ...operation,
        byteLength: bytes.byteLength, bytes: [...bytes.subarray(0, MAX_REPORT_BYTES)],
        truncated: bytes.byteLength > MAX_REPORT_BYTES });
      if (entries.length > maxEntries) entries.shift();
    },
    snapshot: () => entries.map(entry => ({ ...entry, bytes: [...entry.bytes] }))
  };
}
