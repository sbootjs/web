/**
 * sboot-device.js
 *
 * High-level Samsung device library.  Contains every class that was
 * previously spread across usb-device.js, download-engine.js,
 * firmware-parser.js, pit-parser.js, crypto-utils.js, and flasher.js,
 * plus the original SBootDevice facade.
 *
 * Load order in index.html:
 *   sboot-constants.js → sboot-packet-reader.js → sboot-packet-writer.js
 *   → sboot-transport.js → sboot-protocol.js → sboot-device.js
 */

// ─── DeviceInfo ──────────────────────────────────────────────────────────────

class DeviceInfo {
    constructor(vendorId, productId) {
        this.vendorId = vendorId;
        this.productId = productId;
        this.manufacturer = "";
        this.product = "";
        this.serialNumber = "";

        this.protocolVersion = 0;
        this.deviceId = "";
        this.modelName = "";
        this.firmwareVersion = "";
        this.chipId = "";
        this.supportsZlp = false;
    }

    toString() {
        return `DeviceInfo(product='${this.product}', model='${this.modelName}', serial='${this.serialNumber}')`;
    }
}

// ─── UsbDevice ───────────────────────────────────────────────────────────────

class UsbDevice {
    constructor(verbose = false) {
        this.verbose = verbose;
        this.device = null;
        this.interface = 0;
        this.endpointOut = null;
        this.endpointIn = null;
        this.deviceInfo = null;
        this.packetSize = USB_PACKET_SIZE;
        this.configuration = null;
    }

    log(message) {
        if (this.verbose) log(`[UsbDevice] ${message}`, 'info');
    }

    async findDevice() {
        this.log("Searching for Samsung device in Download mode...");

        try {
            const filters = SAMSUNG_DOWNLOAD_MODE_PIDS.map(pid => ({
                vendorId: SAMSUNG_VENDOR_ID,
                productId: pid
            }));

            this.device = await navigator.usb.requestDevice({ filters });

            if (this.device) {
                this.log(`Found device: VID=0x${this.device.vendorId.toString(16).padStart(4,'0')}, PID=0x${this.device.productId.toString(16).padStart(4,'0')}`);

                this.deviceInfo = new DeviceInfo(this.device.vendorId, this.device.productId);
                this.deviceInfo.manufacturer = this.device.manufacturerName || "";
                this.deviceInfo.product = this.device.productName || "";
                this.deviceInfo.serialNumber = this.device.serialNumber || "";

                return this.deviceInfo;
            }
        } catch (error) {
            log(`Error finding device: ${error.message}`, 'error');
            return null;
        }

        return null;
    }

    async connect() {
        if (!this.device) {
            const deviceInfo = await this.findDevice();
            if (!deviceInfo) throw new Error("No Samsung device found in Download mode");
        }

        try {
            this.log("Connecting to device...");

            await this.device.open();
            this.log("Device opened");

            if (this.device.configuration === null) {
                await this.device.selectConfiguration(1);
                this.log("Configuration selected");
            }

            this.configuration = this.device.configuration;
            this.log(`Active configuration: ${this.configuration.configurationValue}`);
            this.log(`Number of interfaces: ${this.configuration.interfaces.length}`);
            this.log("Searching for endpoints across all interfaces...");

            for (const iface of this.configuration.interfaces) {
                this.log(`Interface ${iface.interfaceNumber}: Class=${iface.alternate.interfaceClass}`);

                if (iface.alternate.endpoints.length > 0) {
                    try {
                        await this.device.claimInterface(iface.interfaceNumber);
                        this.log(`  Claimed interface ${iface.interfaceNumber}`);
                    } catch (error) {
                        this.log(`  Warning: Could not claim interface: ${error.message}`);
                    }
                }

                for (const endpoint of iface.alternate.endpoints) {
                    this.log(`    Endpoint 0x${endpoint.endpointNumber.toString(16).padStart(2,'0')}: ${endpoint.type} ${endpoint.direction}`);

                    if (endpoint.type === 'bulk') {
                        if (endpoint.direction === 'out' && !this.endpointOut) {
                            this.endpointOut = endpoint;
                            this.interface = iface.interfaceNumber;
                            this.log(`      ★ Using as OUT endpoint`);
                        } else if (endpoint.direction === 'in' && !this.endpointIn) {
                            this.endpointIn = endpoint;
                            this.interface = iface.interfaceNumber;
                            this.log(`      ★ Using as IN endpoint`);
                        }
                    }
                }
            }

            if (!this.endpointOut || !this.endpointIn) {
                throw new Error(`Could not find USB endpoints. Found OUT: ${!!this.endpointOut}, Found IN: ${!!this.endpointIn}`);
            }

            this.log(`✓ Endpoints configured:`);
            this.log(`  OUT: 0x${this.endpointOut.endpointNumber.toString(16).padStart(2,'0')}`);
            this.log(`  IN:  0x${this.endpointIn.endpointNumber.toString(16).padStart(2,'0')}`);

            this.packetSize = this.endpointOut.packetSize;
            this.log(`Max packet size: ${this.packetSize}`);

            return true;
        } catch (error) {
            throw new Error(`USB connection failed: ${error.message}`);
        }
    }

    async disconnect() {
        if (this.device) {
            try {
                if (this.interface !== null) await this.device.releaseInterface(this.interface);
                await this.device.close();
                this.log("Disconnected from device");
            } catch (error) {
                this.log(`Warning during disconnect: ${error.message}`);
            }
        }

        this.device = null;
        this.endpointOut = null;
        this.endpointIn = null;
    }

    async write(data, timeout = TIMEOUT_WRITE) {
        if (!this.endpointOut) throw new Error("Device not connected");

        try {
            if (data.length > 65536) {
                let totalWritten = 0;
                let offset = 0;
                const chunkSize = 65536;

                while (offset < data.length) {
                    const chunkEnd = Math.min(offset + chunkSize, data.length);
                    const chunk = data.slice(offset, chunkEnd);
                    const result = await this.device.transferOut(this.endpointOut.endpointNumber, chunk);

                    totalWritten += result.bytesWritten;
                    offset = chunkEnd;

                    if (result.bytesWritten !== chunk.length) {
                        this.log(`Warning: Partial write ${result.bytesWritten}/${chunk.length} bytes`);
                        break;
                    }
                }

                if (this.verbose) this.log(`Wrote ${totalWritten} bytes (chunked)`);
                return totalWritten;
            } else {
                const result = await this.device.transferOut(this.endpointOut.endpointNumber, data);
                if (this.verbose) this.log(`Wrote ${result.bytesWritten} bytes`);
                return result.bytesWritten;
            }
        } catch (error) {
            throw new Error(`USB write failed: ${error.message}`);
        }
    }

