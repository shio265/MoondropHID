// Stable public entry for GitHub Packages and browser/CDN imports.
export { createClient } from './client/client.js';
export { getSupportedDevices } from './devices/metadata.js';
export { isSupported } from './hid/transport.js';
export { inspectDevice } from './hid/inspection.js';
export { HidError } from './utils/errors.js';
export { setDebugLogger } from './utils/logger.js';
