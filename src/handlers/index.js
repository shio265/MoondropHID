import { nativeProtocol } from './native.js';
import { walkplayProtocol } from './walkplay.js';
import { registerProtocol } from './register.js';
import { legacyProtocol } from './legacy.js';
import { conexantProtocol } from './conexant.js';

export { nativeProtocol, walkplayProtocol, registerProtocol, legacyProtocol, conexantProtocol };

const handlers = new Map([
  [nativeProtocol, { id: 'native', name: 'moondropUsbHidHandler' }],
  [walkplayProtocol, { id: 'walkplay', name: 'walkplayUsbHID' }],
  [registerProtocol, { id: 'register', name: 'ktmicroUsbHidHandler' }],
  [legacyProtocol, { id: 'legacy', name: 'oldFashionedUsbHidHandler' }],
  [conexantProtocol, { id: 'conexant', name: 'conexantUsbHidHandler' }]
]);

export function handlerNameFor(handler) {
  return handlers.get(handler)?.name ?? null;
}

export function protocolIdFor(handler) {
  return handlers.get(handler)?.id;
}