    async read(size, timeout = TIMEOUT_READ) {
        if (!this.endpointIn) throw new Error("Device not connected");

        try {
            const timeoutMs = timeout * 1000;
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), timeoutMs)
            );
            const readPromise = this.device.transferIn(this.endpointIn.endpointNumber, size);
            const result = await Promise.race([readPromise, timeoutPromise]);

            if (this.verbose) this.log(`Read ${result.data.byteLength} bytes`);
            return new Uint8Array(result.data.buffer);
        } catch (error) {
            if (error.message === 'timeout') throw new Error(`USB read timeout after ${timeout}s`);
            throw new Error(`USB read failed: ${error.message}`);
        }
    }

    async bulkWrite(data, timeout = TIMEOUT_WRITE) {
        let totalWritten = 0;
        let offset = 0;

        while (offset < data.length) {
            const chunkSize = Math.min(this.packetSize, data.length - offset);
            const written = await this.write(data.slice(offset, offset + chunkSize), timeout);
            totalWritten += written;
            offset += chunkSize;
        }

        return totalWritten;
    }

    async bulkRead(size, timeout = TIMEOUT_READ) {
        const chunks = [];
        let totalRead = 0;

        while (totalRead < size) {
            const chunkSize = Math.min(this.packetSize, size - totalRead);
            const chunk = await this.read(chunkSize, timeout);
            chunks.push(chunk);
            totalRead += chunk.length;
        }

        return concatUint8Arrays(...chunks);
    }

    async controlTransfer(requestType, request, value = 0, index = 0, data = null) {
        if (!this.device) throw new Error("Device not connected");

        try {
            if (data !== null) {
                await this.device.controlTransferOut({ requestType, recipient: 'device', request, value, index }, data);
                return new Uint8Array(0);
            } else {
                const result = await this.device.controlTransferIn({ requestType, recipient: 'device', request, value, index }, 1024);
                return new Uint8Array(result.data.buffer);
            }
        } catch (error) {
            throw new Error(`Control transfer failed: ${error.message}`);
        }
    }

    async reset() {
        if (this.device) {
            try { await this.device.reset(); this.log("Device reset"); }
            catch (error) { throw new Error(`Device reset failed: ${error.message}`); }
        }
    }

    static async listDevices() {
        const devices = await navigator.usb.getDevices();
        const samsungDevices = [];

        for (const device of devices) {
            if (device.vendorId === SAMSUNG_VENDOR_ID && SAMSUNG_DOWNLOAD_MODE_PIDS.includes(device.productId)) {
                const deviceInfo = new DeviceInfo(device.vendorId, device.productId);
                deviceInfo.manufacturer = device.manufacturerName || "";
                deviceInfo.product = device.productName || "";
                deviceInfo.serialNumber = device.serialNumber || "";
                samsungDevices.push(deviceInfo);
            }
        }

        return samsungDevices;
    }
}

// ─── DownloadProgress ────────────────────────────────────────────────────────

class DownloadProgress {
    constructor() {
        this.percentage = 0;
        this.currentFile = "";
        this.bytesTransferred = 0;
        this.totalBytes = 0;
        this.speed = 0;
    }
}

// ─── DownloadEngine ──────────────────────────────────────────────────────────

class DownloadEngine {
    constructor(usbDevice, verbose = false) {
        this.usbDevice = usbDevice;
        this.verbose = verbose;
        this.packetSize = 1024;
        this.fileTransferPacketSize = 131072;  // 128KB
        this.protocolVersion = 0;
        this.progressCallback = null;
        this.lastProgressUpdate = Date.now();
    }

    log(message) {
        if (this.verbose) log(`[DownloadEngine] ${message}`, 'info');
    }

    setProgressCallback(callback) {
        this.progressCallback = callback;
    }

    normalizePartitionName(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/\\/g, '/')
            .split('/')
            .pop()
            .replace(/\.tar\.md5$/i, '')
            .replace(/\.lz4$/i, '')
            .replace(/\.gz$/i, '')
            .replace(/\.img$/i, '')
            .replace(/\.bin$/i, '')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    getItemPartitionNames(item) {
        const names = new Set();
        const add = (value) => {
            const normalized = this.normalizePartitionName(value);
            if (normalized) names.add(normalized);
        };

        add(item.info.partitionName);
        add(item.info.partition_name);
        add(item.info.targetPartition);
        add(item.info.target_partition);
        add(item.filename);

        const aliasMap = {
            ap: ['system', 'super'],
            bl: ['sboot', 'bootloader'],
            cp: ['modem', 'radio'],
            csc: ['cache', 'userdata'],
            bootloader: ['sboot'],
            radio: ['modem'],
            initboot: ['init_boot'],
            vendorboot: ['vendor_boot']
        };

        for (const name of Array.from(names)) {
            const aliases = aliasMap[name] || [];
            for (const alias of aliases) add(alias);
        }

        return names;
    }

    getFallbackPartitionMatch(item) {
        const names = this.getItemPartitionNames(item);
        const fallbackMap = {
            boot: { partition_id: 3, device_type: 2 },
            recovery: { partition_id: 10, device_type: 2 },
            modem: { partition_id: 11, device_type: 2 },
            radio: { partition_id: 11, device_type: 2 },
            sboot: { partition_id: 80, device_type: 2 },
            bootloader: { partition_id: 80, device_type: 2 }
        };

        for (const name of names) {
            if (fallbackMap[name]) return fallbackMap[name];
        }

        return null;
    }

    async handshake() {
        this.log("Performing handshake...");

        try {
            const odinBytes = new TextEncoder().encode("ODIN");
            const written = await this.usbDevice.write(odinBytes);

            if (written !== 4) {
                log(`Handshake: wrote ${written} bytes, expected 4`, 'error');
                return false;
            }

            this.log("Sent 'ODIN', waiting for 'LOKE'...");
            const resp = await this.usbDevice.read(64, TIMEOUT_HANDSHAKE);

            if (resp.length < 4) {
                log(`Handshake: received ${resp.length} bytes, expected 4`, 'error');
                return false;
            }

            const responseStr = new TextDecoder().decode(resp.slice(0, 4));
            this.log(`Received: '${responseStr}' (${resp[0]}, ${resp[1]}, ${resp[2]}, ${resp[3]})`);

            if (resp[0] === 76 && resp[1] === 79 && resp[2] === 75 && resp[3] === 69) {
                this.log("✓ Handshake OK (received 'LOKE')");
                return true;
            }

            log(`Handshake failed: expected 'LOKE', got '${responseStr}'`, 'error');
            return false;
        } catch (error) {
            log(`Handshake failed: ${error.message}`, 'error');
            return false;
        }
    }

    async getDeviceInfo() {
        this.log("Getting device info...");
        return this.usbDevice.deviceInfo;
    }

    async sendPitInfo() {
        this.log("Sending PIT info (no-op without PIT data)...");
        return true;
    }

    async sendPitData(pitData) {
        this.log(`Sending PIT data (${pitData.length} bytes)...`);

        try {
            const chunkSize = 0x100000;
            let offset = 0;

            while (offset < pitData.length) {
                const end = Math.min(offset + chunkSize, pitData.length);
                await this.usbDevice.write(pitData.slice(offset, end));
                offset = end;
                this.log(`  Sent ${offset}/${pitData.length} bytes`);
            }

            const resp = await this.usbDevice.read(64, TIMEOUT_TRANSFER);
            if (resp.length >= 8) {
                const [, result] = structUnpack('<II', resp);
                return result === 0;
            }

            return true;
        } catch (error) {
            log(`sendPitData failed: ${error.message}`, 'error');
            return false;
        }
    }

