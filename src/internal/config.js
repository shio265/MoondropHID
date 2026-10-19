// Moondrop HID by shio265.
// Moondrop-only USB device configuration.
// Shared chipset vendor IDs are not proof that a device is made by Moondrop.
// The connector therefore requires an explicit productName match in this registry.

import {
  nativeProtocol, walkplayProtocol, legacyProtocol, conexantProtocol, registerProtocol
} from './protocols.js';

export const usbHidDeviceHandlerConfig = [
  {
    vendorIds: [0x0104, 0x011B, 0x011D, 0x0661, 0x0663, 0x0666, 0x0762, 0x0D8C, 0x2FC6, 0x3302, 0x34BE, 0x35D8, 0x36A7, 0x373B, 0x60C1, 0x60E1, 0xB445, 0xB44D],
    manufacturer: 'Moondrop',
    handler: walkplayProtocol,
    defaultModelConfig: {
      peqConstraintsRef: 'walkplayPeq8Band10dBPkOnly',
      schemeNo: 10,
      firstWritableEQSlot: 101,
      maxWritableEQSlots: 1,
      disconnectOnSave: false,
      defaultResetFiltersValues: [{ gain: 0, freq: 100, q: 1, filterType: 'PK' }],
      deviceHandlesPregain: false,
      experimental: false,
      availableSlots: [{ id: 101, name: 'Custom' }],
      dacWorkMode: { modes: [0, 1], modeLabels: ['Class H', 'Class AB'] }
    },
    // Only entries explicitly labelled manufacturer: "Moondrop" upstream.
    // Some USB names are OEM/alias names rather than retail Moondrop model names.
    devices: {
      'Old Fashioned': {
        manufacturer: 'Moondrop',
        handler: legacyProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq5Band3dBCeilingPkOnly',
          firstWritableEQSlot: -1,
          maxWritableEQSlots: 0,
          disconnectOnSave: false,
          disabledPresetId: -1,
          experimental: false,
          defaultResetFiltersValues: [{ gain: 0, freq: 100, q: 1, filterType: 'PK' }],
          availableSlots: [{ id: 0, name: 'Custom' }]
        }
      },
      'Rays': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq8Band12dBFullShelves',
          peqConstraintsOverride: { deviceHandlesPregain: true, supportsLSFilter: false, supportsHSFilter: false }
        }
      },
      'Marigold': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band6dBPkOnly' }
      },
      'MOONDROP Marigold': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band6dBPkOnly' }
      },
      'FreeDSP Pro': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq8Band12dBFullShelves',
          peqConstraintsOverride: { deviceHandlesPregain: true }
        }
      },
      'MOONRIVER 3': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq8Band12dBFullShelves',
          peqConstraintsOverride: { deviceHandlesPregain: true }
        }
      },
      'FreeDSP Mini': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band12dBFullShelves' }
      },
      'FreeDSP': {
        manufacturer: 'Moondrop',
        handler: conexantProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq9Band12dBFullShelves',
          supportsLSFilter: true,
          supportsHSFilter: true,
          deviceHandlesPregain: false,
          maxFilters: 9
        }
      },
      'DAWN PRO2': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band12dBFullShelves' }
      },
      'Echo A': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq8Band12dBFullShelves',
          peqConstraintsOverride: { supportsLSFilter: false, supportsHSFilter: false }
        }
      },
      'ECHO-B': {
        manufacturer: 'Moondrop',
        handler: conexantProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq9Band12dBFullShelves',
          supportsLSFilter: true,
          supportsHSFilter: true,
          deviceHandlesPregain: false,
          maxFilters: 9
        }
      },
      'AG Rays': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: {
          peqConstraintsRef: 'peq8Band12dBFullShelves',
          peqConstraintsOverride: { supportsLSFilter: false, supportsHSFilter: false }
        }
      },
      'DHA15': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band12dBFullShelves' }
      },
      'Deco Audio System': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band12dBFullShelves' }
      },
      'INN Deco75-DH Audio': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol,
        modelConfig: { peqConstraintsRef: 'peq8Band12dBFullShelves' }
      },
      'ddHiFi DSP IEM - Memory': {
        manufacturer: 'Moondrop',
        handler: nativeProtocol
      },
      'MD-QT-042': {
        manufacturer: 'Moondrop',
        modelConfig: {
          peqConstraintsRef: 'walkplayPeq8Band10dBFullShelves',
          schemeNo: 15,
          experimental: true
        }
      },
      'MOONDROP HiFi with PD': {
        manufacturer: 'Moondrop',
        modelConfig: {
          peqConstraintsRef: 'walkplayPeq8Band10dBFullShelves',
          schemeNo: 15,
          experimental: true
        }
      },
      'DAWN PRO 2': {
        manufacturer: 'Moondrop',
        modelConfig: {
          peqConstraintsRef: 'walkplayPeq8Band10dBFullShelves',
          schemeNo: 15,
          experimental: false
        }
      }
    }
  },
  {
    vendorIds: [0x31B2],
    manufacturer: 'Moondrop',
    handler: registerProtocol,
    defaultModelConfig: {
      peqConstraintsRef: 'peq5Band12dBFullShelvesNoPregain',
      firstWritableEQSlot: -1,
      maxWritableEQSlots: 0,
      compensate2X: true,
      disconnectOnSave: false,
      disabledPresetId: 0x02,
      experimental: false,
      defaultResetFiltersValues: [{ gain: 0, freq: 100, q: 1, filterType: 'PK' }],
      availableSlots: [{ id: 0x03, name: 'Custom' }]
    },
    devices: {
      'CDSP': {
        manufacturer: 'Moondrop',
        modelConfig: {
          peqConstraintsRef: 'peq5Band12dBFullShelvesNoPregain',
          compensate2X: false
        }
      },
      'Chu2 DSP': {
        manufacturer: 'Moondrop',
        modelConfig: {
          peqConstraintsRef: 'peq5Band12dBFullShelvesNoPregain',
          compensate2X: false
        }
      }
    }
  }
];

