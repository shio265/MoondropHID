import { createClient, getSupportedDevices, inspectDevice, HidError, type EqConfigInput,
  type HidAccess, type SettingValues, type ErrorCode, type OperationOptions,
  type OperationProgress, type WriteOptions, type DiagnosticsReport, type DeviceInspection,
  type VerificationDifference } from '../../dist/index.js';

const client = createClient();
const config: EqConfigInput = { filters: [{ type: 'PK', freq: 1000, q: 1, gain: -3 }] };
const products = getSupportedDevices();
const optionalName: string | undefined = products[0]?.model;
void optionalName;

async function consume(hid: HidAccess) {
  const device = await createClient({ hid }).connect();
  if (device) {
    const count: number = device.limits.maxFilters;
    const protocol: string = device.protocol;
    void [count, protocol];
  }
  const result = await client.writeConfig(config, { slot: 7 });
  const verified: false = result.verified;
  const defaultVerified: false = (await client.writeConfig(config)).verified;
  const controller = new AbortController();
  const controls: OperationOptions = { signal: controller.signal, timeoutMs: 10000,
    onProgress(event: OperationProgress) {
      const count: number = event.completed;
      const phase: string = event.phase;
      void [count, phase];
    } };
  const optIn = await client.writeConfig(config, { ...controls, verify: true });
  const maybeVerified: boolean = optIn.verified;
  const notVerified: false = (await client.writeConfig(config, { ...controls, verify: false })).verified;
  const options: WriteOptions = { ...controls, verify: Math.random() > 0.5 };
  const variableVerified: boolean = (await client.writeConfig(config, options)).verified;
  const status: 'not-requested' | 'unsupported-read' | 'device-reset' | 'verified' = optIn.verification.status;
  await client.readConfig(controls);
  await client.getCurrentSlot(controls);
  await client.setEqEnabled(true, { ...controls, slot: 7 });
  const filter: SettingValues['dacFilter'] = await client.readSetting('dacFilter');
  await client.writeSetting('dacBalance', { left: 0, right: 3 });
  await client.writeSetting('gainMode', false);
  await client.readSetting('dacFilter', controls);
  await client.writeSetting('dacBalance', { left: 0, right: 3 }, controls);
  const diagnostics: DiagnosticsReport = client.getDiagnostics({ includeLogs: true });
  const inspection: DeviceInspection | null = await inspectDevice({ hid });
  const descriptorId: number | undefined = inspection?.collections[0]?.inputReportIds[0];
  const capturing = createClient({ hid, diagnostics: { maxEntries: 50 } });
  const alsoCapturing = createClient({ diagnostics: true });
  void [verified, defaultVerified, filter, maybeVerified, notVerified, variableVerified, status,
    diagnostics, descriptorId, capturing, alsoCapturing];
  client.subscribe(event => {
    if (event.type === 'disconnected') {
      const reason: 'requested' | 'device-disconnected' | 'write-reset' = event.reason;
      void reason;
    } else if (event.type === 'progress') {
      const progress: OperationProgress = event;
      const errorCode: ErrorCode | undefined = progress.errorCode;
      void errorCode;
    }
  });
}
void consume;

// @ts-expect-error Filter type must be one supported by the SDK.
const bad: EqConfigInput = { filters: [{ type: 'NOTCH', freq: 1000, q: 1, gain: 0 }] };
// @ts-expect-error gainMode requires a boolean.
client.writeSetting('gainMode', 'high');
// @ts-expect-error battery is read-only.
client.writeSetting('battery', 50);
// @ts-expect-error outputGain is write-only.
client.readSetting('outputGain');
// @ts-expect-error Supported-device metadata is immutable.
products.push(products[0]);
// @ts-expect-error Verification must be boolean.
client.writeConfig(config, { verify: 'yes' });
// @ts-expect-error Operation signals must be AbortSignal-compatible.
client.readConfig({ signal: {} });
// @ts-expect-error Progress observers must be functions.
client.getCurrentSlot({ onProgress: true });
// @ts-expect-error Opt-in verification does not always succeed (e.g. write-only devices).
const alwaysVerified: true = (await client.writeConfig(config, { verify: true })).verified;
// @ts-expect-error Diagnostic logs are immutable.
client.getDiagnostics().logs.push({});
// @ts-expect-error Diagnostic metadata is immutable.
client.getDiagnostics().lastDevice!.collections[0].inputReportIds.push(1);
void bad;
void alwaysVerified;

const error = new HidError('INVALID_CONFIG', 'Invalid filter');
const code: ErrorCode = error.code;
const newCodes: ErrorCode[] = ['ABORTED', 'TIMEOUT', 'VERIFICATION_FAILED'];
const difference: VerificationDifference = { field: 'filters[0].gain', expected: -3, actual: null, tolerance: 0.05 };
void [code, newCodes, difference];