    async receivePitData() {
        this.log("Requesting PIT from device...");

        try {
            const buf = new Uint8Array(1024);
            buf.set(structPack('<III', 101, 1, 0), 0);
            await this.usbDevice.write(buf.slice(0, this.packetSize));

            let resp = null;
            for (let retry = 0; retry < 2; retry++) {
                resp = await this.usbDevice.read(64, 60);
                if (resp && resp.length >= 8) break;
            }

            if (!resp || resp.length < 8) throw new Error("PIT request timeout");

            const [respCmd, pitSize] = structUnpack('<II', resp);
            if (respCmd !== 101) throw new Error(`PIT cmd=${respCmd}, expected 101`);
            this.log(`PIT size: ${pitSize} bytes`);

            if (pitSize === 0 || pitSize > 0x100000) throw new Error(`Invalid PIT size: ${pitSize}`);

            const pitData = [];
            let counter = 0;
            let remaining = pitSize;

            while (remaining > 0) {
                buf.fill(0);
                buf.set(structPack('<III', 101, 2, counter), 0);
                await this.usbDevice.write(buf.slice(0, this.packetSize));

                const chunk = await this.usbDevice.read(Math.min(500, remaining), 60);
                if (chunk.length === 0) break;

                pitData.push(chunk);
                remaining -= chunk.length;
                counter++;
                this.log(`  Read chunk ${counter}: ${chunk.length} bytes, ${remaining} remaining`);
            }

            buf.fill(0);
            buf.set(structPack('<III', 101, 3, 0), 0);
            await this.usbDevice.write(buf.slice(0, this.packetSize));
            await this.usbDevice.read(64, 60);

            const finalPitData = concatUint8Arrays(...pitData);
            if (finalPitData.length !== pitSize) this.log(`Warning: PIT size mismatch: ${finalPitData.length}/${pitSize}`);

            this.log(`✓ PIT received (${finalPitData.length} bytes)`);
            return finalPitData;
        } catch (error) {
            log(`receivePitData failed: ${error.message}`, 'error');
            throw error;
        }
    }

    async uploadBinaries(firmwareData, pitData) {
        this.log(`Uploading ${firmwareData.items.length} items...`);

        if (pitData) {
            const pitParser = new PitParser(this.verbose);
            const pit = pitParser.parse(pitData);

            for (const item of firmwareData.items) {
                const candidateNames = this.getItemPartitionNames(item);
                let matched = false;

                for (const entry of pit.entries) {
                    const partName = this.normalizePartitionName(entry.partitionName);
                    const flashName = this.normalizePartitionName(entry.flashFilename);
                    const fotaName = this.normalizePartitionName(entry.fotaFilename);

                    if (candidateNames.has(partName) || candidateNames.has(flashName) || candidateNames.has(fotaName)) {
                        item.info.partition_id = entry.partitionId;
                        item.info.device_type = entry.deviceType;
                        item.info.matched_partition_name = entry.partitionName;
                        this.log(`  Matched: ${item.filename} → ${entry.partitionName} (ID=${entry.partitionId}, type=${entry.deviceType})`);
                        matched = true;
                        break;
                    }
                }

                if (!matched) {
                    this.log(`  WARNING: No PIT match for ${item.filename}`);
                    if (item.info.isDirectImage || item.info.partitionName || item.info.targetPartition) {
                        const targets = Array.from(candidateNames).join(', ');
                        throw new Error(`No PIT partition match for direct image ${item.filename}. Tried: ${targets}`);
                    }
                    if (!item.info.device_type) item.info.device_type = 2;
                }
            }
        } else {
            this.log("  No PIT - detecting partitions from filenames...");
            for (const item of firmwareData.items) {
                const fallback = this.getFallbackPartitionMatch(item);
                if (fallback) {
                    item.info.partition_id = fallback.partition_id;
                    item.info.device_type = fallback.device_type;
                } else {
                    if (!item.info.partition_id) item.info.partition_id = 0;
                    if (!item.info.device_type) item.info.device_type = 2;
                }
                this.log(`  ${item.filename} → ID=${item.info.partition_id}, type=${item.info.device_type}`);
            }
        }

        for (let i = 0; i < firmwareData.items.length; i++) {
            const item = firmwareData.items[i];

            if (!item.data && !item.info.isLargeFile) { this.log(`Skipping ${item.filename} - no data`); continue; }
            if (item.data && item.data.length === 0)  { this.log(`Skipping ${item.filename} - empty`);   continue; }
            if (item.filename.includes('meta-data/') || item.filename.endsWith('.zip')) { this.log(`Skipping ${item.filename} - metadata`); continue; }

            this.log(`\n>>> Processing item ${i+1}/${firmwareData.items.length}: ${item.filename}`);
            const success = await this.transferFile(item);
            if (!success) throw new Error(`Failed to transfer ${item.filename}`);
            this.log(`✓ Completed ${item.filename}`);
        }

        this.log("All binaries uploaded successfully");
        return true;
    }

