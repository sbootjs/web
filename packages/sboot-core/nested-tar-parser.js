/**
 * Header-only parser for nested TAR files.
 */
class NestedTarParser {
    constructor(verbose = false) {
        this.verbose = verbose;
    }

    writeLog(message, type = 'info') {
        if (this.verbose && typeof log === 'function') {
            log(`[NestedTarParser] ${message}`, type);
        }
    }

    async parseNestedTar(containerFile, tarInfo) {
        const files = [];
        let currentOffset = tarInfo.offset;
        const endOffset = tarInfo.offset + tarInfo.size;

        while (currentOffset + 512 <= endOffset && files.length < 1000) {
            const headerBuffer = await containerFile
                .slice(currentOffset, currentOffset + 512)
                .arrayBuffer();
            const header = new Uint8Array(headerBuffer);

            let allZero = true;
            for (let i = 0; i < 512; i++) {
                if (header[i] !== 0) {
                    allZero = false;
                    break;
                }
            }
            if (allZero) break;

            const filename = readString(header, 0, 100).trim();
            const sizeStr = readString(header, 124, 12).trim();
            const size = parseInt(sizeStr, 8);

            if (!filename || Number.isNaN(size) || size < 0) {
                currentOffset += 512;
                continue;
            }

            files.push({
                filename,
                size,
                offset: currentOffset + 512,
                isCompressed: filename.toLowerCase().endsWith('.lz4') || filename.toLowerCase().endsWith('.gz'),
                parentTar: tarInfo.filename
            });

            this.writeLog(`${filename}: ${formatBytes(size)}`);
            currentOffset += 512 + Math.ceil(size / 512) * 512;
        }

        return files;
    }
}
