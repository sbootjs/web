/**
 * Minimal ZIP parser placeholder.
 *
 * ZIP support needs central-directory parsing and optional DEFLATE streaming.
 * The main TAR / TAR.MD5 flashing path does not depend on ZIP support.
 */
class ZipParser {
    constructor(verbose = false) {
        this.verbose = verbose;
    }

    async parseZip() {
        throw new Error('ZIP firmware parsing is not implemented in this build. Select BL/AP/CP/CSC TAR or TAR.MD5 files instead.');
    }

    async extractFile() {
        throw new Error('ZIP extraction is not implemented in this build.');
    }
}
