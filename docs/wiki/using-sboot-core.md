# Using `@sboot/core`

`@sboot/core` is the browser library that powers SBoot Web. It loads the Samsung
SBoot/Odin protocol runtime, exposes the `PyOdin` browser namespace, and talks
to Samsung devices through WebUSB.

This is a frontend library. Do not put flashing behind an unprotected backend
API. The browser should own the USB permission prompt and the flashing session.

## Requirements

- Chrome, Edge, or another Chromium browser with WebUSB support
- A secure browser context: `https://` or `http://localhost`
- A Samsung device in Download Mode
- Odin-flashable `.tar` or `.tar.md5` packages
- User interaction before connecting, because WebUSB device selection must be
  triggered by a click or similar gesture

## Install

From this repo during development:

```bash
npm install @sboot/core@file:packages/sboot-core
```

In this project, the root `package.json` already uses:

```json
{
  "dependencies": {
    "@sboot/core": "file:packages/sboot-core"
  }
}
```

After publishing the package, consumers should install it normally:

```bash
npm install @sboot/core
```

## Vite Setup

Use the library from a browser entry file:

```js
import { loadSBootCore } from '@sboot/core';

const PyOdin = await loadSBootCore();
```

`loadSBootCore()` injects the classic browser scripts used by the protocol
runtime and returns `window.PyOdin`.

## Minimal Example

```html
<input id="firmware" type="file" accept=".tar,.tar.md5" multiple>
<button id="connect">Connect</button>
<button id="flash" disabled>Flash</button>
<pre id="log"></pre>

<script type="module">
  import { loadSBootCore } from '@sboot/core';

  const log = (message) => {
    document.querySelector('#log').textContent += `${message}\n`;
  };

  const PyOdin = await loadSBootCore();
  const flasher = new PyOdin.OdinFlasher(true);
  let firmwareData = null;

  document.querySelector('#connect').addEventListener('click', async () => {
    const deviceInfo = await flasher.connectDevice();
    log(`Connected: ${deviceInfo.product || 'Samsung device'}`);
    if (firmwareData) document.querySelector('#flash').disabled = false;
  });

  document.querySelector('#firmware').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    firmwareData = await flasher.loadFirmware(file, true);
    log(`Loaded ${firmwareData.items.length} firmware item(s)`);
    if (flasher.isConnected) document.querySelector('#flash').disabled = false;
  });

  document.querySelector('#flash').addEventListener('click', async () => {
    await flasher.flash(
      firmwareData,
      null,
      true,
      (progress, message) => log(`${progress.toFixed(1)}% ${message || ''}`)
    );
    log('Flash complete');
  });
</script>
```

## Custom ROM Flow

Most Odin-flashable custom ROMs are loaded through the AP slot. Your app can
present BL/AP/CP/CSC inputs, then combine the selected package files before
flashing.

Recommended UI labels:

- `BL`: Bootloader package, only when provided or required
- `AP`: Main firmware or custom ROM package
- `CP`: Modem/radio package, only when provided or required
- `CSC`: Region/carrier package, only when provided or required

Always tell users to follow the ROM maintainer's instructions. Some ROMs require
specific bootloader, vendor, vbmeta, or recovery state before flashing.

## For Other Flasher Makers

Other browser-based Samsung flashers can use `@sboot/core` as the protocol and
USB layer while keeping their own UI, validation rules, device database, and ROM
workflow.

What you can leverage:

- WebUSB Samsung Download Mode connection flow
- Odin/SBoot handshake and transfer protocol
- TAR and TAR.MD5 firmware parsing
- Direct Heimdall-style image flashing with explicit partition targets
- PIT parsing and partition matching
- Progress callbacks for your own UI
- LZ4, GZIP, pako, and SparkMD5 runtime wiring

Recommended architecture:

```text
your flasher UI
  -> your device/ROM validation layer
  -> @sboot/core
      -> WebUSB
          -> Samsung Download Mode device
```

Keep these responsibilities in your app:

- Device model allowlists or compatibility checks
- ROM-specific install rules
- User confirmations before destructive actions
- Clear partition labels for direct image flashing
- Firmware source trust and checksum verification
- Recovery instructions when a flash fails

Use the built-in wrapper:

```js
import { createSamsungFlasher } from '@sboot/core';

const samsung = await createSamsungFlasher({
  verbose: true,
  verifyHash: true,
  autoReboot: true
});

await samsung.connect();
await samsung.flashTar(apTarFile, {
  onProgress: (progress) => console.log(progress.percentage)
});

await samsung.flashImage(recoveryImgFile, 'recovery', {
  onProgress: (progress) => console.log(progress.currentFile)
});
```

For custom ROM flashers, prefer direct image flashing only when the ROM
maintainer explicitly says to flash an image to a specific partition. For full
Odin packages, keep using TAR/TAR.MD5 parsing so the package contents and PIT
matching drive the transfer.

Wrapper methods:

