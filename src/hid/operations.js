import { HidError, fail } from '../utils/errors.js';
import { immutable } from '../utils/object.js';
import { delay } from '../utils/timing.js';

// Only SDK-owned facades carry an operation. Legacy/reference callers stay unchanged.
const operations = new WeakMap();

export function operationFor(device) {
  return operations.get(device);
}

export function operationDelay(device, ms) {
  return operationFor(device)?.delay(ms) ?? delay(ms);
}

export function reportProgress(device, phase, completed, total) {
  const operation = operationFor(device);
  if (phase === 'commit' && completed === total) operation?.markWriteCompleted();
  operation?.progress(phase === 'read' && operation.verifying ? 'verify' : phase, completed, total);
}

export function markWrite(device) {
  operationFor(device)?.markWrite();
}

export function operationOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('INVALID_CONFIG', 'Operation options must be an object.');
  }
  const { signal, timeoutMs, onProgress } = options;
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    fail('INVALID_CONFIG', 'signal must be an AbortSignal.');
  }
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)) {
    fail('INVALID_CONFIG', 'timeoutMs must be an integer in [1, 2147483647].');
  }
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    fail('INVALID_CONFIG', 'onProgress must be a function.');
  }
  return { signal, timeoutMs, onProgress, slot: options.slot, verify: options.verify };
}

