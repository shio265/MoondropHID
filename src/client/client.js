import { createConnector } from '../hid/connection.js';
import { isSupported } from '../hid/transport.js';
import { describe } from '../devices/metadata.js';
import { settingMethods } from '../config/settings.js';
import { HidError, fail } from '../utils/errors.js';
import { immutable } from '../utils/object.js';
import { prepareConfig, selectSlot, validateSetting } from './validation.js';

export function createClient({ hid, allowExperimental = false } = {}) {
  if (typeof allowExperimental !== 'boolean') fail('INVALID_CONFIG', 'allowExperimental must be a boolean.');
  const connector = createConnector({ hid, allowExperimental, throwErrors: true,
    logger: { log() {}, warn() {}, error() {} } });
  let device = null;
  let info = null;
  let connecting = false;
  let pending = 0;
  let queue = Promise.resolve();
  let removeDisconnectListener = () => {};
  const listeners = new Set();

  function emit(event) {
    for (const listener of listeners) {
      try { listener(immutable(event)); } catch (_) { /* Observers cannot break device I/O. */ }
    }
  }

  function clear(reason) {
    const previous = info;
    removeDisconnectListener();
    removeDisconnectListener = () => {};
    device = null;
    info = null;
    connector.forgetDevice();
    if (previous) emit({ type: 'disconnected', device: previous, reason });
  }

  function enqueue(action, allowDisconnect = false) {
    if (connecting) return Promise.reject(new HidError('BUSY', 'Connection is still in progress.'));
    pending++;
    const task = queue.then(async () => {
      if (!device) fail('NOT_CONNECTED', 'Connect a device first.');
      const active = device;
      try {
        const result = await action(active);
        if (device !== active && !(allowDisconnect && result?.disconnected)) {
          fail('DEVICE_DISCONNECTED', 'The device disconnected during the operation.');
        }
        return result;
      } catch (cause) {
        if (cause?.code === 'DEVICE_DISCONNECTED' || active.rawDevice.opened === false) clear('device-disconnected');
        if (device !== active) throw new HidError('DEVICE_DISCONNECTED', 'The device disconnected during the operation.', { cause });
        if (cause instanceof HidError) throw cause;
        throw new HidError(device === active ? 'IO_ERROR' : 'DEVICE_DISCONNECTED',
          'USB operation failed.', { cause });
      }
    });
    queue = task.catch(() => {});
    return task.finally(() => { pending--; });
  }

  const client = {
    get connected() { return device !== null; },
    get device() { return info; },

    async connect() {
      if (connecting || pending) fail('BUSY', 'Another operation is in progress.');
      if (device) return info;
      const access = hid ?? globalThis.navigator?.hid;
      if (!hid && globalThis.isSecureContext === false) fail('INSECURE_CONTEXT', 'WebHID requires HTTPS or localhost.');
      if (!isSupported(access)) fail('UNSUPPORTED_ENVIRONMENT', 'WebHID is not available. Use a supported desktop browser.');
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
        const onDisconnect = event => {
          if (event.device === device?.rawDevice) clear('device-disconnected');
        };
        access.addEventListener?.('disconnect', onDisconnect);
        removeDisconnectListener = () => access.removeEventListener?.('disconnect', onDisconnect);
        connecting = false;
        emit({ type: 'connected', device: info });
        return info;
      } catch (cause) {
        if (cause instanceof HidError) throw cause;
        if (cause?.name === 'NotFoundError' || cause?.name === 'AbortError') return null;
        throw new HidError(cause?.code === 'EXPERIMENTAL_DEVICE' ? 'EXPERIMENTAL_DEVICE' : 'CONNECTION_FAILED',
          cause?.message ?? 'Could not connect to the device.', { cause });
      } finally {
        connecting = false;
      }
    },

    disconnect() {
      if (connecting) return Promise.reject(new HidError('BUSY', 'Connection is still in progress.'));
      pending++;
      const task = queue.then(async () => {
        if (!device) return;
        try {
          await connector.disconnectDevice();
          clear('requested');
        } catch (cause) {
          throw new HidError('IO_ERROR', 'Could not close the USB device.', { cause });
        }
      });
      queue = task.catch(() => {});
      return task.finally(() => { pending--; });
    },

    getCurrentSlot() {
      return enqueue(active => connector.getCurrentSlot(active));
    },

    readConfig() {
      return enqueue(async active => {
        if (!info.capabilities.supportsRead) fail('UNSUPPORTED_READ', 'This device is write-only; it cannot provide a configuration backup.');
        const slot = await connector.getCurrentSlot(active);
        const result = await connector.pullFromDevice(active, slot);
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
      });
    },

    writeConfig(input, { slot: requestedSlot } = {}) {
      // Snapshot input before queueing so callers cannot change a pending write.
      let snapshot;
      try { snapshot = structuredClone(input); }
      catch (cause) { return Promise.reject(new HidError('INVALID_CONFIG', 'Configuration must contain plain serializable data.', { cause })); }
      return enqueue(async active => {
        const prepared = prepareConfig(snapshot, info);
        const slot = selectSlot(info, requestedSlot);
        const manualGain = info.limits.supportsManualGlobalGain;
        const disconnected = !!(await connector.pushToDevice(active, null, slot,
          manualGain ? prepared.globalGain : 0, prepared.filters));
        if (disconnected) {
          await connector.disconnectDevice();
          clear('write-reset');
        }
        return { filtersWritten: active.modelConfig.maxFilters, slot,
          globalGainApplied: manualGain, disconnected, verified: false };
      }, true);
    },

    setEqEnabled(enabled, { slot: requestedSlot } = {}) {
      return enqueue(async active => {
        if (typeof enabled !== 'boolean') fail('INVALID_CONFIG', 'enabled must be a boolean.');
        if (!info.capabilities.supportsEqToggle) fail('UNSUPPORTED_OPERATION', 'EQ bypass is not implemented for this protocol.');
        const slot = selectSlot(info, requestedSlot);
        await connector.enablePEQ(active, enabled, slot);
      });
    },

    readSetting(name) {
      return enqueue(active => {
        if (!Object.hasOwn(settingMethods, name) || !info.capabilities.settings[name]?.readable) {
          fail('UNSUPPORTED_OPERATION', `Cannot read setting: ${name}`);
        }
        return active.extras[name].get();
      });
    },

    writeSetting(name, value) {
      let snapshot;
      try { snapshot = structuredClone(value); }
      catch (cause) { return Promise.reject(new HidError('INVALID_CONFIG', 'Setting must be serializable.', { cause })); }
      return enqueue(async active => {
        const capability = info.capabilities.settings[name];
        if (!Object.hasOwn(settingMethods, name) || !capability?.writable) fail('UNSUPPORTED_OPERATION', `Cannot write setting: ${name}`);
        validateSetting(name, snapshot, capability);
        if (name === 'dacBalance') await active.extras[name].set(snapshot.left, snapshot.right);
        else await active.extras[name].set(snapshot);
      });
    },

    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Listener must be a function.');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  };
  return Object.freeze(client);
}
