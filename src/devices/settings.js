import { resolveExtras } from '../config/constraints.js';
import { settingMethods } from '../config/settings.js';

function notImplemented(name) {
  return () => Promise.reject(
    Object.assign(new Error(`NOT_IMPLEMENTED: ${name}`), { code: 'NOT_IMPLEMENTED' })
  );
}

function capable(cfg, handler, device, capKey, getMethod, setMethod) {
  const capCfg = cfg?.[capKey] ?? {};
  const devCfg = device?.modelConfig?.[capKey] ?? {};
  const isSupported = (devCfg.supported !== undefined ? devCfg.supported : capCfg.supported) === true;
  const result = { supported: isSupported, ...capCfg, ...devCfg };
  delete result.handler;
  delete result.readHandler;
  delete result.note;
  if (getMethod) {
    result.get = isSupported && typeof handler?.[getMethod] === 'function'
      ? () => handler[getMethod](device)
      : notImplemented(`${capKey}.get`);
  }
  if (setMethod) {
    result.set = isSupported && typeof handler?.[setMethod] === 'function'
      ? (...args) => handler[setMethod](device, ...args)
      : notImplemented(`${capKey}.set`);
  }
  return result;
}

// Bind capabilities to the selected device, never to shared connection state.
export function buildExtras(handler, device) {
  const cfg = resolveExtras(device?.modelConfig) ?? {};
  const h = handler ?? {};
  return Object.fromEntries(Object.entries(settingMethods).map(([name, [getter, setter]]) => [
    name,
    name === 'outputGain' ? {
      supported: typeof h.setOutputGain === 'function',
      set: typeof h.setOutputGain === 'function'
        ? gainDb => h.setOutputGain(device, gainDb)
        : notImplemented('outputGain.set')
    } : capable(cfg, h, device, name, getter, setter)
  ]));
}