export function createOperation({ id, name, signal, timeoutMs, onProgress,
  emit = () => {}, record = () => {}, onError = () => {} }) {
  const controller = new AbortController();
  const nativePromises = new Set();
  const listeners = new Set();
  const facades = new WeakMap();
  const seenReports = new WeakSet();
  let error = null;
  let done = false;
  let disposed = false;
  let revision = 0;
  let timer;
  let phase = 'queued';
  let completed = 0;
  let total = 1;
  let status = 'running';
  let reportsSent = 0;
  let mayHaveWritten = false;
  let writeCompleted = false;

  const details = () => ({ operationId: id, operation: name, mayHaveWritten, writeCompleted, reportsSent });
  function detachDeadline() {
    clearTimeout(timer);
    signal?.removeEventListener('abort', externalAbort);
  }
  function removeListeners() {
    for (const entry of listeners) entry.raw.removeEventListener(entry.type, entry.wrapped, entry.options);
    listeners.clear();
  }
  function notify(nextStatus, errorCode) {
    status = nextStatus;
    const current = ++revision;
    const event = immutable({ type: 'progress', operationId: id, operation: name,
      phase, completed, total, status, ...(errorCode ? { errorCode } : {}) });
    try { onProgress?.(event); } catch (_) { /* Observers cannot interrupt I/O. */ }
    if (current === revision) emit(event, () => current === revision);
  }
  function cancel(code = 'ABORTED', cause) {
    if (done || error || disposed) return;
    error = new HidError(code, code === 'TIMEOUT' ? 'Operation timed out.'
      : code === 'DEVICE_DISCONNECTED' ? 'The device disconnected during the operation.' : 'Operation aborted.',
    { cause, details: details() });
    detachDeadline();
    removeListeners();
    controller.abort(error);
    onError(error);
    notify(code === 'ABORTED' ? 'cancelled' : 'failed', code);
  }
  function externalAbort() { cancel('ABORTED', signal.reason); }
  function throwIfAborted() {
    if (error) throw error;
  }
  function assertActive() {
    throwIfAborted();
    if (done || disposed) throw new HidError('ABORTED', 'Operation is no longer active.', { details: details() });
  }
  function wait(promise) {
    // Always observe the underlying promise, even when cancellation won the race.
    const pending = Promise.resolve(promise);
    return new Promise((resolve, reject) => {
      const cleanup = () => controller.signal.removeEventListener('abort', abort);
      const abort = () => { cleanup(); reject(error); };
      if (error) reject(error);
      else controller.signal.addEventListener('abort', abort, { once: true });
      pending.then(value => { cleanup(); error ? reject(error) : resolve(value); },
        cause => { cleanup(); reject(error ?? cause); });
    });
  }
  function native(action) {
    assertActive();
    const pending = Promise.resolve(action());
    nativePromises.add(pending);
    pending.then(() => nativePromises.delete(pending), () => nativePromises.delete(pending));
    return wait(pending);
  }
  function recordSafely(direction, reportId, data) {
    try { record(direction, reportId, data, { operationId: id, operation: name }); }
    catch (_) { /* Diagnostics must never affect device commands. */ }
  }
  function wrapRaw(raw) {
    if (facades.has(raw)) return facades.get(raw);
    const sendReport = (reportId, data) => native(() => {
      recordSafely('tx', reportId, data);
      const pending = Promise.resolve(raw.sendReport(reportId, data));
      pending.then(() => { reportsSent++; }, () => {});
      return pending;
    });
    const addEventListener = (type, listener, options) => {
      assertActive();
      if ([...listeners].some(entry => entry.raw === raw && entry.type === type && entry.listener === listener)) return;
      const wrapped = event => {
        if (error || done || disposed) return;
        if (type === 'inputreport' && !seenReports.has(event)) {
          seenReports.add(event);
          recordSafely('rx', event.reportId, event.data);
        }
        listener.call(raw, event);
      };
      listeners.add({ raw, type, listener, wrapped, options });
      raw.addEventListener(type, wrapped, options);
    };
    const removeEventListener = (type, listener) => {
      for (const entry of listeners) {
        if (entry.raw !== raw || entry.type !== type || entry.listener !== listener) continue;
        raw.removeEventListener(type, entry.wrapped, entry.options);
        listeners.delete(entry);
      }
    };
    const facade = new Proxy(raw, { get(target, key) {
      if (key === 'sendReport') return sendReport;
      if (key === 'addEventListener') return addEventListener;
      if (key === 'removeEventListener') return removeEventListener;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    facades.set(raw, facade);
    operations.set(facade, operation);
    return facade;
  }

  const operation = {
    id, name, signal: controller.signal, verifying: false,
    get error() { return error; },
    details, throwIfAborted, wait, native, cancel,
    snapshot: () => ({ operationId: id, operation: name, phase,
      status }),
    markWrite() { assertActive(); mayHaveWritten = true; },
    markWriteCompleted() { throwIfAborted(); writeCompleted = true; },
    progress(nextPhase, count, length) {
      if (error || done || disposed) return;
      phase = nextPhase; completed = count; total = length;
      notify('running');
    },
    complete() {
      throwIfAborted();
      if (done) return;
      done = true;
      detachDeadline();
      phase = 'complete'; completed = 1; total = 1;
      notify('completed');
    },
    failed(cause) {
      if (done || error) return;
      done = true;
      detachDeadline();
      notify('failed', cause.code ?? 'IO_ERROR');
    },
    delay(ms) {
      assertActive();
      return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(delayTimer); controller.signal.removeEventListener('abort', abort); };
        const abort = () => { cleanup(); reject(error); };
        const delayTimer = setTimeout(() => { cleanup(); resolve(); }, ms);
        controller.signal.addEventListener('abort', abort, { once: true });
      });
    },
    wrapDevice(device) {
      assertActive();
      if (facades.has(device)) return facades.get(device);
      const raw = wrapRaw(device.rawDevice);
      const facade = new Proxy(device, { get(target, key) {
        return key === 'rawDevice' ? raw : Reflect.get(target, key, target);
      } });
      facades.set(device, facade);
      operations.set(facade, operation);
      return facade;
    },
    async drain() {
      // WebHID cannot abort sendReport/open. Never overlap a cancelled transfer with the next job.
      while (nativePromises.size) await Promise.allSettled([...nativePromises]);
    },
    dispose() {
      disposed = true;
      detachDeadline();
      removeListeners();
    }
  };
  signal?.addEventListener('abort', externalAbort, { once: true });
  if (timeoutMs !== undefined) timer = setTimeout(() => cancel('TIMEOUT'), timeoutMs);
  if (signal?.aborted) externalAbort();
  return operation;
}
