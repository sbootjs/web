# @sboot/core

Browser Samsung SBoot/Odin WebUSB runtime.

```js
import { loadSBootCore } from '@sboot/core';

const PyOdin = await loadSBootCore();
const flasher = new PyOdin.OdinFlasher(true);
```

Direct image flashing:

```js
const firmwareData = flasher.createImageFirmware(file, 'recovery');
await flasher.flash(firmwareData, null, true, onProgress);
```

Wrapper API for flasher makers:

```js
import { createSamsungFlasher } from '@sboot/core';

const samsung = await createSamsungFlasher({ verbose: true });
await samsung.connect();
await samsung.flashImage(file, 'recovery', { onProgress });

await samsung.runFlashPlan([
  { type: 'image', file: vbmetaFile, partition: 'vbmeta' },
  { type: 'image', file: recoveryFile, partition: 'recovery' }
], { onProgress });
```

This package runs in the browser and uses WebUSB. It does not expose a backend
flashing API.

See `docs/wiki/using-sboot-core.md` in the repository for integration details.