    async transferFile(item) {
        this.log(`==== Transferring: ${item.filename} ====`);
        this.log(`  Partition ID: ${item.info.partition_id}, Device type: ${item.info.device_type}`);

        let data;
        let fileSize;

        if (item.data) {
            data = item.data;
            fileSize = item.data.length;
            this.log(`  Using pre-loaded data: ${formatBytes(fileSize)}`);
        } else if (item.info.isLargeFile && item.info.fileHandle && item.info.fileOffset !== undefined) {
            if (item.info.is_compressed) {
                if (item.info.actualSize > 4 * 1024 * 1024 * 1024) {
                    data = null;
                    fileSize = item.info.actualSize;
                } else {
                    const fileBlob = item.info.fileHandle.slice(item.info.fileOffset, item.info.fileOffset + item.info.actualSize);
                    data = new Uint8Array(await fileBlob.arrayBuffer());
                    fileSize = data.length;
                    this.log(`  ✓ Extracted ${formatBytes(fileSize)}`);
                }
            } else {
                data = null;
                fileSize = item.info.actualSize;
                this.log(`  Large uncompressed file - streaming mode`);
            }
        } else {
            throw new Error(`No data available for ${item.filename}`);
        }

        let isStreamingCompressed = false;

        if (item.info.is_compressed) {
            let compressionType = item.info.compression_type;
            if (!compressionType || compressionType === 'none') {
                if (item.filename.endsWith('.lz4')) compressionType = 'lz4';
                else if (item.filename.endsWith('.gz')) compressionType = 'gzip';
            }

            if (data) {
                const compressedSize = data.length;
                this.log(`  Decompressing (${compressionType})...`);

                if (compressionType === 'gzip') {
                    if (typeof pako === 'undefined') throw new Error('pako required for GZIP');
                    data = pako.inflate(data);
                } else if (compressionType === 'lz4') {
                    if (typeof lz4 === 'undefined' || typeof lz4.decode !== 'function') throw new Error('LZ4 library not loaded');
                    const dec = lz4.decode(data);
                    if (!dec || dec.length === 0) throw new Error('LZ4 decompression returned empty data');
                    data = dec instanceof Uint8Array ? dec : new Uint8Array(dec);
                }

                this.log(`  ✓ Decompressed: ${formatBytes(compressedSize)} → ${formatBytes(data.length)}`);
                fileSize = data.length;
            } else {
                isStreamingCompressed = true;
            }
        }

        const partitionId = item.info.partition_id || 0;
        const deviceType  = item.info.device_type  || 2;

        if (isStreamingCompressed) {
            item.info.useStreamingLZ4 = true;
            return await this.transferFileStreamingLZ4(item, partitionId, deviceType);
        }

        this.log(`  Final size: ${formatBytes(fileSize)}`);

        let offset = 0;

        try {
            // Activate (102/0)
            const buf = new Uint8Array(1024);
            buf.set(structPack('<III', 102, 0, 0), 0);
            await this.usbDevice.write(buf.slice(0, this.packetSize));
            const resp = await this.usbDevice.read(64, 60);
            if (resp.length < 8) throw new Error("File transfer activation timeout");
            const [respCmd] = structUnpack('<II', resp);
            if (respCmd !== 102) throw new Error(`File transfer activation rejected: cmd=${respCmd}`);

            const MAX_CHUNK = 0x1E00000;  // 30MB
            let sequenceNum = 0;

            while (offset < fileSize) {
                const chunkSize = Math.min(fileSize - offset, MAX_CHUNK);

                // Begin sequence (102/2)
                buf.fill(0);
                buf.set(structPack('<III', 102, 2, chunkSize), 0);
                await this.usbDevice.write(buf.slice(0, this.packetSize));
                const resp2 = await this.usbDevice.read(64, 60);
                if (resp2.length < 8) throw new Error("Sequence begin timeout");
                const [cmd2] = structUnpack('<II', resp2);
                if (cmd2 !== 102) throw new Error(`Sequence begin rejected: cmd=${cmd2}`);

                await sleep(100);

                let chunkOffset = 0;
                let blockCount  = 0;

                while (chunkOffset < chunkSize) {
                    const blockSize = Math.min(this.fileTransferPacketSize, chunkSize - chunkOffset);
                    let block;

                    if (data) {
                        const start = offset + chunkOffset;
                        if (start >= data.length) throw new Error(`Reading beyond data array: ${start} >= ${data.length}`);
                        block = data.slice(start, start + blockSize);
                    } else {
                        const fileStart = item.info.fileOffset + offset + chunkOffset;
                        block = new Uint8Array(await item.info.fileHandle.slice(fileStart, fileStart + blockSize).arrayBuffer());
                    }

                    if (block.length < this.fileTransferPacketSize) {
                        const padded = new Uint8Array(this.fileTransferPacketSize);
                        padded.set(block);
                        block = padded;
                    }

                    if (blockCount > 0) { try { await this.usbDevice.write(new Uint8Array(0)); } catch (e) {} }

                    const written = await this.usbDevice.write(block);
                    if (written !== this.fileTransferPacketSize) throw new Error(`Expected ${this.fileTransferPacketSize} bytes written, got ${written}`);

                    const blockResp = await this.usbDevice.read(64, 60);
                    if (blockResp.length !== 8) throw new Error(`Expected 8-byte block response, got ${blockResp.length}`);

                    chunkOffset += blockSize;
                    blockCount++;

                    if (this.progressCallback) {
                        const now = Date.now();
                        if (now - this.lastProgressUpdate > 500) {
                            const p = new DownloadProgress();
                            p.currentFile = item.filename;
                            p.bytesTransferred = offset + chunkOffset;
                            p.totalBytes = fileSize;
                            p.percentage = (p.bytesTransferred / fileSize) * 100;
                            this.progressCallback(p);
                            this.lastProgressUpdate = now;
                        }
                    }
                }

                // Finalize (102/3)
                const completionStatus = (fileSize - offset - chunkSize) <= 0 ? 1 : 0;
                buf.fill(0);
                buf.set(structPack('<II', 102, 3), 0);
                buf.set(structPack('<IIIIII', 0, chunkOffset, 0, deviceType, partitionId, completionStatus), 8);

                try { await this.usbDevice.write(new Uint8Array(0)); } catch (e) {}
                await this.usbDevice.write(buf.slice(0, this.packetSize));
                try { await this.usbDevice.write(new Uint8Array(0)); } catch (e) {}

                await sleep(100);

                let finalResp = null;
                try { finalResp = await this.usbDevice.read(64, 120); } catch (e) { this.log(`  Timeout after 120s: ${e.message}`); }

                if (finalResp && finalResp.length >= 8) {
                    const [finalCmd, finalData] = structUnpack('<II', finalResp);
                    if (finalCmd === 0xFFFFFFFF) throw new Error(`Finalize rejected, code=${finalData}`);
                    if (finalCmd !== 102) throw new Error(`Unexpected response cmd=${finalCmd}`);
                } else if (completionStatus !== 1) {
                    throw new Error("No response on intermediate chunk");
                }

                offset += chunkSize;
                sequenceNum++;
            }

            this.log(`✓ Complete: ${item.filename}`);
            data = null;
            await sleep(100);
            return true;

        } catch (error) {
            data = null;
            this.log(`ERROR transferring ${item.filename}: ${error.message}`);
            throw error;
        }
    }

