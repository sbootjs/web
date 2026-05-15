/**
 * sboot.js - SBootTransport
 * Ported from @sboot/webusb into pyodinweb as a plain script.
 * Named SBootTransport to avoid conflict with pyodinweb's UsbDevice class.
 *
 * Wraps WebUSB and exposes connect / write / read / close.
 * Used internally by SBootDevice for the Samsung Heimdall/sboot handshake.
 */

class SBootTransport {
    constructor(device) {
        this.device = device;
        this.interfaceNumber = null;
        this.inEndpoint = null;
        this.outEndpoint = null;
    }

    /**
     * Open a browser USB device picker filtered to Samsung (VID 0x04E8).
     * Returns a connected SBootTransport instance.
     */
    static async requestSamsungDevice() {
        const device = await navigator.usb.requestDevice({
            filters: [{ vendorId: SAMSUNG_VENDOR_ID }]
        });
        return new SBootTransport(device);
    }

    /**
     * Open the device, claim its bulk interface, and resolve endpoints.
     */
    async connect() {
        log('[SBoot] Opening Samsung USB device...', 'info');

        await this.device.open();

        if (!this.device.configuration) {
            await this.device.selectConfiguration(1);
        }

        log('[SBoot] USB configurations ready', 'info');

        let selectedInterface = null;

        for (const iface of this.device.configuration.interfaces) {
            log(`[SBoot] Checking interface: ${iface.interfaceNumber}`, 'info');

            for (const alternate of iface.alternates) {
                let hasBulkIn = false;
                let hasBulkOut = false;

                for (const endpoint of alternate.endpoints) {
                    if (endpoint.type === 'bulk' && endpoint.direction === 'in') {
                        hasBulkIn = true;
                    }
                    if (endpoint.type === 'bulk' && endpoint.direction === 'out') {
                        hasBulkOut = true;
                    }
                }

                if (hasBulkIn && hasBulkOut) {
                    selectedInterface = iface;
                    break;
                }
            }

            if (selectedInterface) break;
        }

        if (!selectedInterface) {
            throw new Error('[SBoot] Samsung bulk interface not found');
        }

        this.interfaceNumber = selectedInterface.interfaceNumber;
        log(`[SBoot] Using interface: ${this.interfaceNumber}`, 'info');

        await this.device.claimInterface(this.interfaceNumber);
        log('[SBoot] Interface claimed', 'info');

        await this.device.selectAlternateInterface(this.interfaceNumber, 0);
        log('[SBoot] Alternate interface selected', 'info');

        const alternate = selectedInterface.alternates[0];

        for (const endpoint of alternate.endpoints) {
            if (endpoint.type === 'bulk' && endpoint.direction === 'in') {
                this.inEndpoint = endpoint.endpointNumber;
            }
            if (endpoint.type === 'bulk' && endpoint.direction === 'out') {
                this.outEndpoint = endpoint.endpointNumber;
            }
        }

        log(`[SBoot] IN endpoint: ${this.inEndpoint}`, 'info');
        log(`[SBoot] OUT endpoint: ${this.outEndpoint}`, 'info');
    }

    /**
     * Write raw bytes to the device.
     * @param {Uint8Array|ArrayBuffer} data
     */
    async write(data) {
        if (!(data instanceof Uint8Array)) {
            data = new Uint8Array(data);
        }

        log(`[SBoot] USB OUT: ${data.length} bytes`, 'info');

        try {
            await this.device.clearHalt('out', this.outEndpoint);
        } catch (err) {
            log(`[SBoot] clearHalt (out) warning: ${err.message}`, 'warning');
        }

        const result = await this.device.transferOut(this.outEndpoint, data.buffer);
        log(`[SBoot] USB OUT result status: ${result.status}`, 'info');
        return result;
    }

    /**
     * Read up to `length` bytes from the device.
     * @param {number} length
     * @returns {Uint8Array}
     */
    async read(length = 512) {
        log(`[SBoot] USB IN waiting (up to ${length} bytes)...`, 'info');

        try {
            await this.device.clearHalt('in', this.inEndpoint);
        } catch (err) {
            log(`[SBoot] clearHalt (in) warning: ${err.message}`, 'warning');
        }

        const result = await this.device.transferIn(this.inEndpoint, length);

        if (!result || !result.data) {
            throw new Error('[SBoot] No USB response data');
        }

        const data = new Uint8Array(result.data.buffer);
        log(`[SBoot] USB IN received: ${data.length} bytes`, 'info');
        return data;
    }

    /**
     * Release the interface and close the device.
     */
    async close() {
        if (this.interfaceNumber !== null) {
            await this.device.releaseInterface(this.interfaceNumber);
        }
        await this.device.close();
        log('[SBoot] Transport closed', 'info');
    }
}
