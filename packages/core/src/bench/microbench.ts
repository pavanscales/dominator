import { now, elapsedNs, calibrate, getOverhead, toMs, formatOps, getClockName } from './measurement';

export interface BenchConfig {
    warmupMs: number;
    measureMs: number;
    maxSamples: number;
    batchSize: number;
    autoBatch: boolean;
    detectGC: boolean;
    gcThresholdSigma: number;
}

export interface BenchStats {
    label: string;
    n: number;
    totalNs: number;
    meanNs: number;
    medianNs: number;
    minNs: number;
    maxNs: number;
    p25Ns: number;
    p75Ns: number;
    p95Ns: number;
    p99Ns: number;
    p999Ns: number;
    stddevNs: number;
    cv: number;
    opsPerSec: number;
    overheadNs: number;
    gcPauses: number;
    outlierCount: number;
    batchSize: number;
    warmupMs: number;
    measureMs: number;
}

export type ScaleResult = Map<number, BenchStats>;

const DEFAULT_CONFIG: BenchConfig = {
    warmupMs: 100,
    measureMs: 500,
    maxSamples: 100_000,
    batchSize: 0,
    autoBatch: true,
    detectGC: true,
    gcThresholdSigma: 5,
};

export function bench(
    label: string,
    fn: () => void,
    config?: Partial<BenchConfig>
): BenchStats {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const oh = calibrate(10000);

    const probeStart = now();
    const probeCount = 10000;
    for (let i = 0; i < probeCount; i++) fn();
    const probeNs = elapsedNs(probeStart);
    const estimateNs = probeNs / probeCount;

    const useBatch = cfg.autoBatch && (estimateNs < oh * 2 || cfg.batchSize > 0);
    let batchSize = cfg.batchSize;
    if (useBatch && batchSize === 0) {
        batchSize = Math.max(100, Math.min(10000, Math.ceil(oh * 10 / estimateNs)));
    }

    const warmupDeadline = Number(now()) + cfg.warmupMs * 1_000_000;
    while (Number(now()) < warmupDeadline) fn();

    const measDeadline = Number(now()) + cfg.measureMs * 1_000_000;
    const rawSamples = new Float64Array(cfg.maxSamples);
    let count = 0;

    if (useBatch) {
        while (Number(now()) < measDeadline && count < cfg.maxSamples) {
            const t0 = now();
            for (let b = 0; b < batchSize; b++) fn();
            let delta = elapsedNs(t0);
            delta = delta > oh ? delta - oh : 0;
            rawSamples[count++] = delta / batchSize;
        }
    } else {
        while (Number(now()) < measDeadline && count < cfg.maxSamples) {
            const t0 = now();
            fn();
            let delta = elapsedNs(t0);
            delta = delta > oh ? delta - oh : 0;
            rawSamples[count++] = delta;
        }
    }

    if (count === 0) {
        return {
            label, n: 0, totalNs: 0,
            meanNs: 0, medianNs: 0, minNs: 0, maxNs: 0,
            p25Ns: 0, p75Ns: 0, p95Ns: 0, p99Ns: 0, p999Ns: 0,
            stddevNs: 0, cv: 0, opsPerSec: 0,
            overheadNs: oh, gcPauses: 0, outlierCount: 0,
            batchSize, warmupMs: cfg.warmupMs, measureMs: cfg.measureMs,
        };
    }

    const data = rawSamples.subarray(0, count);
    data.sort();

    const n = data.length;
    const minNs = data[0];
    const maxNs = data[n - 1];
    const medianNs = n % 2 === 0
        ? (data[n / 2 - 1] + data[n / 2]) / 2
        : data[Math.floor(n / 2)];
    const p25Ns = percentile(data, 25);
    const p75Ns = percentile(data, 75);
    const p95Ns = percentile(data, 95);
    const p99Ns = percentile(data, 99);
    const p999Ns = percentile(data, 99.9);

    let sum = 0;
    for (let i = 0; i < n; i++) sum += data[i];
    const meanNs = sum / n;

    let variance = 0;
    for (let i = 0; i < n; i++) {
        const d = data[i] - meanNs;
        variance += d * d;
    }
    const stddevNs = Math.sqrt(variance / n);
    const cv = meanNs > 0 ? stddevNs / meanNs : 0;

    let gcPauses = 0;
    let outlierCount = 0;
    if (cfg.detectGC && meanNs > 0) {
        const gcThreshold = meanNs + cfg.gcThresholdSigma * stddevNs;
        const gcRunCost = meanNs * 50;
        for (let i = 0; i < n; i++) {
            if (data[i] > gcThreshold) outlierCount++;
            if (data[i] > gcRunCost) gcPauses++;
        }
    }

    const totalNs = sum;
    const avgNsPerOp = totalNs / n;
    const opsPerSec = avgNsPerOp > 0 ? 1e9 / avgNsPerOp : 0;

    return {
        label, n, totalNs,
        meanNs, medianNs, minNs, maxNs,
        p25Ns, p75Ns, p95Ns, p99Ns, p999Ns,
        stddevNs, cv, opsPerSec,
        overheadNs: oh, gcPauses, outlierCount,
        batchSize, warmupMs: cfg.warmupMs, measureMs: cfg.measureMs,
    };
}

