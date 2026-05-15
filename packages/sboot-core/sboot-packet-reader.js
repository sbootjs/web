/**
 * sboot.js - PacketReader
 * Ported from @sboot/core into pyodinweb as a plain script.
 * Reads typed values from a binary buffer at an internal cursor.
 */

class SBootPacketReader {
    constructor(buffer) {
        this.buffer = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
        this.view = new DataView(this.buffer);
        this.offset = 0;
    }

    u8() {
        const value = this.view.getUint8(this.offset);
        this.offset += 1;
        return value;
    }

    u16() {
        const value = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return value;
    }

    u32() {
        const value = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return value;
    }

    bytes(length) {
        const slice = new Uint8Array(this.buffer, this.offset, length);
        this.offset += length;
        return slice;
    }

    remaining() {
        return this.buffer.byteLength - this.offset;
    }
}
