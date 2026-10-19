import { createConnector } from './internal/connection.js';
import { usbHidDeviceHandlerConfig, resolveConstraints, resolveExtras } from './internal/config.js';
import { nativeProtocol, walkplayProtocol, registerProtocol, legacyProtocol,
  conexantProtocol } from './internal/protocols.js';

export { setDebugLogger } from './internal/protocols.js';

const protocolIds = new Map([
  [nativeProtocol, 'native'], [walkplayProtocol, 'walkplay'],
  [registerProtocol, 'register'], [legacyProtocol, 'legacy'], [conexantProtocol, 'conexant']
]);

const settingMethods = {
  micGain: ['readMicGain', 'setMicGain'],
  denoise: ['readDenoiseEnabled', 'setDenoiseEnabled'],
  dacFilter: ['readDacFilter', 'setDacFilter'],
  dacBalance: [null, 'setDacBalance'],
  dacWorkMode: ['readDacWorkMode', 'setDacWorkMode'],
  gainMode: ['readGainMode', 'setGainMode'],
  battery: ['readBattery', null],
  eqEnabled: ['readEqEnabled', 'setEqEnabled'],
  outputGain: [null, 'setOutputGain']
};

export class HidError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message, { cause });
    this.name = 'HidError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new HidError(code, message, { details });
}

function immutable(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function describe(model, modelConfig, handler) {
  const limits = resolveConstraints(modelConfig);
  const protocol = protocolIds.get(handler);
  const settings = {};
  const extras = resolveExtras(modelConfig) ?? {};
  for (const [name, [getter, setter]] of Object.entries(settingMethods)) {
    const config = { ...extras[name], ...modelConfig[name] };
    const supported = name === 'outputGain'
      ? typeof handler.setOutputGain === 'function' : config.supported === true;
    if (!supported) continue;
    settings[name] = {
      readable: !!getter && typeof handler[getter] === 'function',
      writable: !!setter && typeof handler[setter] === 'function',
      ...(config.options ? { options: [...config.options] } : {}),
      ...(config.modes ? { modes: [...config.modes] } : {}),
      ...(config.minDb !== undefined ? { min: config.minDb, max: config.maxDb } : {})
    };
  }
  const slots = protocol === 'native' ? [{ id: 7, name: 'Custom' }]
    : protocol === 'conexant' ? [{ id: 0, name: 'Custom' }]
    : (modelConfig.availableSlots ?? []).map(slot => ({ ...slot }));
  return immutable({
    model,
    protocol,
    experimental: modelConfig.experimental === true,
    slots,
    limits: {
      maxFilters: limits.maxFilters,
      minGain: limits.minGain,
      maxGain: limits.maxGain,
      minQ: limits.minQ,
      maxQ: limits.maxQ,
      filterTypes: ['PK', ...(limits.supportsLSFilter ? ['LSQ'] : []), ...(limits.supportsHSFilter ? ['HSQ'] : [])],
      deviceHandlesPregain: limits.deviceHandlesPregain === true,
      supportsManualGlobalGain: protocol !== 'conexant' && limits.deviceHandlesPregain !== true &&
        limits.supportsManualGlobalGain === true
    },
    capabilities: {
      supportsRead: limits.supportsRead !== false,
      supportsEqToggle: protocol === 'walkplay' || protocol === 'register',
      settings
    }
  });
}

export function getSupportedDevices() {
  return immutable(usbHidDeviceHandlerConfig.flatMap(vendor =>
    Object.entries(vendor.devices).map(([model, entry]) => ({
      ...describe(model, { ...vendor.defaultModelConfig, ...entry.modelConfig }, entry.handler ?? vendor.handler),
      vendorIds: [...vendor.vendorIds]
    }))
  ));
}

export function isSupported(hid = globalThis.navigator?.hid) {
  return !!hid && typeof hid.requestDevice === 'function' && typeof hid.getDevices === 'function';
}

function numberInRange(value, min, max, field, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max ||
      (integer && !Number.isInteger(value))) {
    fail('INVALID_CONFIG', `${field} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}].`, { field });
  }
  return value;
}

function prepareConfig(input, info) {
  if (!input || !Array.isArray(input.filters) || input.filters.length === 0 ||
      input.filters.length > info.limits.maxFilters) {
    fail('INVALID_CONFIG', `Provide between 1 and ${info.limits.maxFilters} filters.`);
  }
  const filters = Array.from(input.filters, (filter, index) => {
    if (!filter || typeof filter !== 'object' ||
        (filter.disabled !== undefined && typeof filter.disabled !== 'boolean')) {
      fail('INVALID_CONFIG', `Invalid filter at index ${index}.`);
    }
    if (filter.disabled === true) return { type: 'PK', freq: 100, gain: 0, q: 1, disabled: true };
    if (!info.limits.filterTypes.includes(filter.type)) {
      fail('INVALID_CONFIG', `Unsupported filter type at index ${index}: ${filter.type}`);
    }
    return {
      type: filter.type,
      freq: numberInRange(filter.freq, 20, 20000, `filters[${index}].freq`, true),
      gain: numberInRange(filter.gain, info.limits.minGain, info.limits.maxGain, `filters[${index}].gain`),
      q: numberInRange(filter.q, info.limits.minQ, info.limits.maxQ, `filters[${index}].q`),
      ...(filter.disabled !== undefined ? { disabled: filter.disabled } : {})
    };
  });
  const globalGain = numberInRange(input.globalGain === undefined ? 0 : input.globalGain, -128, 127, 'globalGain');
  if (globalGain !== 0 && !info.limits.supportsManualGlobalGain && !info.limits.deviceHandlesPregain) {
    fail('UNSUPPORTED_OPERATION', 'This protocol cannot write global gain.');
  }
  return { filters, globalGain };
}

function selectSlot(info, requested) {
  const slot = requested ?? info.slots[0]?.id;
  if (!Number.isInteger(slot) || !info.slots.some(item => item.id === slot)) {
    fail('INVALID_CONFIG', 'Choose a writable slot from device.slots.', { slot });
  }
  return slot;
}

function validateSetting(name, value, capability) {
  if (name === 'dacBalance') {
    if (!value || typeof value !== 'object') fail('INVALID_CONFIG', 'dacBalance requires { left, right }.');
    numberInRange(value.left, 0, 127, 'dacBalance.left', true);
    numberInRange(value.right, 0, 127, 'dacBalance.right', true);
    if (value.left > 0 && value.right > 0) fail('INVALID_CONFIG', 'Boost at most one balance channel at a time.');
  } else if (name === 'dacFilter') {
    if (!capability.options?.includes(value)) fail('INVALID_CONFIG', 'Choose a DAC filter from the supported options.');
  } else if (name === 'dacWorkMode') {
    if (!(capability.modes ?? [0, 1]).includes(value)) fail('INVALID_CONFIG', 'Unsupported DAC work mode.');
  } else if (name === 'micGain') {
    numberInRange(value, capability.min ?? -15, capability.max ?? 15, name);
  } else if (name === 'outputGain') {
    numberInRange(value, -10, 10, name, true);
  } else if (typeof value !== 'boolean') {
    fail('INVALID_CONFIG', `${name} must be a boolean.`);
  }
}

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
