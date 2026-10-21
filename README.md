# Moondrop HID

A JavaScript/TypeScript library for connecting to, reading, and writing Moondrop DAC configurations via WebHID.
Runs in browsers that support WebHID.

## Installation

Add the following to your application's `.npmrc`:

```ini
@shio265:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Set a GitHub **classic** PAT with the `read:packages` permission in the
`GITHUB_PACKAGES_TOKEN` environment variable, then install the package:

```sh
bun add @shio265/moondrop-hid
```

## Usage example

HTML:

```html
<button id="connect">Connect and read configuration</button>
<button id="save">Write EQ</button>
<button id="disconnect">Disconnect</button>
```

JavaScript, run after the buttons have been added to the page:

```js
import { createClient } from '@shio265/moondrop-hid';

const dac = createClient();

document.querySelector('#connect').onclick = async () => {
  try {
    const device = await dac.connect();
    if (!device) return; // The user canceled device selection

    console.log('Device:', device.model);
    if (device.capabilities.supportsRead) {
      console.log(await dac.readConfig());
    }
  } catch (error) {
    console.error(error);
  }
};

document.querySelector('#save').onclick = async () => {
  try {
    const result = await dac.writeConfig({
      filters: [{ type: 'PK', freq: 1000, gain: -3, q: 1 }],
      globalGain: 0
    });
    console.log(result);
  } catch (error) {
    console.error(error);
  }
};

document.querySelector('#disconnect').onclick = () =>
  dac.disconnect().catch(console.error);
```

## Notes

- The example writes one EQ band at 1000 Hz with a 3 dB reduction. All other bands are reset to their defaults.
- Some devices do not support reading configuration. Check `dac.device.limits` for the supported limits.
- Reduce the volume before testing. A successful write command does not guarantee that the data was saved correctly; read it back if the device supports it.

## Development and release

Bun 1.4.3 or later is required. The library is built with [Bunup](https://bunup.dev/):

```sh
bun install --frozen-lockfile
bun run check
bun pm pack
```