- `connect()`: opens WebUSB selection and connects
- `disconnect()`: closes the device session
- `loadTar(file, options)`: parses a TAR/TAR.MD5 package
- `flashTar(file, options)`: parses and flashes a TAR/TAR.MD5 package
- `createImageFirmware(file, partitionName)`: creates a direct image payload
- `flashImage(file, partitionName, options)`: flashes an image to a partition
- `flashFirmware(firmwareData, options)`: flashes a prebuilt firmware payload
- `runFlashPlan(steps, options)`: runs ordered TAR/image/firmware steps after a device is connected
- `flasher`: exposes the underlying `OdinFlasher` for advanced flows

## Automating Flash Plans

Browser security still requires a user click for `connect()`, but after the user
selects the USB device and approves your flash plan, you can automate the ordered
flashing steps.

```js
const samsung = await createSamsungFlasher({ verbose: true });

connectButton.addEventListener('click', async () => {
  await samsung.connect();
});

confirmFlashButton.addEventListener('click', async () => {
  await samsung.runFlashPlan([
    { type: 'image', file: vbmetaFile, partition: 'vbmeta' },
    { type: 'image', file: recoveryFile, partition: 'recovery' },
    { type: 'tar', file: apPackageFile }
  ], {
    onPlanStart: (steps) => renderPlan(steps),
    onStepStart: (step, index) => showStep(index, step),
    onProgress: (progress, step) => updateProgress(step, progress),
    onStepComplete: (step) => markDone(step),
    onPlanComplete: () => showComplete()
  });
});
```

Step types:

- `{ type: 'image', file, partition }`: flashes an image to a PIT-matched partition
- `{ type: 'tar', file }`: parses and flashes a TAR/TAR.MD5 package
- `{ type: 'firmware', firmwareData }`: flashes a payload you already built

By default, `runFlashPlan()` disables reboot for intermediate steps and uses the
wrapper's `autoReboot` setting only for the final step. Override per step with
`reboot: true` or `reboot: false` when a ROM maintainer requires it.

## API Reference

### `loadSBootCore()`

Loads the browser runtime and resolves to the `PyOdin` namespace.

```js
const PyOdin = await loadSBootCore();
```

### `new PyOdin.OdinFlasher(verbose)`

Creates a high-level flasher.

```js
const flasher = new PyOdin.OdinFlasher(true);
```

### `flasher.connectDevice()`

Opens the WebUSB device picker, connects to a Samsung Download Mode device, and
performs the Odin handshake.

```js
const deviceInfo = await flasher.connectDevice();
```

Call this from a button click. Browsers block WebUSB prompts that are not caused
by user activation.

### `flasher.loadFirmware(file, verifyHash)`

Parses one firmware package file.

```js
const firmwareData = await flasher.loadFirmware(file, true);
```

For multi-slot firmware or custom ROM workflows, inspect this app's
`public/js/app.js` for the header-only TAR parsing approach used to combine
BL/AP/CP/CSC files without reading huge archives entirely into memory.

### `flasher.createImageFirmware(file, partitionName)`

Creates a firmware payload for a direct Heimdall-style image flash.

```js
const firmwareData = flasher.createImageFirmware(file, 'recovery');
await flasher.flash(firmwareData, null, true, onProgress);
```

Use this for files such as:

- `recovery.img` → `recovery`
- `boot.img` → `boot`
- `init_boot.img` → `init_boot`
- `vendor_boot.img` → `vendor_boot`
- `dtbo.img` → `dtbo`
- `vbmeta.img` → `vbmeta`
- `super.img` → `super`

Direct image flashing uses PIT partition matching before transfer. If the target
partition cannot be found in the PIT, the library throws instead of guessing.

### `flasher.flash(firmwareData, pitData, reboot, progressCallback)`

Uploads the parsed package to the connected device.

```js
await flasher.flash(firmwareData, null, true, (percent, message) => {
  console.log(percent, message);
});
```

Arguments:

- `firmwareData`: parsed firmware package data
- `pitData`: optional PIT data, usually `null`
- `reboot`: whether to reboot after flashing
- `progressCallback`: receives progress updates

## Security Notes

- Keep flashing in the browser; WebUSB already gives users a permission prompt.
- Do not expose a backend route like `/flash` without authentication and device
  ownership controls.
- Never auto-connect or auto-flash on page load.
- Show the selected filenames, total size, and package contents before flashing.
- Require an explicit final user action before calling `flash()`.

## Bundler Notes

`@sboot/core` is an ESM package that loads some legacy protocol files as classic
scripts. This is intentional while the internal protocol code remains plain
browser JavaScript.

Known-good setup:

```bash
npm install
npm run dev
npm run build
```

If your bundler blocks dynamic script URLs from packages, serve the package
assets from a public location or use Vite, which supports `new URL(...,
import.meta.url)` for package assets.

## Current Limitations

- Browser-only WebUSB runtime
- Chrome/Chromium browsers only
- ZIP firmware parsing is a placeholder in this build
- Device and package compatibility must be validated by your app and the user
