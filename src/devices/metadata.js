import { usbHidDeviceHandlerConfig } from '../config/registry.js';
import { resolveConstraints, resolveExtras } from '../config/constraints.js';
import { settingMethods } from '../config/settings.js';
import { protocolIdFor } from '../handlers/index.js';
import { immutable } from '../utils/object.js';

export function describe(model, modelConfig, handler) {
  const limits = resolveConstraints(modelConfig);
  const protocol = protocolIdFor(handler);
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