    async transferFileStreamingLZ4(item, partitionId, deviceType) {
        this.log(`\n==== TRUE STREAMING LZ4 Transfer: ${item.filename} ====`);

        if (typeof StreamingLZ4Decoder === 'undefined') throw new Error('StreamingLZ4Decoder not loaded');

        const decoder = new StreamingLZ4Decoder(this.verbose);
        const buf = new Uint8Array(1024);

        buf.set(structPack('<III', 102, 0, 0), 0);
        await this.usbDevice.write(buf.slice(0, this.packetSize));
        const resp = await this.usbDevice.read(64, 60);
        if (resp.length < 8) throw new Error("File transfer activation timeout");
        const [respCmd] = structUnpack('<II', resp);
        if (respCmd !== 102) throw new Error(`File transfer activation rejected: cmd=${respCmd}`);

        const SEND_BUFFER_SIZE = 30 * 1024 * 1024;
        let sendBuffer = new Uint8Array(SEND_BUFFER_SIZE);
        let bufferPos  = 0;
        let totalDecompressed = 0;
        let totalSent  = 0;
        let sequenceNum = 0;

        const flushBuffer = async (isFinal) => {
            if (bufferPos === 0) return;

            buf.fill(0);
            buf.set(structPack('<III', 102, 2, bufferPos), 0);
            await this.usbDevice.write(buf.slice(0, this.packetSize));
            await this.usbDevice.read(64, 60);
            await sleep(100);

            let offset = 0;
            let blockCount = 0;

            while (offset < bufferPos) {
                const blockSize = Math.min(this.fileTransferPacketSize, bufferPos - offset);
                let block = sendBuffer.slice(offset, offset + blockSize);

                if (block.length < this.fileTransferPacketSize) {
                    const padded = new Uint8Array(this.fileTransferPacketSize);
                    padded.set(block);
                    block = padded;
                }

                if (blockCount > 0) { try { await this.usbDevice.write(new Uint8Array(0)); } catch (e) {} }
                await this.usbDevice.write(block);
                await this.usbDevice.read(64, 60);
                offset += blockSize;
                blockCount++;
            }

            const completionStatus = isFinal ? 1 : 0;
            buf.fill(0);
            buf.set(structPack('<II', 102, 3), 0);
            buf.set(structPack('<IIIIII', 0, bufferPos, 0, deviceType, partitionId, completionStatus), 8);

            try { await this.usbDevice.write(new Uint8Array(0)); } catch (e) {}
            await this.usbDevice.write(buf.slice(0, this.packetSize));
            try { await this.usbDevice.write(new Uint8Array(0)); } catch (e) {}
            await sleep(100);
            await this.usbDevice.read(64, 120);

            totalSent += bufferPos;
            this.log(`  ✓ Sent ${formatBytes(bufferPos)}, total: ${formatBytes(totalSent)}`);
            bufferPos = 0;
            sequenceNum++;

            if (this.progressCallback) {
                const p = new DownloadProgress();
                p.currentFile = item.filename;
                p.bytesTransferred = totalSent;
                p.totalBytes = totalDecompressed;
                p.percentage = totalDecompressed > 0 ? (totalSent / totalDecompressed) * 100 : 0;
                this.progressCallback(p);
            }
        };

        this.log(`  Starting streaming decompression of ${formatBytes(item.info.actualSize)}...`);

        try {
            await decoder.decompressStreaming(
                item.info.fileHandle,
                item.info.fileOffset,
                item.info.actualSize,
                async (decompressedBlock) => {
                    totalDecompressed += decompressedBlock.length;
                    let blockOffset = 0;

                    while (blockOffset < decompressedBlock.length) {
                        const copySize = Math.min(SEND_BUFFER_SIZE - bufferPos, decompressedBlock.length - blockOffset);
                        sendBuffer.set(decompressedBlock.slice(blockOffset, blockOffset + copySize), bufferPos);
                        bufferPos   += copySize;
                        blockOffset += copySize;
                        if (bufferPos >= SEND_BUFFER_SIZE) await flushBuffer(false);
                    }

                    decompressedBlock = null;
                }
            );

            if (bufferPos > 0) await flushBuffer(true);
        } catch (error) {
            throw new Error(`Streaming decompression failed: ${error.message}`);
        }

        this.log(`✓ Streaming transfer complete: ${formatBytes(totalSent)} sent`);
        sendBuffer = null;
        return true;
    }

    async closeConnection() {
        this.log("Closing connection...");
        try {
            const buf = new Uint8Array(1024);
            buf.set(structPack('<III', 103, 0, 0), 0);
            await this.usbDevice.write(buf.slice(0, this.packetSize));
            await this.usbDevice.read(64, TIMEOUT_TRANSFER);
            this.log("Connection closed");
        } catch (error) {
            log(`closeConnection error: ${error.message}`, 'warning');
        }
    }

    async rebootDevice() {
        this.log("Rebooting device...");
        try {
            const buf = new Uint8Array(1024);
            buf.set(structPack('<III', 103, 1, 0), 0);
            await this.usbDevice.write(buf.slice(0, this.packetSize));
            this.log("Reboot command sent");
        } catch (error) {
            this.log("Device rebooting...");
        }
    }
}

// ─── FirmwareItem / FirmwareData / FirmwareParser ────────────────────────────

class FirmwareItem {
    constructor(filename, data, info) {
        this.filename = filename;
        this.data     = data;
        this.info     = info || {};
    }
}

class FirmwareData {
    constructor() {
        this.items    = [];
        this.md5Hash  = null;
        this.pitData  = null;
        this.manifest = null;
    }
}

class FirmwareParser {
    constructor(verbose = false) { this.verbose = verbose; }

    log(message) {
        if (this.verbose) log(`[FirmwareParser] ${message}`, 'info');
    }

    async parse(file, verifyHash = false) {
        this.log(`Parsing firmware: ${file.name}`);
        const firmwareData = new FirmwareData();
        const data = await this.readFile(file);
        const fileType = detectFileType(file.name, data);
        this.log(`Detected file type: ${fileType}`);

        if (file.name.toLowerCase().endsWith('.md5')) {
            const result = await this.parseMD5File(data);
            firmwareData.md5Hash = result.md5Hash;
            this.log(`MD5 hash from file: ${result.md5Hash}`);
            await this.parseTAR(result.tarData, firmwareData);
        } else if (fileType === 'tar.gz') {
            await this.parseTARGZ(data, firmwareData);
        } else if (fileType === 'tar') {
            await this.parseTAR(data, firmwareData);
        } else if (fileType === 'bin' || fileType === 'img') {
            firmwareData.requiresPitMatching = true;
            firmwareData.items.push(new FirmwareItem(file.name, data, {
                size: data.length,
                actualSize: data.length,
                compression_type: 'none',
                is_compressed: false,
                isDirectImage: true,
                targetPartition: this.inferPartitionNameFromFilename(file.name)
            }));
        } else {
            throw new Error(`Unsupported file type: ${fileType}`);
        }

        this.log(`Parsed ${firmwareData.items.length} firmware items`);
        return firmwareData;
    }

    inferPartitionNameFromFilename(filename) {
        return String(filename || '')
            .toLowerCase()
            .replace(/\\/g, '/')
            .split('/')
            .pop()
            .replace(/\.lz4$/i, '')
            .replace(/\.gz$/i, '')
            .replace(/\.img$/i, '')
            .replace(/\.bin$/i, '');
    }

