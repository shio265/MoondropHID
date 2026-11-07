// Bundled PEQ profiles and lookups; no network fetch is required.
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

// Async compatibility for reference tooling; configuration is already bundled.
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
