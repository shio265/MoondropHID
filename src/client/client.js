import { createConnector } from '../hid/connection.js';
import { isSupported } from '../hid/transport.js';
import { describe } from '../devices/metadata.js';
import { settingMethods } from '../config/settings.js';
import { HidError, fail } from '../utils/errors.js';
import { immutable } from '../utils/object.js';
import { prepareConfig, selectSlot, validateSetting } from './validation.js';
import { createOperation, operationOptions } from '../hid/operations.js';
import { buildExtras } from '../devices/settings.js';
import { prepareFilters } from '../devices/filters.js';
import { compareReadback } from '../devices/verification.js';
import { describeHidDevice } from '../devices/diagnostics.js';
import { createDiagnostics, summarizeError } from '../utils/diagnostics.js';

export function createClient({ hid, allowExperimental = false, diagnostics = false } = {}) {
  if (typeof allowExperimental !== 'boolean') fail('INVALID_CONFIG', 'allowExperimental must be a boolean.');
  const recorder = createDiagnostics(diagnostics);
  let lastDevice = null;
  let lastError = null;
  let activeOperation = null;
  let operationId = 0;
  const connector = createConnector({ hid, allowExperimental, throwErrors: true,
    logger: { log() {}, warn() {}, error() {} },
    onSelected(raw) { lastDevice = describeHidDevice(raw); } });
  let device = null;
  let info = null;
  let connecting = false;
  let pending = 0;
  let queue = Promise.resolve();
  let removeDisconnectListener = () => {};
  const listeners = new Set();

  function emit(event, isCurrent = () => true) {
    immutable(event);
    for (const listener of listeners) {
      if (!isCurrent()) break;
      try { listener(event); } catch (_) { /* Observers cannot break device I/O. */ }
    }
  }

  function rememberError(error, operation, id) {
    lastError = summarizeError(error, operation, id);
  }

  function rejectError(error, operation, id) {
    rememberError(error, operation, id);
    return Promise.reject(error);
  }

  function clear(reason) {
    const previous = info;
    if (device) lastDevice = describeHidDevice(device.rawDevice);
    removeDisconnectListener();
    removeDisconnectListener = () => {};
    device = null;
    info = null;
    connector.forgetDevice();
    if (reason === 'device-disconnected') activeOperation?.cancel('DEVICE_DISCONNECTED');
    if (previous) emit({ type: 'disconnected', device: previous, reason });
  }

  function enqueue(name, options, action, allowDisconnect = false) {
    if (connecting) return rejectError(new HidError('BUSY', 'Connection is still in progress.'), name);
    let controls;
    let operation;
    let id;
    try {
      controls = operationOptions(options);
      id = ++operationId;
      if (controls.signal?.aborted) {
        throw new HidError('ABORTED', 'Operation aborted.', { cause: controls.signal.reason,
          details: { operationId: id, operation: name, mayHaveWritten: false, writeCompleted: false, reportsSent: 0 } });
      }
      operation = createOperation({ id, name, ...controls, emit, record: recorder.record,
        onError(error) { rememberError(error, name, id); } });
    } catch (cause) {
      return rejectError(cause instanceof HidError ? cause
        : new HidError('INVALID_CONFIG', 'Invalid operation options.', { cause }), name, id);
    }
    pending++;
    const task = queue.then(async () => {
      let active;
      try {
        operation.throwIfAborted();
        if (!device) fail('NOT_CONNECTED', 'Connect a device first.');
        active = device;
        activeOperation = operation;
        const result = await action(active, operation, controls);
        operation.throwIfAborted();
        if (device !== active && !(allowDisconnect && result?.disconnected)) {
          fail('DEVICE_DISCONNECTED', 'The device disconnected during the operation.');
        }
        await operation.drain();
        operation.throwIfAborted();
        operation.complete();
        return result;
      } catch (cause) {
        // A cancelled reopen can still be settling; opened=false alone is not an unplug event.
        if (active && (cause?.code === 'DEVICE_DISCONNECTED' ||
            (!operation.error && active.rawDevice.opened === false))) clear('device-disconnected');
        const error = operation.error ?? (active && device !== active
          ? new HidError('DEVICE_DISCONNECTED', 'The device disconnected during the operation.', { cause })
          : cause instanceof HidError ? cause : new HidError('IO_ERROR', 'USB operation failed.',
            { cause, details: operation.details() }));
        rememberError(error, name, operation.id);
        operation.failed(error);
        throw error;
      } finally {
        await operation.drain();
        operation.dispose();
        if (activeOperation === operation) activeOperation = null;
      }
    }).finally(() => { pending--; });
    queue = task.catch(() => {});
    operation.progress('queued', 0, 1);
    return operation.wait(task);
  }

  async function readCurrentConfig(active, operation) {
    if (!info.capabilities.supportsRead) fail('UNSUPPORTED_READ', 'This device is write-only; it cannot provide a configuration backup.');
    operation.progress(operation.verifying ? 'verify' : 'read', 0, active.modelConfig.maxFilters);
    const slot = await operation.wait(connector.getCurrentSlot(active, operation));
    const result = await operation.wait(connector.pullFromDevice(active, slot, operation));
    operation.throwIfAborted();
    if (result?.globalGainError) {
      throw new HidError('INCOMPLETE_READ', 'The device did not return global gain.',
        { cause: result.globalGainError, details: { field: 'globalGain' } });
    }
    const count = result?.filters?.filter(Boolean).length ?? 0;
    if (result?.complete === false || count !== active.modelConfig.maxFilters) {
      fail('INCOMPLETE_READ', 'The device did not return all EQ bands.', { received: count, expected: active.modelConfig.maxFilters });
    }
    return {
      filters: result.filters.map(filter => ({ type: filter.type, freq: filter.freq,
        gain: filter.gain, q: filter.q, ...(filter.disabled !== undefined ? { disabled: filter.disabled } : {}) })),
      globalGain: result.globalGain ?? 0, slot, complete: true
    };
  }

  const client = {
    get connected() { return device !== null; },
    get device() { return info; },

    async connect() {
      if (connecting || pending) return rejectError(new HidError('BUSY', 'Another operation is in progress.'), 'connect');
      if (device) return info;
      const access = hid ?? globalThis.navigator?.hid;
      if (!hid && globalThis.isSecureContext === false) {
        return rejectError(new HidError('INSECURE_CONTEXT', 'WebHID requires HTTPS or localhost.'), 'connect');
      }
      if (!isSupported(access)) {
        return rejectError(new HidError('UNSUPPORTED_ENVIRONMENT', 'WebHID is not available. Use a supported desktop browser.'), 'connect');
      }
      connecting = true;
      try {
        // No await before the picker: preserve transient user activation.
        const selected = await connector.getDeviceConnected();
        if (selected?.cancelled) return null;
        if (selected?.unsupported) fail('UNSUPPORTED_DEVICE', 'This USB product is not in the supported registry.');
        if (!selected?.rawDevice) fail('CONNECTION_FAILED', 'Could not open the device.');
        device = selected;
        info = immutable({ ...describe(selected.model, selected.modelConfig, selected.handler),
          vendorId: selected.rawDevice.vendorId, productId: selected.rawDevice.productId });
        lastDevice = describeHidDevice(selected.rawDevice);
        const onDisconnect = event => {
          if (event.device === device?.rawDevice) clear('device-disconnected');
        };
        access.addEventListener?.('disconnect', onDisconnect);
        removeDisconnectListener = () => access.removeEventListener?.('disconnect', onDisconnect);
        connecting = false;
        emit({ type: 'connected', device: info });
        return info;
      } catch (cause) {
        if (cause?.name === 'NotFoundError' || cause?.name === 'AbortError') return null;
        const error = cause instanceof HidError ? cause
          : new HidError(cause?.code === 'EXPERIMENTAL_DEVICE' ? 'EXPERIMENTAL_DEVICE' : 'CONNECTION_FAILED',
            cause?.message ?? 'Could not connect to the device.', { cause });
        rememberError(error, 'connect');
        throw error;
      } finally {
        connecting = false;
      }
    },

    disconnect() {
      if (connecting) return rejectError(new HidError('BUSY', 'Connection is still in progress.'), 'disconnect');
      pending++;
      const task = queue.then(async () => {
        if (!device) return;
        try {
          await connector.disconnectDevice();
          clear('requested');
        } catch (cause) {
          const error = new HidError('IO_ERROR', 'Could not close the USB device.', { cause });
          rememberError(error, 'disconnect');
          throw error;
        }
      });
      queue = task.catch(() => {});
      return task.finally(() => { pending--; });
    },

    getCurrentSlot(options) {
      return enqueue('getCurrentSlot', options, async (active, operation) => {
        operation.progress('slot', 0, 1);
        const slot = await operation.wait(connector.getCurrentSlot(active, operation));
        operation.progress('slot', 1, 1);
        return slot;
      });
    },

    readConfig(options) {
      return enqueue('readConfig', options, readCurrentConfig);
    },

    writeConfig(input, options) {
      // Snapshot input before queueing so callers cannot change a pending write.
      let snapshot;
      try { snapshot = structuredClone(input); }
      catch (cause) {
        return rejectError(new HidError('INVALID_CONFIG', 'Configuration must contain plain serializable data.', { cause }), 'writeConfig');
      }
      return enqueue('writeConfig', options, async (active, operation, controls) => {
        const verify = controls.verify === undefined ? false : controls.verify;
        if (typeof verify !== 'boolean') fail('INVALID_CONFIG', 'verify must be a boolean.');
        const prepared = prepareConfig(snapshot, info);
        const slot = selectSlot(info, controls.slot);
        const manualGain = info.limits.supportsManualGlobalGain;
        operation.progress('write', 0, active.modelConfig.maxFilters);
        const disconnected = !!(await operation.wait(connector.pushToDevice(active, null, slot,
          manualGain ? prepared.globalGain : 0, prepared.filters, operation)));
        operation.markWriteCompleted();
        const result = { filtersWritten: active.modelConfig.maxFilters, slot,
          globalGainApplied: manualGain, disconnected, verified: false,
          verification: { status: 'not-requested', scope: 'read-back' } };
        if (disconnected) {
          if (verify) result.verification.status = 'device-reset';
          await connector.disconnectDevice();
          await operation.drain();
          operation.complete();
          clear('write-reset');
          return result;
        }
        if (verify && !info.capabilities.supportsRead) result.verification.status = 'unsupported-read';
        else if (verify) {
          operation.verifying = true;
          let actual;
          try { actual = await readCurrentConfig(active, operation); }
          catch (cause) {
            operation.throwIfAborted();
            if (cause?.code === 'DEVICE_DISCONNECTED') throw cause;
            throw new HidError('VERIFICATION_FAILED', 'Commands were sent, but read-back verification failed.',
              { cause, details: { ...operation.details(), verification: { status: 'read-failed', scope: 'read-back' } } });
          }
          const expected = prepareFilters(structuredClone(prepared.filters), active.modelConfig,
            manualGain ? prepared.globalGain : 0, { logger: { log() {}, warn() {} } });
          const differences = compareReadback(expected, prepared.globalGain, slot, actual, info, active.modelConfig);
          if (differences.length) {
            throw new HidError('VERIFICATION_FAILED', 'Read-back configuration does not match the write.',
              { details: { ...operation.details(), verification: { status: 'mismatch', scope: 'read-back', differences } } });
          }
          result.verified = true;
          result.verification.status = 'verified';
        }
        return result;
      }, true);
    },

    setEqEnabled(enabled, options) {
      return enqueue('setEqEnabled', options, async (active, operation, controls) => {
        if (typeof enabled !== 'boolean') fail('INVALID_CONFIG', 'enabled must be a boolean.');
        if (!info.capabilities.supportsEqToggle) fail('UNSUPPORTED_OPERATION', 'EQ bypass is not implemented for this protocol.');
        const slot = selectSlot(info, controls.slot);
        operation.progress('setting', 0, 1);
        operation.markWrite();
        await operation.wait(connector.enablePEQ(active, enabled, slot, operation));
        operation.markWriteCompleted();
        operation.progress('setting', 1, 1);
      });
    },

    readSetting(name, options) {
      return enqueue('readSetting', options, async (active, operation) => {
        if (!Object.hasOwn(settingMethods, name) || !info.capabilities.settings[name]?.readable) {
          fail('UNSUPPORTED_OPERATION', `Cannot read setting: ${name}`);
        }
        operation.progress('setting', 0, 1);
        const value = await operation.wait(buildExtras(active.handler, operation.wrapDevice(active))[name].get());
        operation.progress('setting', 1, 1);
        return value;
      });
    },

    writeSetting(name, value, options) {
      let snapshot;
      try { snapshot = structuredClone(value); }
      catch (cause) {
        return rejectError(new HidError('INVALID_CONFIG', 'Setting must be serializable.', { cause }), 'writeSetting');
      }
      return enqueue('writeSetting', options, async (active, operation) => {
        const capability = info.capabilities.settings[name];
        if (!Object.hasOwn(settingMethods, name) || !capability?.writable) fail('UNSUPPORTED_OPERATION', `Cannot write setting: ${name}`);
        validateSetting(name, snapshot, capability);
        operation.progress('setting', 0, 1);
        operation.markWrite();
        const extras = buildExtras(active.handler, operation.wrapDevice(active));
        if (name === 'dacBalance') await operation.wait(extras[name].set(snapshot.left, snapshot.right));
        else await operation.wait(extras[name].set(snapshot));
        operation.markWriteCompleted();
        operation.progress('setting', 1, 1);
      });
    },

    getDiagnostics(options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options) ||
          (options.includeLogs !== undefined && typeof options.includeLogs !== 'boolean')) {
        fail('INVALID_CONFIG', 'includeLogs must be a boolean.');
      }
      return immutable({ schemaVersion: 1,
        environment: { webHidSupported: isSupported(hid ?? globalThis.navigator?.hid),
          secureContext: typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : null },
        connected: client.connected, device: info,
        lastDevice: device ? describeHidDevice(device.rawDevice) : lastDevice,
        pendingOperations: pending, activeOperation: activeOperation?.snapshot() ?? null, lastError,
        logging: recorder.summary(), logs: options.includeLogs ? recorder.snapshot() : [] });
    },

    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Listener must be a function.');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  };
  return Object.freeze(client);
}
