import { fail } from '../utils/errors.js';

function numberInRange(value, min, max, field, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max ||
      (integer && !Number.isInteger(value))) {
    fail('INVALID_CONFIG', `${field} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}].`, { field });
  }
  return value;
}

export function prepareConfig(input, info) {
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

export function selectSlot(info, requested) {
  const slot = requested ?? info.slots[0]?.id;
  if (!Number.isInteger(slot) || !info.slots.some(item => item.id === slot)) {
    fail('INVALID_CONFIG', 'Choose a writable slot from device.slots.', { slot });
  }
  return slot;
}

export function validateSetting(name, value, capability) {
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