const HANDLER_NAMES = new Map([
  // Preserve diagnostic IDs used by existing callers; file/export names are generic.
  [walkplayProtocol, 'walkplayUsbHID'],
  [nativeProtocol, 'moondropUsbHidHandler'],
  [legacyProtocol, 'oldFashionedUsbHidHandler'],
  [conexantProtocol, 'conexantUsbHidHandler'],
  [registerProtocol, 'ktmicroUsbHidHandler']
]);

export function handlerNameFor(handler) {
  return HANDLER_NAMES.get(handler) ?? null;
}

// Constraint data and lookup now live with the registry instead of a separate
// JSON fetch. Values, per-model overrides and capability descriptors are unchanged.
const constraintDefaults = {
  supportsLPFilter: false,
  supportsHPFilter: false,
  supportsBPFilter: false,
  supportsNotchFilter: false,
  supportsAllPassFilter: false,
  supportsBandStopFilter: false,
  supportsConstantQFilter: false,
  minQ: 0.1,
  maxQ: 10
};

function profile(description, values, deviceNames, extras) {
  return {
    description,
    peqConstraints: { ...constraintDefaults, ...values },
    deviceNames,
    deviceGroupNames: [],
    ...(extras ? { extras } : {})
  };
}

function walkplayExtras() {
  return {
    dacFilter: { supported: true, options: ['FAST-LL', 'FAST-PC', 'SLOW-LL', 'SLOW-PC', 'NON-OS'] },
    dacBalance: { supported: true },
    dacWorkMode: { supported: true },
    gainMode: { supported: false },
    micGain: { supported: true, minDb: -15, maxDb: 15 },
    denoise: { supported: false }
  };
}

const constraintsConfig = {
  version: '1.1.0',
  constraints: {
    peq5Band3dBCeilingPkOnly: profile(
      '5-band peak-only PEQ, -12/+3 dB asymmetric range, no shelf filters, no pregain',
      { minGain: -12, maxGain: 3, maxFilters: 5, supportsLSFilter: false,
        supportsHSFilter: false, deviceHandlesPregain: true, supportsManualGlobalGain: false },
      ['Old Fashioned']
    ),
    peq8Band6dBPkOnly: profile(
      '8-band peak-only PEQ, -12/+6 dB, no shelf or LP/HP filters, pregain',
      { minGain: -12, maxGain: 6, maxFilters: 8, supportsLSFilter: false,
        supportsHSFilter: false, deviceHandlesPregain: false, supportsManualGlobalGain: true, supportsRead: true },
      ['Marigold', 'MOONDROP Marigold']
    ),
    peq8Band12dBFullShelves: profile(
      '8-band PEQ, ±12 dB, low-shelf + high-shelf, pregain',
      { minGain: -12, maxGain: 12, maxFilters: 8, supportsLSFilter: true,
        supportsHSFilter: true, deviceHandlesPregain: false, supportsManualGlobalGain: true, supportsRead: true },
      ['Rays', 'FreeDSP Pro', 'FreeDSP Mini', 'MOONRIVER 3', 'DAWN PRO2',
        'DHA15', 'Deco Audio System', 'INN Deco75-DH Audio', 'Echo A', 'AG Rays']
    ),
    peq9Band12dBFullShelves: profile(
      '9-band PEQ, ±12 dB, low-shelf + high-shelf, pregain (write-only)',
      { minGain: -12, maxGain: 12, maxFilters: 9, supportsLSFilter: true,
        supportsHSFilter: true, deviceHandlesPregain: false, supportsManualGlobalGain: true, supportsRead: false },
      ['FreeDSP', 'ECHO-B']
    ),
    walkplayPeq8Band10dBPkOnly: profile(
      'WalkPlay 8-band PEQ, ±10 dB, peak-only (no shelf or LP/HP filters), pregain',
      { minGain: -10, maxGain: 10, maxFilters: 8, supportsLSFilter: false,
        supportsHSFilter: false, deviceHandlesPregain: false, supportsManualGlobalGain: true, supportsRead: true },
      ['ddHiFi DSP IEM - Memory'], walkplayExtras()
    ),
    walkplayPeq8Band10dBFullShelves: profile(
      'WalkPlay 8-band PEQ, ±10 dB, full shelves (LS+HS), pregain — SchemeNo15',
      { minGain: -10, maxGain: 10, maxFilters: 8, supportsLSFilter: true,
        supportsHSFilter: true, deviceHandlesPregain: false, supportsManualGlobalGain: true, supportsRead: true },
      ['MD-QT-042', 'MOONDROP HiFi with PD', 'DAWN PRO 2'], walkplayExtras()
    ),
    peq5Band12dBFullShelvesNoPregain: profile(
      '5-band PEQ, ±10 dB, Q 0.1-5.0, low-shelf + high-shelf, no pregain (KT Micro chip limits)',
      { minGain: -10, maxGain: 10, maxFilters: 5, supportsLSFilter: true,
        supportsHSFilter: true, deviceHandlesPregain: true, supportsManualGlobalGain: false, maxQ: 5 },
      ['CDSP', 'Chu2 DSP']
    )
  }
};

