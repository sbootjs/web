import * as pako from 'pako';
import SparkMD5 from 'spark-md5';

const scriptUrls = [
    new URL('./lz4.min.js', import.meta.url).href,
    new URL('./lz4-wrapper.js', import.meta.url).href,
    new URL('./lz4-streaming.js', import.meta.url).href,
    new URL('./sboot-constants.js', import.meta.url).href,
    new URL('./utils.js', import.meta.url).href,
    new URL('./sboot-packet-reader.js', import.meta.url).href,
    new URL('./sboot-packet-writer.js', import.meta.url).href,
    new URL('./sboot-transport.js', import.meta.url).href,
    new URL('./sboot-protocol.js', import.meta.url).href,
    new URL('./sboot-device.js', import.meta.url).href,
    new URL('./pyodin.js', import.meta.url).href,
    new URL('./nested-tar-parser.js', import.meta.url).href,
    new URL('./zip-parser.js', import.meta.url).href
];

function loadClassicScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.body.appendChild(script);
    });
}

export async function loadSBootCore() {
    if (window.PyOdin) {
        return window.PyOdin;
    }

    window.pako = pako;
    window.SparkMD5 = SparkMD5;

    for (const scriptUrl of scriptUrls) {
        await loadClassicScript(scriptUrl);
    }

    return window.PyOdin;
}

export async function createSamsungFlasher({ verbose = false, autoReboot = true, verifyHash = true } = {}) {
    const SBoot = await loadSBootCore();
    const flasher = new SBoot.OdinFlasher(verbose);

    const runFlashStep = async (step, index, steps, options) => {
        const isLastStep = index === steps.length - 1;
        const reboot = step.reboot ?? (isLastStep ? (options.reboot ?? autoReboot) : false);
        const pitData = step.pitData ?? options.pitData ?? null;
        const onProgress = (progress) => {
            options.onProgress?.(progress, step, index);
            step.onProgress?.(progress, step, index);
        };

        options.onStepStart?.(step, index);

        let result;
        if (step.type === 'tar') {
            const firmware = await flasher.loadFirmware(step.file, step.verifyHash ?? options.verifyHash ?? verifyHash);
            result = await flasher.flash(firmware, pitData, reboot, onProgress);
        } else if (step.type === 'image') {
            const firmware = flasher.createImageFirmware(step.file, step.partition || step.partitionName);
            result = await flasher.flash(firmware, pitData, reboot, onProgress);
        } else if (step.type === 'firmware') {
            result = await flasher.flash(step.firmwareData, pitData, reboot, onProgress);
        } else {
            throw new Error(`Unsupported flash plan step type: ${step.type}`);
        }

        options.onStepComplete?.(step, index, result);
        return result;
    };

    return {
        core: SBoot,
        flasher,

        get isConnected() {
            return flasher.isConnected;
        },

        get deviceInfo() {
            return flasher.getDeviceInfo();
        },

        connect() {
            return flasher.connectDevice();
        },

        disconnect() {
            return flasher.disconnectDevice();
        },

        loadTar(file, options = {}) {
            const shouldVerify = options.verifyHash ?? verifyHash;
            return flasher.loadFirmware(file, shouldVerify);
        },

        async flashTar(file, options = {}) {
            const firmware = await this.loadTar(file, options);
            return flasher.flash(
                firmware,
                options.pitData ?? null,
                options.reboot ?? autoReboot,
                options.onProgress ?? null
            );
        },

        createImageFirmware(file, partitionName) {
            return flasher.createImageFirmware(file, partitionName);
        },

        flashImage(file, partitionName, options = {}) {
            const firmware = flasher.createImageFirmware(file, partitionName);
            return flasher.flash(
                firmware,
                options.pitData ?? null,
                options.reboot ?? autoReboot,
                options.onProgress ?? null
            );
        },

        flashFirmware(firmwareData, options = {}) {
            return flasher.flash(
                firmwareData,
                options.pitData ?? null,
                options.reboot ?? autoReboot,
                options.onProgress ?? null
            );
        },

        async runFlashPlan(steps, options = {}) {
            if (!Array.isArray(steps) || steps.length === 0) {
                throw new Error("Flash plan must include at least one step");
            }
            if (!flasher.isConnected) {
                throw new Error("Device is not connected. Call connect() from a user gesture before running a flash plan.");
            }

            options.onPlanStart?.(steps);
            const results = [];

            for (let i = 0; i < steps.length; i++) {
                results.push(await runFlashStep(steps[i], i, steps, options));
            }

            options.onPlanComplete?.(steps, results);
            return results;
        }
    };
}

export const loadPyOdin = loadSBootCore;
export { scriptUrls };