    async readFile(file) {
        if (!file) throw new Error("No file provided");
        if (!(file instanceof File) && !(file instanceof Blob)) throw new Error("Invalid file object");
        this.log(`Reading file: ${file.name} (${formatBytes(file.size)})`);

        if (file.arrayBuffer && typeof file.arrayBuffer === 'function') {
            try {
                const buffer = await file.arrayBuffer();
                this.log(`File read successfully: ${formatBytes(buffer.byteLength)}`);
                return new Uint8Array(buffer);
            } catch (error) {
                this.log(`File.arrayBuffer() failed: ${error.message}, falling back to FileReader`, 'warning');
            }
        }

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                if (!e.target.result) { reject(new Error("FileReader returned empty result")); return; }
                resolve(new Uint8Array(e.target.result));
            };
            reader.onerror = () => reject(new Error(`Failed to read file: ${reader.error?.message || 'Unknown error'}`));
            reader.onprogress = (e) => {
                if (e.lengthComputable) {
                    const pct = (e.loaded / e.total) * 100;
                    if (pct % 25 < 1) this.log(`Reading: ${pct.toFixed(0)}%`);
                }
            };
            try { reader.readAsArrayBuffer(file); }
            catch (error) { reject(new Error(`Failed to start reading file: ${error.message}`)); }
        });
    }

    async parseMD5File(data) {
        let offset = 0;
        while (offset < data.length && data[offset] !== 0x0A) offset++;
        offset++;
        const md5Line = new TextDecoder().decode(data.slice(0, offset));
        const md5Match = md5Line.match(/([a-fA-F0-9]{32})/);
        const md5Hash = md5Match ? md5Match[1].toLowerCase() : null;
        this.log(`Extracted MD5: ${md5Hash}`);
        return { md5Hash, tarData: data.slice(offset) };
    }

    async parseTARGZ(data, firmwareData) {
        this.log("Decompressing GZIP data...");
        if (typeof pako === 'undefined') throw new Error("pako library not loaded");
        try {
            const decompressed = pako.inflate(data);
            this.log(`Decompressed ${data.length} -> ${decompressed.length} bytes`);
            await this.parseTAR(decompressed, firmwareData);
        } catch (error) {
            throw new Error(`GZIP decompression failed: ${error.message}`);
        }
    }

    async parseTAR(data, firmwareData) {
        this.log("Parsing TAR archive...");
        let offset = 0;

        while (offset < data.length) {
            if (offset + 512 > data.length) break;
            const header = data.slice(offset, offset + 512);
            if (this.isZeroBlock(header)) break;

            const filename = readString(header, 0, 100).trim();
            const size     = parseInt(readString(header, 124, 12).trim(), 8);

            if (!filename || isNaN(size)) { offset += 512; continue; }

            this.log(`Found: ${filename} (${formatBytes(size)})`);
            offset += 512;

            const fileData        = data.slice(offset, offset + size);
            const compressionType = detectCompressionType(fileData);
            const item            = new FirmwareItem(filename, fileData, {
                size, compression_type: compressionType, is_compressed: compressionType !== 'none'
            });

            if (filename.toLowerCase().endsWith('.pit')) {
                firmwareData.pitData = fileData;
                this.log("Found PIT file");
            }

            firmwareData.items.push(item);
            offset += Math.ceil(size / 512) * 512;
        }

        this.log(`Extracted ${firmwareData.items.length} files from TAR`);
    }

    isZeroBlock(block) {
        for (let i = 0; i < Math.min(block.length, 512); i++) {
            if (block[i] !== 0) return false;
        }
        return true;
    }

    async decompressItem(item) {
        if (!item.info.is_compressed) return item.data;
        const compressionType = item.info.compression_type;
        this.log(`Decompressing ${item.filename} (${compressionType})...`);

        if (compressionType === 'gzip') {
            if (typeof pako === 'undefined') throw new Error("pako library not loaded");
            return pako.inflate(item.data);
        } else if (compressionType === 'lz4') {
            if (typeof lz4 === 'undefined' || typeof lz4.decode !== 'function') throw new Error("LZ4 library not loaded");
            const dec = lz4.decode(item.data);
            if (!dec || dec.length === 0) throw new Error('LZ4 decompression returned empty data');
            return dec instanceof Uint8Array ? dec : new Uint8Array(dec);
        }

        return item.data;
    }
}

// pako stub (CDN in index.html is the real source; this is a fallback)
(function () {
    if (typeof window.pako !== 'undefined') return;
    window.pako = {
        inflate: function () {
            log('Error: pako library not loaded. Include pako for GZIP support.', 'error');
            throw new Error('pako library required for GZIP decompression');
        }
    };
})();

// ─── PitEntry / PitData / PitParser ─────────────────────────────────────────

class PitEntry {
    constructor() {
        this.binaryType    = 0; this.deviceType    = 0; this.partitionId   = 0;
        this.partitionType = 0; this.filesystem    = 0; this.startBlock    = 0;
        this.numBlocks     = 0; this.fileOffset    = 0; this.fileSize      = 0;
        this.partitionName = ""; this.flashFilename = ""; this.fotaFilename  = "";
    }
    toString() { return `PitEntry(name='${this.partitionName}', id=${this.partitionId}, blocks=${this.numBlocks})`; }
}

class PitData {
    constructor() { this.magic = 0; this.count = 0; this.entries = []; }
    getEntryByName(name) { return this.entries.find(e => e.partitionName === name); }
    getEntryById(id)     { return this.entries.find(e => e.partitionId   === id);   }
    toString()           { return `PitData(entries=${this.entries.length})`;          }
}

class PitParser {
    constructor(verbose = false) { this.verbose = verbose; }

    log(message) {
        if (this.verbose) log(`[PitParser] ${message}`, 'info');
    }

    parse(pitData) {
        if (pitData.length < PIT_HEADER_SIZE) throw new Error("PIT data too small");
        this.log(`Parsing PIT data (${pitData.length} bytes)...`);

        const magic = LEToNumber(pitData, 0, 4);
        const count = LEToNumber(pitData, 4, 4);

        if (magic !== PIT_MAGIC) throw new Error(`Invalid PIT magic: 0x${magic.toString(16).padStart(8,'0')}`);
        this.log(`PIT magic: 0x${magic.toString(16).padStart(8,'0')}, entries: ${count}`);

        const pit = new PitData();
        pit.magic = magic;
        pit.count = count;

        let offset = PIT_HEADER_SIZE;
        for (let i = 0; i < count; i++) {
            if (offset + PIT_ENTRY_SIZE > pitData.length) { this.log(`Warning: Truncated PIT at entry ${i}`); break; }
            const entry = this.parseEntry(pitData, offset);
            pit.entries.push(entry);
            this.log(`  [${i}] ${entry.partitionName} (ID: ${entry.partitionId}, blocks: ${entry.numBlocks})`);
            offset += PIT_ENTRY_SIZE;
        }

        this.log(`Parsed ${pit.entries.length} PIT entries`);
        return pit;
    }

    parseEntry(data, offset) {
        const e = new PitEntry();
        e.binaryType    = LEToNumber(data, offset + 0,   4);
        e.deviceType    = LEToNumber(data, offset + 4,   4);
        e.partitionId   = LEToNumber(data, offset + 8,   4);
        e.partitionType = LEToNumber(data, offset + 12,  4);
        e.filesystem    = LEToNumber(data, offset + 16,  4);
        e.startBlock    = LEToNumber(data, offset + 20,  4);
        e.numBlocks     = LEToNumber(data, offset + 24,  4);
        e.fileOffset    = LEToNumber(data, offset + 28,  4);
        e.fileSize      = LEToNumber(data, offset + 32,  4);
        e.partitionName = readString(data, offset + 36,  32);
        e.flashFilename = readString(data, offset + 68,  32);
        e.fotaFilename  = readString(data, offset + 100, 32);
        return e;
    }

    serialize(pitData) {
        const totalSize = PIT_HEADER_SIZE + pitData.entries.length * PIT_ENTRY_SIZE;
        const buffer    = new Uint8Array(totalSize);
        buffer.set(numberToLE(pitData.magic, 4), 0);
        buffer.set(numberToLE(pitData.count, 4), 4);
        let offset = PIT_HEADER_SIZE;
        for (const entry of pitData.entries) { this.serializeEntry(entry, buffer, offset); offset += PIT_ENTRY_SIZE; }
        return buffer;
    }

    serializeEntry(e, buffer, offset) {
        buffer.set(numberToLE(e.binaryType,    4), offset + 0);
        buffer.set(numberToLE(e.deviceType,    4), offset + 4);
        buffer.set(numberToLE(e.partitionId,   4), offset + 8);
        buffer.set(numberToLE(e.partitionType, 4), offset + 12);
        buffer.set(numberToLE(e.filesystem,    4), offset + 16);
        buffer.set(numberToLE(e.startBlock,    4), offset + 20);
        buffer.set(numberToLE(e.numBlocks,     4), offset + 24);
        buffer.set(numberToLE(e.fileOffset,    4), offset + 28);
        buffer.set(numberToLE(e.fileSize,      4), offset + 32);
        this._writeStr(buffer, offset + 36,  e.partitionName, 32);
        this._writeStr(buffer, offset + 68,  e.flashFilename, 32);
        this._writeStr(buffer, offset + 100, e.fotaFilename,  32);
    }

