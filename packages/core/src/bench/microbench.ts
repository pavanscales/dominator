export interface BenchResult {
    label: string;
    medianNs: number;
    meanNs: number;
    p95Ns: number;
    p99Ns: number;
    opsPerSec: number;
    cv: number;
    gcCount: number;
    samples: number;
}

export interface BenchOptions {
    warmupMs?: number;
    measureMs?: number;
    minSamples?: number;
    maxSamples?: number;
}

export interface CompareResult {
    labelA: string;
    labelB: string;
    medianA: number;
    medianB: number;
    ratio: number;
    faster: 'A' | 'B';
    overheadNs: number;
}

const CALIBRATION_OVERHEAD_NS = 100;

let _calibrationDone = false;
let _calibratedOverhead = CALIBRATION_OVERHEAD_NS;

function calibrate(): number {
    if (_calibrationDone) return _calibratedOverhead;
    
    const ITER = 1_000_000;
    const start = performance.now();
    let x = 0;
    for (let i = 0; i < ITER; i++) x++;
    const elapsed = performance.now() - start;
    const perIter = (elapsed * 1_000_000) / ITER;
    _calibratedOverhead = Math.max(0, perIter - 2);
    _calibrationDone = true;
    return _calibratedOverhead;
}

function getOverhead(): number {
    return _calibratedOverhead;
}

function hrtimeNow(): bigint {
    return process.hrtime.bigint();
}

function hrtimeDiffNs(start: bigint, end: bigint): number {
    return Number(end - start) / 1_000_000;
}

function gc(): void {
    if (global.gc) global.gc();
}

