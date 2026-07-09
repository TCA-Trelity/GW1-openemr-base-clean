// Load probe (S3.1): fire concurrent GETs at the DETERMINISTIC read path (the landing-page
// endpoints — no LLM cost, no spend-budget impact) and report throughput, p50/p95/p99 latency,
// and error rate. Run it against a live sidecar to produce REAL baselines (this script measures;
// it never asserts a fabricated number):
//   node dist/scripts/load-test.js        (in the container / Railway)
//   npx tsx src/scripts/load-test.ts      (locally)
// Env:
//   LOAD_BASE_URL       required, e.g. https://enchanting-mercy-production-5d32.up.railway.app
//   LOAD_CONCURRENCY    concurrent workers (default 10)
//   LOAD_DURATION_SEC   test length (default 20)
//   LOAD_P95_MAX_MS     p95 SLO gate (default 1500) — the read path should be well under this
//   LOAD_PATIENT        patient id for the overview endpoint (default margaret-chen)
// Exits non-zero if any request errored or p95 exceeded the SLO, so CI can gate on it.

const baseUrl = (process.env['LOAD_BASE_URL'] ?? '').replace(/\/+$/, '');
if (baseUrl === '') {
    console.error('LOAD_BASE_URL is required (e.g. https://<sidecar>.up.railway.app)');
    process.exit(1);
}
const concurrency = Math.max(1, Number(process.env['LOAD_CONCURRENCY'] ?? 10));
const durationSec = Math.max(1, Number(process.env['LOAD_DURATION_SEC'] ?? 20));
const p95MaxMs = Math.max(1, Number(process.env['LOAD_P95_MAX_MS'] ?? 1500));
const patient = process.env['LOAD_PATIENT'] ?? 'margaret-chen';

// The deterministic landing path: readiness + the two reads that render the whole overview.
// No prep/chat here — those cost model tokens and are budget-gated by design.
const PATHS: readonly string[] = ['/ready', '/api/patients', `/api/overview/${encodeURIComponent(patient)}`];

interface Sample {
    ms: number;
    ok: boolean;
}

const samples: Sample[] = [];

async function worker(deadlineMs: number, startOffset: number): Promise<void> {
    let next = startOffset;
    while (performance.now() < deadlineMs) {
        const path = PATHS[next % PATHS.length] ?? '/ready';
        next += 1;
        const start = performance.now();
        let ok = false;
        try {
            const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(30_000) });
            ok = response.ok;
            await response.arrayBuffer(); // fully drain the body so the timing includes transfer
        } catch {
            ok = false;
        }
        samples.push({ ms: performance.now() - start, ok });
    }
}

function percentile(sortedAsc: readonly number[], p: number): number {
    if (sortedAsc.length === 0) {
        return 0;
    }
    const index = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
    return sortedAsc[index] ?? 0;
}

async function main(): Promise<void> {
    console.log(`load-test: ${concurrency} concurrent × ${durationSec}s against ${baseUrl}`);
    const deadline = performance.now() + durationSec * 1000;
    // Each worker starts at a different path offset so the rotation is deterministic (no RNG).
    await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(deadline, index)));

    const total = samples.length;
    const errors = samples.filter((sample) => !sample.ok).length;
    const latencies = samples.map((sample) => sample.ms).sort((a, b) => a - b);
    const errorRate = total === 0 ? 1 : errors / total;
    const report = {
        concurrency,
        durationSec,
        totalRequests: total,
        throughputPerSec: Math.round(total / durationSec),
        errorRate: Number(errorRate.toFixed(4)),
        latencyMs: {
            p50: Math.round(percentile(latencies, 50)),
            p95: Math.round(percentile(latencies, 95)),
            p99: Math.round(percentile(latencies, 99)),
            max: Math.round(latencies.at(-1) ?? 0),
        },
        p95SloMs: p95MaxMs,
    };
    console.log(JSON.stringify(report, null, 2));

    const failures: string[] = [];
    if (errorRate > 0) {
        failures.push(`error rate ${(errorRate * 100).toFixed(2)}% > 0`);
    }
    if (report.latencyMs.p95 > p95MaxMs) {
        failures.push(`p95 ${report.latencyMs.p95}ms > SLO ${p95MaxMs}ms`);
    }
    if (failures.length > 0) {
        console.error(`load-test FAIL: ${failures.join('; ')}`);
        process.exit(1);
    }
    console.log('load-test PASS');
}

main().catch((error: unknown) => {
    console.error('load-test failed:', error);
    process.exit(1);
});