    _writeStr(buffer, offset, str, maxLength) {
        const bytes = new TextEncoder().encode(str);
        const len   = Math.min(bytes.length, maxLength - 1);
        buffer.set(bytes.slice(0, len), offset);
        buffer[offset + len] = 0;
    }
}

// ─── CryptoUtils ─────────────────────────────────────────────────────────────

class CryptoUtils {
    static async calculateMD5(data) { return await this._md5Simple(data); }

    static async calculateSHA256(data) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2,'0')).join('');
    }

    static async _md5Simple(data) {
        if (typeof SparkMD5 !== 'undefined') {
            const spark = new SparkMD5.ArrayBuffer();
            spark.append(data);
            return spark.end();
        }
        log('Warning: Using fallback hash calculation (not real MD5)', 'warning');
        let hash = 0;
        for (let i = 0; i < Math.min(data.length, 10000); i++) { hash = ((hash << 5) - hash) + data[i]; hash = hash & hash; }
        return Math.abs(hash).toString(16).padStart(32, '0');
    }

    static async verifyMD5(data, expectedHash) {
        return (await this.calculateMD5(data)).toLowerCase() === expectedHash.toLowerCase();
    }

    static extractMD5FromFile(content) {
        const lines = new TextDecoder().decode(content).split('\n');
        for (const line of lines) {
            const match = line.match(/^([a-fA-F0-9]{32})/);
            if (match) return match[1].toLowerCase();
        }
        return null;
    }

    static async calculateMD5WithProgress(data, progressCallback) {
        const chunkSize   = 1024 * 1024;
        const totalChunks = Math.ceil(data.length / chunkSize);

        if (typeof SparkMD5 !== 'undefined') {
            const spark = new SparkMD5.ArrayBuffer();
            for (let i = 0; i < totalChunks; i++) {
                spark.append(data.slice(i * chunkSize, Math.min((i + 1) * chunkSize, data.length)));
                if (progressCallback) progressCallback(((i + 1) / totalChunks) * 100);
                if (i % 10 === 0) await sleep(0);
            }
            return spark.end();
        }

        return await this._md5Simple(data);
    }
}

// SparkMD5 stub (CDN in index.html is the real source; this is a fallback)
(function () {
    if (typeof window.SparkMD5 !== 'undefined') return;
    window.SparkMD5 = {
        ArrayBuffer: function () {
            this._data = [];
            this.append = function (ab) { this._data.push(...new Uint8Array(ab)); };
            this.end    = function () {
                let hash = 5381;
                for (let i = 0; i < this._data.length; i++) hash = ((hash << 5) + hash) + this._data[i];
                const hex = Math.abs(hash).toString(16).padStart(8, '0');
                return (hex + hex + hex + hex).substring(0, 32);
            };
        }
    };
    log('Using built-in MD5 stub (not cryptographically secure)', 'warning');
})();

// ─── OdinFlasher ─────────────────────────────────────────────────────────────

class OdinFlasher {
    constructor(verbose = false) {
        this.verbose        = verbose;
        this.usbDevice      = null;
        this.downloadEngine = null;
        this.firmwareParser = new FirmwareParser(verbose);
        this.pitParser      = new PitParser(verbose);
        this.deviceInfo     = null;
        this.isConnected    = false;
    }

    log(message) {
        if (this.verbose) log(`[OdinFlasher] ${message}`, 'info');
    }

    async listDevices() { return await UsbDevice.listDevices(); }

    async connectDevice() {
        this.log("Connecting to device...");

        try {
            this.usbDevice = new UsbDevice(this.verbose);
            const deviceInfo = await this.usbDevice.findDevice();
            if (!deviceInfo) throw new Error("No Samsung device found in Download mode");

            this.log(`Found device: ${deviceInfo}`);
            if (!await this.usbDevice.connect()) throw new Error("Failed to connect to device");

            this.downloadEngine = new DownloadEngine(this.usbDevice, this.verbose);

            // Step 1: Handshake
            this.log("Step 1: Handshake...");
            if (!await this.downloadEngine.handshake()) throw new Error("Failed handshake - device did not respond with 'LOKE'");

            // Step 2: Protocol version (100/0/4)
            this.log("Step 2: Getting protocol version (100/0/4)...");
            const buf = new Uint8Array(1024);
            buf.set(structPack('<III', 100, 0, 4), 0);
            await this.usbDevice.write(buf.slice(0, this.downloadEngine.packetSize));

            const resp = await this.usbDevice.read(64, 60);
            if (resp.length < 8) throw new Error(`No valid response to protocol version request (got ${resp.length} bytes)`);

            const [cmd, data] = structUnpack('<II', resp);
            const version                 = (data >> 16) & 0xFFFF;
            const deviceDefaultPacketSize = data & 0xFFFF;
            this.downloadEngine.protocolVersion = version;
            this.log(`✓ Protocol version: ${version}, default packet size: ${deviceDefaultPacketSize}`);

            // Step 3: File part size (100/5) if supported
            if (deviceDefaultPacketSize !== 0) {
                this.log("Step 3: Sending file part size (100/5)...");
                buf.fill(0);
                buf.set(structPack('<III', 100, 5, 0x100000), 0);
                await this.usbDevice.write(buf.slice(0, this.downloadEngine.packetSize));
                const resp2 = await this.usbDevice.read(64, TIMEOUT_HANDSHAKE);

                if (resp2.length >= 8) {
                    const [, result] = structUnpack('<II', resp2);
                    this.log(`✓ File part size response: ${result}`);
                    if (result !== 0) throw new Error(`Device rejected file part size: ${result}`);
                }
            } else {
                this.log("Step 3: Skipped (device doesn't support file part size)");
            }

            this.deviceInfo = await this.downloadEngine.getDeviceInfo();
            this.deviceInfo.protocolVersion = this.downloadEngine.protocolVersion;
            this.isConnected = true;

            this.log(`Connected to device: ${this.deviceInfo}`);
            return this.deviceInfo;

        } catch (error) {
            log(`Connection failed: ${error.message}`, 'error');
            throw error;
        }
    }

    async disconnectDevice() {
        if (this.downloadEngine) await this.downloadEngine.closeConnection();
        if (this.usbDevice)      await this.usbDevice.disconnect();
        this.isConnected = false;
        this.log("Disconnected from device");
    }

    async loadFirmware(file, verifyHash = true) {
        this.log(`Loading firmware: ${file.name}`);
        const firmwareData = await this.firmwareParser.parse(file, verifyHash);
        this.log(`Loaded ${firmwareData.items.length} firmware items`);
        return firmwareData;
    }

