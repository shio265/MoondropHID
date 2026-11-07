# Moondrop HID

[![jsDelivr](https://data.jsdelivr.com/v1/package/gh/shio265/MoondropHID/badge)](https://www.jsdelivr.com/package/gh/shio265/MoondropHID)

A JavaScript/TypeScript library for connecting to, reading, and writing Moondrop DAC configurations via WebHID.
Runs in browsers that support WebHID.

## Setup

### GitHub Packages

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

Import it in your application:

```js
import { createClient } from '@shio265/moondrop-hid';
```

### jsDelivr

```js
import { createClient } from 'https://cdn.jsdelivr.net/gh/shio265/MoondropHID@0.1.0/src/index.js';
```

Replace it with another release version if needed.
[Browse the CDN files](https://www.jsdelivr.com/package/gh/shio265/MoondropHID).

## Usage

Both methods use the same client API. Add these buttons to your page:

```html
<button id="connect">Connect and read configuration</button>
<button id="save">Write EQ</button>
<button id="disconnect">Disconnect</button>
```

Add the following JavaScript after your chosen import. For jsDelivr, put the
import and this code in a `<script type="module">` after the buttons.

```js
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