function percentile(sorted: Float64Array, p: number): number {
    const idx = Math.ceil(sorted.length * p / 100) - 1;
    return sorted[Math.max(0, idx)];
}

export function benchScale(
    label: string,
    factory: (n: number) => () => void,
    scales: number[] = [100, 1_000, 10_000, 100_000],
    config?: Partial<BenchConfig>
): ScaleResult {
    const results: ScaleResult = new Map();
    for (const n of scales) {
        const fn = factory(n);
        const r = bench(`${label} [N=${n.toLocaleString()}]`, fn, config);
        results.set(n, r);
    }
    return results;
}

export function report(stats: BenchStats[]): void {
    const lines: string[] = [];
    lines.push('');
    lines.push('═'.repeat(140));
    lines.push(' MICROBENCH RESULTS');
    lines.push('═'.repeat(140));
    lines.push(
        '│ ' + 'Benchmark'.padEnd(50) +
        '│ Median'.padStart(12) +
        '│ Mean'.padStart(12) +
        '│ P95'.padStart(12) +
        '│ P99'.padStart(12) +
        '│ Ops/s'.padStart(14) +
        '│ σ/μ'.padStart(8) +
        '│ GC'.padStart(6) +
        ' │'
    );
    lines.push('├' + '─'.repeat(52) + '┼' + '─'.repeat(14) + '┼' + '─'.repeat(14) + '┼' + '─'.repeat(14) + '┼' + '─'.repeat(14) + '┼' + '─'.repeat(16) + '┼' + '─'.repeat(10) + '┼' + '─'.repeat(8) + '┤');

    for (const s of stats) {
        lines.push(
            '│ ' + s.label.padEnd(50) +
            '│ ' + toMs(s.medianNs).padStart(10) +
            '│ ' + toMs(s.meanNs).padStart(10) +
            '│ ' + toMs(s.p95Ns).padStart(10) +
            '│ ' + toMs(s.p99Ns).padStart(10) +
            '│ ' + formatOps(s.opsPerSec).padStart(12) +
            '│ ' + (isFinite(s.cv) ? (s.cv * 100).toFixed(1) : '?').padStart(4) + '%' +
            '│ ' + (s.gcPauses > 0 ? s.gcPauses.toString() : '').padStart(4) +
            ' │'
        );
    }
    lines.push('└' + '─'.repeat(52) + '┴' + '─'.repeat(14) + '┴' + '─'.repeat(14) + '┴' + '─'.repeat(14) + '┴' + '─'.repeat(14) + '┴' + '─'.repeat(16) + '┴' + '─'.repeat(10) + '┴' + '─'.repeat(8) + '┘');
    lines.push(`  Clock: ${getClockName()}  Overhead: ${getOverhead().toFixed(0)} ns  Batch: ${stats[0]?.batchSize ?? 'individual'}`);
    lines.push('');
    console.log(lines.join('\n'));
}

export function reportScale(results: ScaleResult, header?: string): void {
    const stats = Array.from(results.entries())
        .sort(([a], [b]) => a - b)
        .map(([_, s]) => s);
    if (header) {
        console.log(`\n── ${header} ──`);
    }
    report(stats);
}

export function compare(
    labelA: string,
    fnA: () => void,
    labelB: string,
    fnB: () => void,
    config?: Partial<BenchConfig>
): { a: BenchStats; b: BenchStats; ratio: number } {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const oh = calibrate(10000);

    const a = bench(labelA, fnA, cfg);
    const b = bench(labelB, fnB, cfg);

    const ratio = a.medianNs > 0 ? b.medianNs / a.medianNs : b.opsPerSec / a.opsPerSec;

    console.log(`\n── COMPARE: ${labelA} vs ${labelB} ──`);
    console.log(`  ${labelA}:`.padEnd(50) + ` ${toMs(a.medianNs)} median, ${formatOps(a.opsPerSec)} ops/sec`);
    console.log(`  ${labelB}:`.padEnd(50) + ` ${toMs(b.medianNs)} median, ${formatOps(b.opsPerSec)} ops/sec`);
    console.log(`  Ratio: ${isFinite(ratio) ? ratio.toFixed(3) : '?'}x ${ratio > 1 ? '(slower)' : '(faster)'}`);
    console.log(`  Overhead: ${oh.toFixed(0)} ns/sample`);

    return { a, b, ratio };
}