    createImageFirmware(file, partitionName) {
        if (!file) throw new Error("No image file provided");
        if (!partitionName) throw new Error("No target partition provided");

        const lowerName = file.name.toLowerCase();
        const isCompressed = lowerName.endsWith('.lz4') || lowerName.endsWith('.gz');
        const compressionType = lowerName.endsWith('.lz4') ? 'lz4' : (lowerName.endsWith('.gz') ? 'gzip' : 'none');
        const firmwareData = new FirmwareData();
        firmwareData.requiresPitMatching = true;
        firmwareData.items.push(new FirmwareItem(file.name, null, {
            size: file.size,
            actualSize: file.size,
            compression_type: compressionType,
            is_compressed: isCompressed,
            isLargeFile: true,
            isDirectImage: true,
            fileHandle: file,
            fileOffset: 0,
            partitionName,
            targetPartition: partitionName
        }));

        return firmwareData;
    }

    async loadPit(pitData) {
        this.log(`Loading PIT...`);
        const pit = this.pitParser.parse(pitData);
        this.log(`Loaded PIT with ${pit.entries.length} entries`);
        return pit;
    }

    async flash(firmwareData, pitData = null, reboot = true, progressCallback = null) {
        if (!this.isConnected)    throw new Error("Not connected to device");
        if (!this.downloadEngine) throw new Error("Download engine not initialized");

        this.log("Starting firmware flash...");
        if (progressCallback) this.downloadEngine.setProgressCallback(progressCallback);

        try {
            // Calculate total bytes
            this.log("Calculating total bytes to send...");
            let totalBytes = 0;

            for (const item of firmwareData.items) {
                if (item.filename.includes('meta-data/') || item.filename.endsWith('.zip')) continue;

                if (!item.data && item.info.isLargeFile) {
                    if (item.filename.endsWith('.lz4'))      totalBytes += item.info.actualSize * 4;
                    else if (item.filename.endsWith('.gz'))  totalBytes += item.info.actualSize * 3;
                    else                                     totalBytes += item.info.actualSize;
                } else if (item.data) {
                    totalBytes += item.data.length;
                }
            }

            this.log(`Total bytes to send: ${formatBytes(totalBytes)}`);

            const buf = new Uint8Array(1024);
            buf.set(structPack('<II', 100, 2), 0);
            buf.set(structPack('<Q', totalBytes), 8);

            await this.downloadEngine.usbDevice.write(buf.slice(0, this.downloadEngine.packetSize));
            const resp = await this.downloadEngine.usbDevice.read(64, TIMEOUT_TRANSFER);
            if (resp.length < 8) throw new Error("No response to 100/2 packet");

            const [respCmd, respData] = structUnpack('<II', resp);
            if (respCmd !== 100 || respData !== 0) throw new Error(`Device rejected 100/2: cmd=${respCmd}, result=${respData}`);
            this.log("✓ Initialization complete");

            let pitForMatching = null;
            const protocolVersion = this.deviceInfo?.protocolVersion || 2;
            const needsPitMatching = firmwareData.requiresPitMatching ||
                firmwareData.items.some(item => item.info.isDirectImage || item.info.partitionName || item.info.targetPartition);
            this.log(`Device protocol version: ${protocolVersion}`);

            if (protocolVersion <= 3) {
                this.log("Protocol v2/v3 - will retrieve PIT...");
                if (!await this.downloadEngine.sendPitInfo()) throw new Error("sendPitInfo failed");

                const embeddedPit = pitData || firmwareData.pitData;
                if (embeddedPit) {
                    if (!await this.downloadEngine.sendPitData(embeddedPit)) throw new Error("Failed to send PIT data");
                    pitForMatching = embeddedPit;
                }

                try {
                    pitForMatching = await this.downloadEngine.receivePitData();
                    this.log(`✓ Retrieved PIT (${pitForMatching.length} bytes)`);
                } catch (error) {
                    this.log(`ERROR: Could not retrieve PIT: ${error.message}`);
                    throw error;
                }
            } else {
                const embeddedPit = pitData || firmwareData.pitData;
                if (embeddedPit) {
                    if (!await this.downloadEngine.sendPitData(embeddedPit)) throw new Error("Failed to send PIT data");
                    pitForMatching = embeddedPit;
                }
            }

            if (!pitForMatching && needsPitMatching) {
                this.log("Direct image flashing requires PIT partition matching - retrieving PIT...");
                try {
                    pitForMatching = await this.downloadEngine.receivePitData();
                    this.log(`✓ Retrieved PIT (${pitForMatching.length} bytes)`);
                } catch (error) {
                    this.log(`Could not retrieve PIT for direct image matching: ${error.message}`);
                    throw new Error("Cannot safely flash direct image without PIT partition data");
                }
            }

            this.log("Uploading firmware binaries...");
            if (!await this.downloadEngine.uploadBinaries(firmwareData, pitForMatching)) {
                throw new Error("Failed to upload firmware binaries");
            }

            this.log("Firmware flashed successfully!");

            try { await this.downloadEngine.closeConnection(); await sleep(500); }
            catch (error) { this.log(`Warning: Error closing connection: ${error.message}`); }

            if (reboot) {
                this.log("Rebooting device...");
                try { await this.downloadEngine.rebootDevice(); await sleep(1000); } catch (e) { /* normal */ }
            } else {
                this.log("Skipping reboot (auto-reboot disabled)", 'warning');
            }

            return true;

        } catch (error) {
            this.log(`Flashing failed: ${error.message}`);
            throw error;
        }
    }

    async dumpPit() {
        if (!this.isConnected)    throw new Error("Not connected to device");
        if (!this.downloadEngine) throw new Error("Download engine not initialized");
        this.log("Dumping PIT from device...");
        const pitData = await this.downloadEngine.receivePitData();
        this.log(`PIT dumped successfully (${pitData.length} bytes)`);
        return pitData;
    }

    getDeviceInfo() { return this.deviceInfo; }
}

// ─── SBootDevice ─────────────────────────────────────────────────────────────

/**
 * SBootDevice — low-level Samsung sboot / Heimdall facade.
 *
 * Usage:
 *   const device = await SBootDevice.requestAndConnect();
 *   await device.send(packet);
 *   const reply  = await device.receive(512);
 *   await device.close();
 */
class SBootDevice {
    /** @param {SBootTransport} transport */
    constructor(transport) {
        this.transport = transport;
        this.protocol  = new SBootProtocol(transport);
        log('[SBootDevice] Device instance created', 'info');
    }

    /** Convenience factory: USB picker → connect → handshake. */
    static async requestAndConnect() {
        const transport = await SBootTransport.requestSamsungDevice();
        const device    = new SBootDevice(transport);
        await device.connect();
        return device;
    }

    async connect() {
        log('[SBootDevice] Connecting transport...', 'info');
        await this.transport.connect();
        log('[SBootDevice] Transport connected', 'info');
        await this.protocol.connect();
        log('[SBootDevice] Protocol layer connected', 'info');
        await this.protocol.initialise();
        log('[SBootDevice] Samsung handshake complete ✓', 'success');
    }

    async send(data)             { return this.protocol.send(data); }
    async receive(length = 512)  { return this.protocol.receive(length); }
    async close()                { await this.transport.close(); log('[SBootDevice] Device closed', 'info'); }
}
