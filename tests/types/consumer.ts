import { createClient, getSupportedDevices, HidError, type EqConfigInput,
  type HidAccess, type SettingValues, type ErrorCode } from '../../dist/index.js';

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
  const filter: SettingValues['dacFilter'] = await client.readSetting('dacFilter');
  await client.writeSetting('dacBalance', { left: 0, right: 3 });
  await client.writeSetting('gainMode', false);
  void [verified, filter];
  client.subscribe(event => {
    if (event.type === 'disconnected') {
      const reason: 'requested' | 'device-disconnected' | 'write-reset' = event.reason;
      void reason;
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
void bad;

const error = new HidError('INVALID_CONFIG', 'Invalid filter');
const code: ErrorCode = error.code;
void code;
