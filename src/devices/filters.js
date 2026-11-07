// Adapt validated client data to a device's band count and legacy filter flags.
export function prepareFilters(filters, modelConfig, preamp, { logger = globalThis.console } = {}) {
  const console = logger;
  let filtersToWrite = [...filters];

  if (filtersToWrite.length > modelConfig.maxFilters) {
    console.warn(`USB Device PEQ: Truncating ${filtersToWrite.length} filters to ${modelConfig.maxFilters} (device limit)`);
    const enabledFilters = filtersToWrite.filter(f => !f.disabled);
    filtersToWrite = enabledFilters.length >= modelConfig.maxFilters
      ? enabledFilters.slice(0, modelConfig.maxFilters)
      : [
          ...enabledFilters,
          ...filtersToWrite.filter(f => f.disabled).slice(0, modelConfig.maxFilters - enabledFilters.length)
        ];
  }

  for (let i = 0; i < filtersToWrite.length; i++) {
    if (filtersToWrite[i].freq < 20 || filtersToWrite[i].freq > 20000) filtersToWrite[i].freq = 100;
    if (filtersToWrite[i].q < 0.01 || filtersToWrite[i].q > 100) filtersToWrite[i].q = 1;
  }

  const supportsLS = modelConfig.supportsLSFilter === true;
  const supportsHS = modelConfig.supportsHSFilter === true;
  const supportsLPHP = modelConfig.supportsLPHPFilters === true;
  const hasUnsupportedLS = filtersToWrite.some(f => f.type === 'LSQ' && f.gain !== 0) && !supportsLS;
  const hasUnsupportedHS = filtersToWrite.some(f => f.type === 'HSQ' && f.gain !== 0) && !supportsHS;
  const hasUnsupportedLPHP = filtersToWrite.some(f => f.type === 'LP' || f.type === 'HP') && !supportsLPHP;
  const needsPreGain = preamp < 0;

  for (let i = 0; i < filtersToWrite.length; i++) {
    const f = filtersToWrite[i];
    if ((f.type === 'LSQ' && !supportsLS) || (f.type === 'HSQ' && !supportsHS) ||
        ((f.type === 'LP' || f.type === 'HP') && !supportsLPHP)) {
      console.log(`USB Device PEQ: converting unsupported ${f.type} filter to PK with gain=0`);
      filtersToWrite[i] = { ...f, type: 'PK', gain: 0 };
    }
  }

  const hasUnsupportedShelfFilters = hasUnsupportedLS || hasUnsupportedHS;
  if (hasUnsupportedShelfFilters && needsPreGain && modelConfig.deviceHandlesPregain === true) {
    console.warn('Device handles pregain internally — host-computed pregain and unsupported shelf filters will be ignored');
  } else if (hasUnsupportedLS && hasUnsupportedHS) {
    console.warn('Device does not support LS or HS filters - ignoring');
  } else if (hasUnsupportedLS) {
    console.warn('Device does not support Low Shelf filters - ignoring');
  } else if (hasUnsupportedHS) {
    console.warn('Device does not support High Shelf filters - ignoring');
  } else if (needsPreGain && modelConfig.deviceHandlesPregain === true) {
    console.warn('Device handles pregain internally — host-computed pregain will not be written');
  }
  if (hasUnsupportedLPHP) console.warn('Device does not support LP/HP filters - ignoring');

  if (filtersToWrite.length < modelConfig.maxFilters && modelConfig.defaultResetFiltersValues) {
    const defaultFilter = modelConfig.defaultResetFiltersValues[0];
    console.log('USB Device PEQ: filling missing filters with defaults:', defaultFilter);
    for (let i = filtersToWrite.length; i < modelConfig.maxFilters; i++) {
      filtersToWrite.push({ ...defaultFilter });
    }
  }
  return filtersToWrite;
}