export function bench(label: string, fn: () => void, opts: BenchOptions = {}): BenchResult {
    const {
        warmupMs = 100,
        measureMs = 500,
        minSamples = 1000,
        maxSamples = 100_000,
    } = opts;

    calibrate();
    const overhead = getOverhead();

    gc();

    const warmupStart = hrtimeNow();
    let warmupCount = 0;
    while (hrtimeDiffNs(warmupStart, hrtimeNow()) < warmupMs) {
        fn();
        warmupCount++;
    }

    const samples: number[] = [];
    let gcBefore = 0;
    let gcAfter = 0;
    
    if (global.gc) {
        const before = (global as any)._gcCount || 0;
        gcBefore = before;
    }

    const measureStart = hrtimeNow();
    let iterations = 0;
    
    while (samples.length < minSamples && hrtimeDiffNs(measureStart, hrtimeNow()) < measureMs && samples.length < maxSamples) {
        const s = hrtimeNow();
        fn();
        const e = hrtimeNow();
        const ns = hrtimeDiffNs(s, e) - overhead;
        if (ns > 0) samples.push(ns);
        iterations++;
    }

    if (global.gc) {
        const after = (global as any)._gcCount || 0;
        gcAfter = after;
    }

    if (samples.length === 0) {
        return {
            label,
            medianNs: 0,
            meanNs: 0,
            p95Ns: 0,
            p99Ns: 0,
            opsPerSec: 0,
            cv: 0,
            gcCount: gcAfter - gcBefore,
            samples: 0,
        };
    }

    samples.sort((a, b) => a - b);
    
    const medianNs = samples[Math.floor(samples.length * 0.5)];
    const p95Ns = samples[Math.floor(samples.length * 0.95)];
    const p99Ns = samples[Math.floor(samples.length * 0.99)];
    const sum = samples.reduce((a, b) => a + b, 0);
    const meanNs = sum / samples.length;
    const variance = samples.reduce((a, b) => a + (b - meanNs) ** 2, 0) / samples.length;
    const stdDev = Math.sqrt(variance);
    const cv = meanNs > 0 ? (stdDev / meanNs) * 100 : 0;
    const totalMs = hrtimeDiffNs(measureStart, hrtimeNow());
    const opsPerSec = (samples.length / totalMs) * 1000;

    return {
        label,
        medianNs,
        meanNs,
        p95Ns,
        p99Ns,
        opsPerSec,
        cv,
        gcCount: gcAfter - gcBefore,
        samples: samples.length,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// SCALE SWEEP — benchmark a workload at multiple problem sizes
// ═══════════════════════════════════════════════════════════════════════════

export type BenchConfig = BenchOptions;

export interface BenchStats {
    medianNs: number;
    meanNs: number;
    p95Ns: number;
    p99Ns: number;
    opsPerSec: number;
    samples: number;
}

export interface ScaleResult {
    scale: number;
    medianNs: number;
    p95Ns: number;
    opsPerSec: number;
    samples: number;
}

export function benchScale(
    label: string,
    fn: (n: number) => void,
    scales: number[],
    opts: BenchOptions = {},
): ScaleResult[] {
    const out: ScaleResult[] = [];
    for (const n of scales) {
        const r = bench(`${label} n=${n.toLocaleString()}`, () => fn(n), opts);
        out.push({ scale: n, medianNs: r.medianNs, p95Ns: r.p95Ns, opsPerSec: r.opsPerSec, samples: r.samples });
    }
    return out;
}

export function reportScale(results: ScaleResult[]): void {
    console.log('\n── SCALE SWEEP ──');
    for (const r of results) {
        console.log(`  n=${r.scale.toLocaleString().padEnd(12)} ${formatNs(r.medianNs).padStart(12)} median  ${r.opsPerSec.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)} ops/s`);
    }
}

export function compare(
    labelA: string,
    fnA: () => void,
    labelB: string,
    fnB: () => void,
    opts: BenchOptions = {}
): CompareResult {
    const rA = bench(labelA, fnA, opts);
    const rB = bench(labelB, fnB, opts);
    
    const ratio = rA.medianNs > 0 ? rB.medianNs / rA.medianNs : 0;
    const faster = rA.medianNs < rB.medianNs ? 'A' : 'B';
    const overheadNs = getOverhead();

    return {
        labelA,
        labelB,
        medianA: rA.medianNs,
        medianB: rB.medianNs,
        ratio,
        faster,
        overheadNs,
    };
}

export function report(results: BenchResult[]): void {
    console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
    console.log(' MICROBENCH RESULTS');
    console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
    console.log('│ Benchmark                                             │ Median      │ Mean       │ P95       │ P99       │ Ops/s       │ σ/μ   │ GC │');
    console.log('├────────────────────────────────────────────────────┼──────────────┼──────────────┼──────────────┼──────────────┼────────────────┼──────────┼────────┤');
    
    for (const r of results) {
        const label = r.label.padEnd(52);
        const median = formatNs(r.medianNs).padStart(12);
        const mean = formatNs(r.meanNs).padStart(12);
        const p95 = formatNs(r.p95Ns).padStart(12);
        const p99 = formatNs(r.p99Ns).padStart(12);
        const ops = r.opsPerSec.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(14);
        const cv = r.cv.toFixed(1).padStart(8);
        const gc = String(r.gcCount).padStart(4);
        console.log(`│ ${label} │ ${median} │ ${mean} │ ${p95} │ ${p99} │ ${ops} │ ${cv} │ ${gc} │`);
    }
    
    console.log('└────────────────────────────────────────────────────┴──────────────┴──────────────┴──────────────┴──────────────┴────────────────┴──────────┴────────┘');
    console.log(`  Clock: hrtime.bigint  Overhead: ${getOverhead()} ns  Batch: ${results.length}`);
}

function formatNs(ns: number): string {
    if (ns < 1000) return `${ns.toFixed(1)} ns`;
    if (ns < 1_000_000) return `${(ns / 1000).toFixed(2)} μs`;
    if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
    return `${(ns / 1_000_000_000).toFixed(2)} s`;
}

export function printCompare(c: CompareResult): void {
    console.log('\n── COMPARE: ' + c.labelA + ' vs ' + c.labelB + ' ──');
    console.log(`  ${c.labelA}:`.padEnd(40) + ` ${formatNs(c.medianA).padStart(12)} median, ${(1e9 / c.medianA).toLocaleString()} ops/sec`);
    console.log(`  ${c.labelB}:`.padEnd(40) + ` ${formatNs(c.medianB).padStart(12)} median, ${(1e9 / c.medianB).toLocaleString()} ops/sec`);
    console.log(`  Ratio: ${c.ratio.toFixed(3)}x (${c.faster === 'A' ? 'A faster' : 'B faster'})`);
    console.log(`  Overhead: ${c.overheadNs} ns/sample`);
}

export const TARGETS: Record<string, number> = {
    'signal:read': 50,
    'signal:set_1_effect': 200,
    'signal:set_10_effects': 500,
    'signal:set_100_effects': 10_000,
    'signal:set_1000_effects': 100_000,
    'batch:10_sets_1_effect': 5_000,
    'batch:100_sets_1_effect': 10_000,
    'batch:1k_dirty': 1_000_000,
    'fan_out_100': 50_000,
    'fan_out_1000': 500_000,
    'computed:1_level': 200,
    'computed:3_level': 500,
    'computed:5_level': 1_000,
    'compute:markSignalDirty': 50,
    'compute:propagateDirty_chain': 500,
    'compute:propagateDirty_fanout': 500,
    'compute:executeDirtyEffects': 1_000_000,
    'compute:full_frame_fanout': 2_000_000,
    'layout:runLayout': 1_000_000,
    'render:buildGraph': 500_000,
    'render:gpu_submit': 200_000,
    'scheduler:frame': 4_167_000,
};

export function checkTargets(results: BenchResult[]): { passed: string[]; failed: string[] } {
    const passed: string[] = [];
    const failed: string[] = [];
    
    for (const r of results) {
        const target = TARGETS[r.label];
        if (target && r.medianNs <= target) {
            passed.push(`${r.label}: ${formatNs(r.medianNs)} ≤ ${formatNs(target)}`);
        } else if (target) {
            failed.push(`${r.label}: ${formatNs(r.medianNs)} > ${formatNs(target)} (${((r.medianNs / target - 1) * 100).toFixed(0)}% over)`);
        }
    }
    
    return { passed, failed };
}

export function assertTargets(results: BenchResult[], tolerance = 1.1): void {
    const { passed, failed } = checkTargets(results);
    
    if (passed.length) {
        console.log('\n✅ TARGETS MET:');
        for (const p of passed) console.log('  ' + p);
    }
    
    if (failed.length) {
        console.log('\n❌ TARGETS MISSED:');
        for (const f of failed) console.log('  ' + f);
        throw new Error(`Performance regression: ${failed.length} targets missed`);
    }
}

export interface ProfileSuite {
    name: string;
    setup?: () => void;
    teardown?: () => void;
    benches: Array<{
        label: string;
        fn: () => void;
        opts?: BenchOptions;
    }>;
    compares?: Array<{
        labelA: string;
        fnA: () => void;
        labelB: string;
        fnB: () => void;
        opts?: BenchOptions;
    }>;
}

const _suites: ProfileSuite[] = [];

export function defineSuite(suite: ProfileSuite): void {
    _suites.push(suite);
}

export function getSuites(): ProfileSuite[] {
    return _suites;
}

export async function runAllSuites(opts: { 
    filter?: string; 
    checkTargets?: boolean;
    tolerance?: number;
} = {}): Promise<BenchResult[]> {
    const allResults: BenchResult[] = [];
    
    for (const suite of _suites) {
        if (opts.filter && !suite.name.includes(opts.filter)) continue;
        
        console.log(`\n=== ${suite.name} ===`);
        
        if (suite.setup) suite.setup();
        
        const suiteResults: BenchResult[] = [];
        
        for (const b of suite.benches) {
            const r = bench(b.label, b.fn, b.opts);
            suiteResults.push(r);
            allResults.push(r);
        }
        
        if (suite.compares) {
            for (const c of suite.compares) {
                const cr = compare(c.labelA, c.fnA, c.labelB, c.fnB, c.opts);
                printCompare(cr);
            }
        }
        
        if (suite.teardown) suite.teardown();
        
        if (opts.checkTargets !== false) {
            const { passed, failed } = checkTargets(suiteResults);
            if (passed.length) console.log('\n✅ ' + passed.length + ' targets met');
            if (failed.length) console.log('\n❌ ' + failed.length + ' targets missed');
        }
    }
    
    return allResults;
}

export function createV8TraceCommand(): string {
    return 'NODE_OPTIONS="--trace-deopt --trace-opt --trace-ic --trace-gc" npx vitest run';
}

export function getV8TraceFilters(): string[] {
    return [
        'grep "deopt" v8-trace.log | grep -i dominator',
        'grep "megamorphic" v8-trace.log',
        'grep "polymorphic" v8-trace.log',
        'grep "monomorphic" v8-trace.log',
        'grep "runtime call stats" v8-trace.log',
        'grep "GC" v8-trace.log | head -20',
    ];
}

export function printV8TraceGuide(): void {
    console.log('\n=== V8 DEOPT ANALYSIS ===');
    console.log('Run:');
    console.log('  ' + createV8TraceCommand());
    console.log('\nThen check v8-trace.log for:');
    getV8TraceFilters().forEach(f => console.log('  ' + f));
}

export function createRegressionGate(baseline: Record<string, number>, tolerance = 1.1): (results: BenchResult[]) => void {
    return (results: BenchResult[]) => {
        const failures: string[] = [];
        
        for (const r of results) {
            const base = baseline[r.label];
            if (base && r.medianNs > base * tolerance) {
                failures.push(`${r.label}: ${formatNs(r.medianNs)} > ${formatNs(base * tolerance)} (baseline: ${formatNs(base)})`);
            }
        }
        
        if (failures.length) {
            console.log('\n🚨 REGRESSION DETECTED:');
            failures.forEach(f => console.log('  ' + f));
            throw new Error('Performance regression detected');
        }
    };
}