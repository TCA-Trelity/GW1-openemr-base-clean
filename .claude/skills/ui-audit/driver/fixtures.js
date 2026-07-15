import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves upload fixtures. The oversized fixture is generated at run time
 * rather than committed to the skill, so the repo doesn't carry a large
 * binary blob for a value that's cheap to synthesize on demand.
 */
export function resolveFixtures(config) {
    const defaultsDir = path.join(config.skillRoot, 'fixtures', 'uploads');
    const overrides = config.uploadFixtureOverrides || {};

    return {
        valid: overrides.valid || path.join(defaultsDir, 'valid-small.pdf'),
        validImage: overrides.validImage || path.join(defaultsDir, 'valid-image.png'),
        wrongType: overrides.wrongType || path.join(defaultsDir, 'wrong-type.txt'),
        oversized: overrides.oversized || generateOversizedFixture(config),
    };
}

/** Picks the valid-file fixture that best matches a file input's `accept` attribute. */
export function pickValidFixture(fixtures, accept) {
    if (accept && /image/i.test(accept)) return fixtures.validImage;
    return fixtures.valid;
}

function generateOversizedFixture(config) {
    const dir = path.join(config.outDir, '_fixtures');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'oversized.bin');
    const sizeBytes = config.oversizedFixtureMb * 1024 * 1024;

    if (fs.existsSync(filePath) && fs.statSync(filePath).size === sizeBytes) {
        return filePath;
    }

    const chunk = Buffer.alloc(1024 * 1024, 0x2a);
    const fd = fs.openSync(filePath, 'w');
    let written = 0;
    try {
        while (written < sizeBytes) {
            const remaining = sizeBytes - written;
            const toWrite = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
            written += fs.writeSync(fd, toWrite);
        }
    } finally {
        fs.closeSync(fd);
    }
    return filePath;
}
