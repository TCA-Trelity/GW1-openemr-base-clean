import fs from 'node:fs';
import path from 'node:path';

export class Manifest {
    constructor(outDir) {
        this.outDir = outDir;
        this.screensDir = path.join(outDir, 'screens');
        fs.mkdirSync(this.screensDir, { recursive: true });
        this.manifestPath = path.join(outDir, 'manifest.jsonl');
        this.fd = fs.openSync(this.manifestPath, 'a');
        this.counts = {};
    }

    append(entry) {
        fs.writeSync(this.fd, JSON.stringify(entry) + '\n');
        const t = entry.type || 'unknown';
        this.counts[t] = (this.counts[t] || 0) + 1;
    }

    writeSummary(summary) {
        const payload = { ...summary, counts: this.counts, manifestPath: this.manifestPath };
        fs.writeFileSync(path.join(this.outDir, 'run-summary.json'), JSON.stringify(payload, null, 2));
        return payload;
    }

    close() {
        fs.closeSync(this.fd);
    }
}
