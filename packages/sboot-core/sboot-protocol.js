/**
 * sboot.js - SBootProtocol
 * Ported from @sboot/core (OdinProtocol) into pyodinweb as a plain script.
 * Named SBootProtocol to avoid conflict with pyodinweb's own download engine.
 *
 * Handles the low-level Heimdall/Odin packet exchange:
 *   connect → initialise (ODIN/LOKE handshake) → send/receive
 */

class SBootProtocol {
    constructor(transport) {
        this.transport = transport;
        this.connected = false;
    }

    /**
     * Mark the protocol layer as connected.
     */
    async connect() {
        this.connected = true;
        log('[SBootProtocol] Protocol layer initialized', 'info');
    }

    /**
     * Send a raw packet.
     * @param {Uint8Array|Array|ArrayBuffer} data
     */
    async send(data) {
        if (!this.connected) {
            throw new Error('[SBootProtocol] Protocol not connected');
        }

        if (!(data instanceof Uint8Array)) {
            data = new Uint8Array(data);
        }

        const hex = Array.from(data)
            .map(v => v.toString(16).padStart(2, '0'))
            .join(' ');

        log(`[SBootProtocol] Sending packet (${data.length} bytes): ${hex}`, 'info');

        await this.transport.write(data);

        log('[SBootProtocol] Packet sent', 'info');
    }

    /**
     * Receive a packet with a 3-second timeout.
     * @param {number} length  Maximum number of bytes to read.
     * @returns {Uint8Array}
     */
    async receive(length = 512) {
        if (!this.connected) {
            throw new Error('[SBootProtocol] Protocol not connected');
        }

        log('[SBootProtocol] Waiting for response...', 'info');

        const response = await Promise.race([
            this.transport.read(length),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('[SBootProtocol] Receive timeout')), 3000)
            )
        ]);

        const data = new Uint8Array(response);
        log(`[SBootProtocol] Received ${data.length} bytes`, 'info');
        return data;
    }

    /**
     * Send the "ODIN" magic bytes and wait for the "LOKE" response.
     * This is the Samsung Heimdall handshake.
     * @returns {boolean} true on success
     */
    async initialise() {
        log('[SBootProtocol] Initialising — sending Heimdall handshake (ODIN)...', 'info');

        // "ODIN" magic
        const packet = new Uint8Array([0x4F, 0x44, 0x49, 0x4E]);
        await this.send(packet);

        // Small delay to let the device respond
        await new Promise(resolve => setTimeout(resolve, 100));

        try {
            const response = await this.receive(7);
            const text = new TextDecoder().decode(response);
            log(`[SBootProtocol] Handshake response: "${text}"`, 'info');

            if (text.includes('LOKE')) {
                log('[SBootProtocol] LOKE handshake successful ✓', 'success');
            } else {
                log(`[SBootProtocol] Unexpected handshake response: "${text}"`, 'warning');
            }
        } catch (err) {
            log(`[SBootProtocol] No LOKE response received (${err.message}), continuing...`, 'warning');
        }

        return true;
    }
}
