import { compensateFreqForWrite, decompensateFreqFromRead,
  compensateQForWrite, decompensateQFromRead } from '../utils/compensation.js';
import { fail } from '../utils/errors.js';

const round = (value, scale) => Math.round(value * scale) / scale;

// Expected values are normalized through the protocol's write/read quantization,
// not compared with unrepresentable input floats. Coefficient/flash durability is not verified.
function expectedFilter(filter, protocol, config) {
  const type = filter.type ?? filter.filterType ?? 'PK';
  const { freq, gain, q } = filter;
  if (protocol === 'native') {
    return { type, freq, gain: round(gain, 256), q: round(q, 256), disabled: false };
  }
  if (protocol === 'walkplay') {
    if (filter.disabled) return { type: 'PK', freq: 0, gain: 0, q: 0, disabled: true };
    const writtenFreq = compensateFreqForWrite(freq, config, { label: 'WalkPlay' });
    const rawFreq = Math.trunc(writtenFreq) & 0xFFFF;
    const writtenQ = compensateQForWrite(q, gain, type, config, { label: 'WalkPlay', freq: writtenFreq });
    const decodedGain = round(round(gain, 256), 100);
    const decodedQ = round(round(writtenQ, 256), 100);
    return { type, freq: decompensateFreqFromRead(rawFreq, config), gain: decodedGain,
      q: decompensateQFromRead(decodedQ, decodedGain, type, config, { freq: rawFreq }), disabled: false };
  }
  if (protocol === 'register') {
    const factor = config.compensate2X ? 2 : 1;
    return { type, freq: Math.round(freq / factor) * factor,
      gain: round(filter.disabled ? 0 : gain, 10), q: round(q, 1000), disabled: false };
  }
  if (protocol === 'legacy') {
    return { type: 'PK', freq: Math.trunc(freq),
      gain: Math.max(-128, Math.min(127, Math.round(gain * 10))) / 10,
      q: round(q, 1000), disabled: false };
  }
  fail('UNSUPPORTED_OPERATION', `Read-back verification is not implemented for protocol: ${protocol}`);
}

export function compareReadback(filters, globalGain, slot, actual, info, modelConfig) {
  const protocol = info.protocol;
  const tolerances = protocol === 'native' ? { freq: 0.5, gain: 1 / 512, q: 1 / 512 }
    : protocol === 'walkplay' ? { freq: 0.5, gain: 0.005, q: 0.005 }
    : { freq: 0.5, gain: 0.05, q: 0.0005 };
  const differences = [];
  function compare(field, expected, received, tolerance) {
    const equal = tolerance === undefined ? expected === received
      : typeof received === 'number' && Number.isFinite(received) && Math.abs(expected - received) <= tolerance + 1e-8;
    if (!equal) differences.push({ field, expected,
      actual: ['string', 'boolean', 'number'].includes(typeof received) &&
        (typeof received !== 'number' || Number.isFinite(received)) ? received : null,
      ...(tolerance !== undefined ? { tolerance } : {}) });
  }
  compare('slot', slot, actual.slot);
  compare('filters.length', filters.length, actual.filters?.length);
  for (let i = 0; i < filters.length; i++) {
    const expected = expectedFilter(filters[i], protocol, modelConfig);
    const received = actual.filters?.[i];
    compare(`filters[${i}].disabled`, expected.disabled, received?.disabled === true);
    if (expected.disabled) continue; // Disabled WalkPlay bands have no active numeric parameters.
    compare(`filters[${i}].type`, expected.type, received?.type);
    for (const field of ['freq', 'gain', 'q']) {
      compare(`filters[${i}].${field}`, expected[field], received?.[field], tolerances[field]);
    }
  }
  if (info.limits.supportsManualGlobalGain) {
    compare('globalGain', protocol === 'native' ? round(globalGain, 256) : Math.round(globalGain),
      actual.globalGain, protocol === 'native' ? 1 / 512 : 0.5);
  }
  return differences;
}