// Async compatibility for existing callers; configuration is already bundled.
export async function loadPeqConstraintsConfig() {
  return constraintsConfig;
}

export function getPeqConstraintsConfig() {
  return constraintsConfig;
}

export function getConstraintsByRef(refName) {
  const entry = constraintsConfig.constraints[refName];
  return entry ? { ...entry.peqConstraints } : null;
}

export function getAllConstraintRefs() {
  return Object.keys(constraintsConfig.constraints);
}

export function getConstraintEntry(refName) {
  const entry = constraintsConfig.constraints[refName];
  return entry ? { refName, ...entry } : null;
}

export function findConstraintsByDeviceName(deviceName, { partial = false } = {}) {
  const query = partial ? deviceName.toLowerCase() : deviceName;
  for (const [refName, entry] of Object.entries(constraintsConfig.constraints)) {
    const match = entry.deviceNames?.some(d =>
      partial ? d.toLowerCase().includes(query) : d === deviceName
    );
    if (match) return { refName, ...entry.peqConstraints };
  }
  return null;
}

export function findConstraintsByDeviceGroupName(groupName, { partial = false } = {}) {
  const query = partial ? groupName.toLowerCase() : groupName;
  for (const [refName, entry] of Object.entries(constraintsConfig.constraints)) {
    const match = entry.deviceGroupNames?.some(g =>
      partial ? g.toLowerCase().includes(query) : g === groupName
    );
    if (match) return { refName, ...entry.peqConstraints };
  }
  return null;
}

export function searchDevices(query) {
  const q = query.toLowerCase();
  const results = [];
  for (const [refName, entry] of Object.entries(constraintsConfig.constraints)) {
    const matchedDevices = (entry.deviceNames || []).filter(d => d.toLowerCase().includes(q));
    const matchedGroups = (entry.deviceGroupNames || []).filter(g => g.toLowerCase().includes(q));
    if (matchedDevices.length || matchedGroups.length) {
      results.push({ refName, description: entry.description,
        peqConstraints: { ...entry.peqConstraints },
        matchedDeviceNames: matchedDevices, matchedDeviceGroupNames: matchedGroups });
    }
  }
  return results;
}

export function getExtras(refName) {
  const entry = constraintsConfig.constraints[refName];
  return entry?.extras ? { ...entry.extras } : null;
}

export function resolveExtras(modelConfig) {
  return modelConfig?.peqConstraintsRef ? getExtras(modelConfig.peqConstraintsRef) : null;
}

export function resolveConstraints(modelConfig) {
  if (!modelConfig) return null;
  if (modelConfig.peqConstraintsRef) {
    const resolved = getConstraintsByRef(modelConfig.peqConstraintsRef);
    if (resolved) {
      return modelConfig.peqConstraintsOverride
        ? { ...resolved, ...modelConfig.peqConstraintsOverride }
        : resolved;
    }
  }
  const {
    minGain, maxGain, maxFilters, minQ, maxQ, supportsLSFilter, supportsHSFilter,
    supportsLPFilter, supportsHPFilter, supportsLPHPFilters, supportsBPFilter,
    supportsNotchFilter, supportsBandStopFilter, supportsConstantQFilter,
    supportsAllPassFilter, deviceHandlesPregain, supportsManualGlobalGain, supportedFilterTypes
  } = modelConfig;
  return {
    minGain, maxGain, maxFilters, minQ: minQ ?? 0.1, maxQ: maxQ ?? 10,
    supportsLSFilter, supportsHSFilter,
    supportsLPFilter: supportsLPFilter ?? supportsLPHPFilters ?? false,
    supportsHPFilter: supportsHPFilter ?? supportsLPHPFilters ?? false,
    supportsBPFilter: supportsBPFilter ?? false,
    supportsNotchFilter: supportsNotchFilter ?? false,
    supportsBandStopFilter: supportsBandStopFilter ?? false,
    supportsConstantQFilter: supportsConstantQFilter ?? false,
    supportsAllPassFilter: supportsAllPassFilter ?? false,
    deviceHandlesPregain, supportsManualGlobalGain, supportedFilterTypes
  };
}
