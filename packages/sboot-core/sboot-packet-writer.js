/**
 * sboot.js - PacketWriter
 * Ported from @sboot/core into pyodinweb as a plain script.
 * Writes typed values into a pre-allocated binary buffer.
 */

class SBootPacketWriter {
    constructor(size = 1024) {
        this.buffer = new ArrayBuffer(size);
        this.view = new DataView(this.buffer);
        this.offset = 0;
    }

    u8(value) {
        this.view.setUint8(this.offset, value);
        this.offset += 1;
        return this;
    }

    u16(value) {
        this.view.setUint16(this.offset, value, true);
        this.offset += 2;
        return this;
    }

    u32(value) {
        this.view.setUint32(this.offset, value, true);
        this.offset += 4;
        return this;
    }

    bytes(uint8Array) {
        new Uint8Array(this.buffer).set(uint8Array, this.offset);
        this.offset += uint8Array.length;
        return this;
    }

    build() {
        return this.buffer.slice(0, this.offset);
    }

    toUint8Array() {
        return new Uint8Array(this.build());
    }
}
