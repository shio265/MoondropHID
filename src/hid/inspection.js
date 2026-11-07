import { isSupported } from './transport.js';
import { describeHidDevice } from '../devices/diagnostics.js';
import { HidError, fail } from '../utils/errors.js';

// Call directly from a user click. Inspection never opens HID or sends a protocol command.
export async function inspectDevice({ hid } = {}) {
  if (!hid && globalThis.isSecureContext === false) fail('INSECURE_CONTEXT', 'WebHID requires HTTPS or localhost.');
  const access = hid ?? globalThis.navigator?.hid;
  if (!isSupported(access)) fail('UNSUPPORTED_ENVIRONMENT', 'WebHID is not available.');
  try {
    const devices = await access.requestDevice({ filters: [] });
    return devices[0] ? describeHidDevice(devices[0]) : null;
  } catch (cause) {
    if (cause?.name === 'NotFoundError' || cause?.name === 'AbortError') return null;
    if (cause instanceof HidError) throw cause;
    throw new HidError('CONNECTION_FAILED', 'Could not inspect the selected HID device.', { cause });
  }
}
