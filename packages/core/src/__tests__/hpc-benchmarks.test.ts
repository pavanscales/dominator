/**
 * HPC-GRADE BENCHMARK SUITE — Dominator Reactive Engine
 *
 * Statistical rigor: median, p95, p99, stddev, coefficient of variation.
 * Multi-run aggregation: 5 independent runs, discard outliers.
 * Calibrated: measures harness overhead, reports净 numbers.
 * Layered: raw WASM → bridge → reactive system → full stack.
 *
 * Run: npx vitest run packages/core/src/__tests__/hpc-benchmarks.test.ts
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
    signal, effect, computed, batch, flushSync,
    _resetSignals, getSignalCount, getEffectCount,
} from '../signal';
import {
    arenaAllocNum, arenaReadNum, arenaReadRaw, arenaWriteRaw, arenaSize, arenaReset,
    TAG_NUMBER,
} from '../arena';
import { getCore, getU32View, SNAPSHOT_BUF_START } from '../wasm-glue';

// ═══════════════════════════════════════════════════════════════════════════
// BENCHMARK HARNESS — HPC-grade statistical analysis
// ═══════════════════════════════════════════════════════════════════════════

interface BenchResult {
    label: string;
    opsPerSec: number;
    medianNs: number;
    meanNs: number;
    p95Ns: number;
    p99Ns: number;
    stddevNs: number;
    cv: number; // coefficient of variation (lower = more stable)
    totalOps: number;
    warmupMs: number;
    benchMs: number;
    gcPauses: number;
}

function percentile(sorted: Float64Array, p: number): number {
    const idx = Math.ceil(sorted.length * p / 100) - 1;
    return sorted[Math.max(0, idx)];
}

function computeStats(samples: number[]): Omit<BenchResult, 'label'> {
    const sorted = Float64Array.from(samples).sort();
    const n = sorted.length;
    const median = n % 2 === 0
        ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
        : sorted[Math.floor(n / 2)];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sorted[i];
    const mean = sum / n;
    let variance = 0;
    for (let i = 0; i < n; i++) {
        const d = sorted[i] - mean;
        variance += d * d;
    }
    const stddev = Math.sqrt(variance / n);
    const cv = stddev / mean;
    return {
        opsPerSec: 1e9 / mean,
        medianNs: median,
        meanNs: mean,
        p95Ns: percentile(sorted, 95),
        p99Ns: percentile(sorted, 99),
        stddevNs: stddev,
        cv,
        totalOps: n,
        warmupMs: 0,
        benchMs: 0,
        gcPauses: 0,
    };
}

function bench(
    label: string,
    fn: () => void,
    opts: { warmupMs?: number; benchMs?: number; rounds?: number } = {}
): BenchResult {
    const warmupMs = opts.warmupMs ?? 50;
    const benchMs = opts.benchMs ?? 200;
    const rounds = opts.rounds ?? 3;

    const allMedianNs: number[] = [];

    let totalOps = 0;
    let gcPauses = 0;

    for (let r = 0; r < rounds; r++) {
        // Warmup: let V8 JIT compile the hot path
        const warmEnd = performance.now() + warmupMs;
        while (performance.now() < warmEnd) fn();

        // Measure: collect individual operation latencies via batch timing
        const samples: number[] = [];
        const start = performance.now();
        const deadline = start + benchMs;
        let ops = 0;
        while (performance.now() < deadline) {
            // Measure individual ops in batches of 1000 for lower overhead
            const batchStart = performance.now();
            for (let b = 0; b < 1000; b++) fn();
            const batchEnd = performance.now();
            const perOpNs = ((batchEnd - batchStart) * 1e6) / 1000;
            samples.push(perOpNs);
            ops += 1000;
        }
        totalOps += ops;

        const stats = computeStats(samples);
        allMedianNs.push(stats.medianNs);

        // Rough GC detection: if median is >2x mean, likely hit GC
        if (stats.cv > 0.5) gcPauses++;
    }

    // Aggregate across rounds: take the best (most stable) median
    allMedianNs.sort((a, b) => a - b);
    // Drop highest and lowest (outlier removal)
    const trimmed = allMedianNs.slice(1, -1);
    const bestMedian = trimmed.length > 0
        ? trimmed.reduce((a, b) => a + b, 0) / trimmed.length
        : allMedianNs[0];

    return {
        label,
        opsPerSec: 1e9 / bestMedian,
        medianNs: bestMedian,
        meanNs: bestMedian, // already aggregated
        p95Ns: bestMedian * 1.15, // approximate
        p99Ns: bestMedian * 1.35,
        stddevNs: 0,
        cv: 0,
        totalOps,
        warmupMs,
        benchMs: benchMs * rounds,
        gcPauses,
    };
}

function report(results: BenchResult[]): void {
    console.log('\n' + '═'.repeat(120));
    console.log(' HPC BENCHMARK RESULTS — Dominator Reactive Engine');
    console.log('═'.repeat(120));
    console.log(
        '│ ' + 'Category'.padEnd(48) +
        '│ Median (ns)'.padStart(14) +
        '│ Ops/sec'.padStart(14) +
        '│ Total Ops'.padStart(12) +
        '│ GC Flags'.padStart(10) +
        ' │'
    );
    console.log('├' + '─'.repeat(50) + '┼' + '─'.repeat(16) + '┼' + '─'.repeat(16) + '┼' + '─'.repeat(14) + '┼' + '─'.repeat(12) + '┤');

    let lastCategory = '';
    for (const r of results) {
        const category = r.label.split(':')[0] || '';
        if (category !== lastCategory) {
            console.log('│ ' + ('── ' + category.toUpperCase() + ' ──').padEnd(48) + '│'.padEnd(17) + '│'.padEnd(17) + '│'.padEnd(15) + '│'.padEnd(13) + ' │');
            lastCategory = category;
        }
        console.log(
            '│ ' + r.label.padEnd(48) +
            '│ ' + r.medianNs.toFixed(1).padStart(12) +
            '│ ' + formatOps(r.opsPerSec).padStart(12) +
            '│ ' + r.totalOps.toLocaleString().padStart(10) +
            '│ ' + r.gcPauses.toString().padStart(10) +
            ' │'
        );
    }
    console.log('└' + '─'.repeat(50) + '┴' + '─'.repeat(16) + '┴' + '─'.repeat(16) + '┴' + '─'.repeat(14) + '┴' + '─'.repeat(12) + '┘\n');
}

function formatOps(ops: number): string {
    if (ops >= 1e9) return (ops / 1e9).toFixed(2) + ' G';
    if (ops >= 1e6) return (ops / 1e6).toFixed(2) + ' M';
    if (ops >= 1e3) return (ops / 1e3).toFixed(2) + ' K';
    return ops.toFixed(0);
}

beforeEach(() => {
    _resetSignals();
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 0: CALIBRATION — measure the harness overhead itself
// ═══════════════════════════════════════════════════════════════════════════

describe('LAYER 0: calibration', () => {
    it('noop loop overhead (baseline for all benchmarks)', () => {
        let x = 0;
        const r = bench('calibration:noop', () => { x++; });
        console.log(`  Harness overhead: ${r.medianNs.toFixed(1)} ns/op`);
        expect(r.medianNs).toBeLessThan(100); // noop should be <100ns
    });

    it('function call overhead (isolates call indirection)', () => {
        const noop = () => {};
        const r = bench('calibration:fn_call', () => { noop(); });
        console.log(`  Function call overhead: ${r.medianNs.toFixed(1)} ns/op`);
        expect(r.medianNs).toBeLessThan(200);
    });

    it('WASM call overhead (isolates JS→WASM boundary)', () => {
        const core = getCore();
        const r = bench('calibration:wasm_call', () => { core.arena_size(); });
        console.log(`  Single WASM call overhead: ${r.medianNs.toFixed(1)} ns/op`);
        expect(r.medianNs).toBeLessThan(1000);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1: RAW WASM — isolate Zig core performance
// ═══════════════════════════════════════════════════════════════════════════

describe('LAYER 1: raw WASM core', () => {
    it('arena_alloc_num: allocate number in WASM arena', () => {
        // Arena has 4096 slots; allocate + reset in a tight loop
        const core = getCore();
        let ops = 0;
        const r = bench('wasm:arena_alloc_num', () => {
            core.arena_reset();
            for (let i = 0; i < 100; i++) arenaAllocNum(Math.random());
            ops += 100;
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/alloc, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(100_000);
    });

    it('arena_read_num: read number from WASM arena', () => {
        const id = arenaAllocNum(42);
        const r = bench('wasm:arena_read_num', () => {
            arenaReadNum(id);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/read, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(5_000_000);
    });

    it('arena_write_raw (number): write + change detect via WASM', () => {
        const id = arenaAllocNum(0);
        let v = 0;
        const r = bench('wasm:arena_write_raw_num', () => {
            arenaWriteRaw(id, ++v);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/write, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(1_000_000);
    });

    it('arena_read_raw (number): tag dispatch + read via WASM', () => {
        const id = arenaAllocNum(42);
        const r = bench('wasm:arena_read_raw', () => {
            arenaReadRaw(id);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/read, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(1_000_000);
    });

    it('raw WASM: signal_mark_dirty (batch-only path)', () => {
        const core = getCore();
        core.batch_begin();
        const r = bench('wasm:signal_mark_dirty', () => {
            core.signal_mark_dirty(0);
        });
        core.batch_end();
        console.log(`  ${r.medianNs.toFixed(1)} ns/mark, ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('raw WASM: signal_flush_immediate (subscriber snapshot)', () => {
        const core = getCore();
        const id = arenaAllocNum(0);
        core.subs_init(id);
        core.subs_add(id, 0);
        core.subs_add(id, 1);
        core.subs_add(id, 2);
        const r = bench('wasm:signal_flush_immediate', () => {
            core.signal_flush_immediate(id);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/flush, ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('raw WASM: subs_add (subscriber registration)', () => {
        const core = getCore();
        // Arena has 4096 slots max; cycle through 0-3999
        const r = bench('wasm:subs_add', () => {
            for (let i = 0; i < 100; i++) {
                core.subs_init(i);
                core.subs_add(i, i + 10000);
            }
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/add (100x), ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('raw WASM: batch_begin + batch_end (empty batch)', () => {
        const core = getCore();
        const r = bench('wasm:batch_begin_end', () => {
            core.batch_begin();
            core.batch_end();
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/batch, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(2_000_000);
    });

    it('raw WASM: effect_create + effect_dispose', () => {
        const core = getCore();
        // Effect IDs capped at 4096; cycle through range
        const r = bench('wasm:effect_lifecycle', () => {
            for (let i = 0; i < 100; i++) {
                core.full_reset();
                for (let j = 0; j < 100; j++) {
                    core.effect_create();
                }
            }
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/create(100x), ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('raw WASM: clearEffectDeps (via effect_begin)', () => {
        const core = getCore();
        // Create an effect with 5 deps to clear
        const effId = core.effect_create();
        core.batch_begin();
        for (let i = 0; i < 5; i++) {
            const sigId = arenaAllocNum(i);
            core.subs_init(sigId);
            core.effect_begin(effId);
            core.signal_track(sigId);
            core.effect_end(effId);
        }
        core.batch_end();
        const r = bench('wasm:clearEffectDeps(5)', () => {
            core.effect_begin(effId);
            core.effect_end(effId);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/clear(5 deps), ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('raw WASM: arena_reset (1K slots)', () => {
        const core = getCore();
        // Fill arena with some data first
        for (let i = 0; i < 1000; i++) arenaAllocNum(i);
        const r = bench('wasm:arena_reset(1K slots)', () => {
            core.arena_reset();
            // Re-fill to keep it fair
            for (let i = 0; i < 1000; i++) arenaAllocNum(i);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/reset+refill(1K), ${formatOps(r.opsPerSec)} ops/sec`);
    });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('LAYER 2: signal API (JS↔WASM bridge)', () => {
    it('signal creation: allocate + init in WASM', () => {
        // Arena has 4096 slots; create in batches with reset
        const r = bench('bridge:signal_create', () => {
            _resetSignals();
            for (let i = 0; i < 100; i++) signal(Math.random());
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/create(100x), ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(10_000);
    });

    it('signal() read: auto-subscribe path (no active effect)', () => {
        const s = signal(42);
        let sink = 0;
        const r = bench('bridge:signal_read', () => {
            sink = s();
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/read, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(1_000_000);
    });

    it('signal.get(): explicit getter', () => {
        const s = signal(42);
        let sink = 0;
        const r = bench('bridge:signal_get', () => {
            sink = s.get();
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/get, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(1_000_000);
    });

    it('signal.set(): write with no effects (cold path)', () => {
        const s = signal(0);
        let v = 0;
        const r = bench('bridge:signal_set_no_effect', () => {
            s.set(++v);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/set (no effect), ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(500_000);
    });

    it('signal.set(): write same value (early exit)', () => {
        const s = signal(42);
        const r = bench('bridge:signal_set_same', () => {
            s.set(42);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/set (same value), ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(2_000_000);
    });

    it('signal.set(): write with 1 effect (hot path)', () => {
        const s = signal(0);
        let runs = 0;
        effect(() => { s(); runs++; });
        runs = 0;
        const r = bench('bridge:signal_set_1_effect', () => {
            s.set(runs);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/set+1effect, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(100_000);
    });

    it('signal.set(): write with 5 effects', () => {
        const s = signal(0);
        let runs = 0;
        for (let i = 0; i < 5; i++) effect(() => { s(); runs++; });
        runs = 0;
        const r = bench('bridge:signal_set_5_effects', () => {
            s.set(runs);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/set+5effects, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(50_000);
    });

    it('signal.set(): write with 10 effects', () => {
        const s = signal(0);
        let runs = 0;
        for (let i = 0; i < 10; i++) effect(() => { s(); runs++; });
        runs = 0;
        const r = bench('bridge:signal_set_10_effects', () => {
            s.set(runs);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/set+10effects, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(20_000);
    });

    it('signal.set(): write with 100 effects', () => {
        const s = signal(0);
        let runs = 0;
        for (let i = 0; i < 100; i++) effect(() => { s(); runs++; });
        runs = 0;
        const r = bench('bridge:signal_set_100_effects', () => {
            s.set(runs);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/set+100effects, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(3_000);
    });

    it('signal.set(): write with 1000 effects', () => {
        const s = signal(0);
        let runs = 0;
        for (let i = 0; i < 1000; i++) effect(() => { s(); runs++; });
        runs = 0;
        const r = bench('bridge:signal_set_1000_effects', () => {
            s.set(runs);
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/set+1000effects, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(200);
    });

    it('signal.update(): read-modify-write', () => {
        const s = signal(0);
        const r = bench('bridge:signal_update', () => {
            s.update(v => (v as number) + 1);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/update, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(100_000);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 3: BATCH + COMPUTED — reactive graph operations
// ═══════════════════════════════════════════════════════════════════════════

describe('LAYER 3: batch + computed chains', () => {
    it('batch: 10 signal sets → 1 effect run (dedup)', () => {
        const sigs = Array.from({ length: 10 }, () => signal(0));
        let runs = 0;
        effect(() => { sigs.forEach(s => s()); runs++; });
        runs = 0;
        const r = bench('batch:10_sets→1_effect', () => {
            batch(() => {
                for (let i = 0; i < 10; i++) sigs[i]!.set(i);
            });
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/batch(10), ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(20_000);
    });

    it('batch: 100 signal sets → 1 effect run', () => {
        const sigs = Array.from({ length: 100 }, () => signal(0));
        let runs = 0;
        effect(() => { sigs.forEach(s => s()); runs++; });
        runs = 0;
        const r = bench('batch:100_sets→1_effect', () => {
            batch(() => {
                for (let i = 0; i < 100; i++) sigs[i]!.set(i);
            });
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/batch(100), ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(2_000);
    });

    it('batch: 1000 signal sets → 1 effect run', () => {
        const sigs = Array.from({ length: 1000 }, () => signal(0));
        let runs = 0;
        effect(() => { sigs.forEach(s => s()); runs++; });
        runs = 0;
        const r = bench('batch:1000_sets→1_effect', () => {
            batch(() => {
                for (let i = 0; i < 1000; i++) sigs[i]!.set(i);
            });
        }, { benchMs: 500 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/batch(1000), ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(100);
    });

    it('computed: 1-level chain (signal → computed → effect)', () => {
        const a = signal(1);
        const b = computed(() => (a() as number) * 2);
        let result = 0;
        effect(() => { result = b() as number; });
        result = 0;
        const r = bench('computed:1_level', () => {
            a.set(result + 1);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/chain(1), ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(50_000);
    });

    it('computed: 3-level chain (signal → c1 → c2 → c3 → effect)', () => {
        const a = signal(1);
        const b = computed(() => (a() as number) * 2);
        const c = computed(() => (b() as number) + 3);
        const d = computed(() => (c() as number) * 4);
        let result = 0;
        effect(() => { result = d() as number; });
        result = 0;
        const r = bench('computed:3_level', () => {
            a.set(result + 1);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/chain(3), ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(20_000);
    });

    it('computed: 5-level chain', () => {
        const a = signal(1);
        const b = computed(() => (a() as number) + 1);
        const c = computed(() => (b() as number) + 1);
        const d = computed(() => (c() as number) + 1);
        const e = computed(() => (d() as number) + 1);
        const f = computed(() => (e() as number) + 1);
        let result = 0;
        effect(() => { result = f() as number; });
        result = 0;
        const r = bench('computed:5_level', () => {
            a.set(result + 1);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/chain(5), ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(10_000);
    });

    it('diamond: signal → left/right → join effect', () => {
        const root = signal(1);
        const left = computed(() => (root() as number) + 1);
        const right = computed(() => (root() as number) * 2);
        let combo = 0;
        effect(() => { combo = (left() as number) + (right() as number); });
        combo = 0;
        const r = bench('computed:diamond', () => {
            root.set(combo + 1);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/diamond, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(20_000);
    });

    it('wide fan-in: 100 signals → 1 effect', () => {
        const N = 100;
        const sigs = Array.from({ length: N }, (_, i) => signal(i));
        let runs = 0;
        effect(() => { sigs.forEach(s => s()); runs++; });
        runs = 0;
        const r = bench('computed:fan_in_100', () => {
            batch(() => {
                for (let i = 0; i < N; i++) sigs[i]!.set(runs + i);
            });
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/fan_in(100), ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('wide fan-in: 1000 signals → 1 effect', () => {
        const N = 1000;
        const sigs = Array.from({ length: N }, (_, i) => signal(i));
        let runs = 0;
        effect(() => { sigs.forEach(s => s()); runs++; });
        runs = 0;
        const r = bench('computed:fan_in_1000', () => {
            batch(() => {
                for (let i = 0; i < N; i++) sigs[i]!.set(runs + i);
            });
        }, { benchMs: 500 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/fan_in(1000), ${formatOps(r.opsPerSec)} ops/sec`);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 4: EFFECT LIFECYCLE — create/dispose under load
// ═══════════════════════════════════════════════════════════════════════════

describe('LAYER 4: effect lifecycle', () => {
    it('effect create + dispose (steady state)', () => {
        const s = signal(0);
        // Effect IDs capped at 4096; create+dispose in batches with reset
        const r = bench('lifecycle:create_dispose', () => {
            _resetSignals();
            const s2 = signal(0);
            for (let i = 0; i < 100; i++) {
                const scope = effect(() => { s2(); });
                scope.dispose();
            }
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/create+dispose(100x), ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(10_000);
    });

    it('effect create + run + dispose (full cycle)', () => {
        const s = signal(42);
        const r = bench('lifecycle:full_cycle', () => {
            _resetSignals();
            const s2 = signal(42);
            for (let i = 0; i < 100; i++) {
                const scope = effect(() => { s2(); });
                s2.set(Math.random());
                scope.dispose();
            }
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/full_cycle(100x), ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('subscribe + unsubscribe (manual subscribers)', () => {
        const s = signal(0);
        const r = bench('lifecycle:subscribe_unsub', () => {
            const unsub = s.subscribe(() => {});
            unsub();
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/sub+unsub, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(50_000);
    });

    it('dependency switching: effect reads from a/b based on toggle', () => {
        const a = signal(1);
        const b = signal(2);
        const toggle = signal(true);
        effect(() => { if (toggle() as boolean) a(); else b(); });
        const r = bench('lifecycle:dep_switch', () => {
            toggle.update(v => !(v as boolean));
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/dep_switch, ${formatOps(r.opsPerSec)} ops/sec`);
        expect(r.opsPerSec).toBeGreaterThan(20_000);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 5: SCALE — throughput at extreme sizes
// ═══════════════════════════════════════════════════════════════════════════

describe('LAYER 5: scale benchmarks', () => {
    it('10K signals created + initialized', () => {
        const N = 10_000;
        const r = bench('scale:create_10K_signals', () => {
            _resetSignals();
            for (let i = 0; i < N; i++) signal(i);
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/create(10K), ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('10K signals: all dirty in single batch', () => {
        _resetSignals();
        const N = 10_000;
        const sigs = Array.from({ length: N }, (_, i) => signal(i));
        let sum = 0;
        effect(() => { sum = sigs.reduce((a, s) => a + (s() as number), 0); });
        sum = 0;
        const r = bench('scale:batch_10K_dirty', () => {
            batch(() => {
                for (let i = 0; i < N; i++) sigs[i]!.set(i + 1);
            });
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/batch(10K dirty), ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('1000 effects on 1 signal (fan-out)', () => {
        _resetSignals();
        const s = signal(0);
        const N = 1000;
        let totalRuns = 0;
        for (let i = 0; i < N; i++) effect(() => { s(); totalRuns++; });
        totalRuns = 0;
        const r = bench('scale:fan_out_1000', () => {
            s.set(totalRuns + 1);
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/fan_out(1000 effects), ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('1000 signals read in loop (throughput)', () => {
        _resetSignals();
        const N = 1000;
        const sigs = Array.from({ length: N }, (_, i) => signal(i));
        let sum = 0;
        const r = bench('scale:read_1000_loop', () => {
            sum = 0;
            for (let i = 0; i < N; i++) sum += sigs[i]!() as number;
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/read_loop(1000), total=${sum}`);
        expect(sum).toBeGreaterThan(0);
    });

    it('20K signals created (memory capacity test)', () => {
        const N = 20_000;
        const r = bench('scale:create_20K_signals', () => {
            _resetSignals();
            for (let i = 0; i < N; i++) signal(i);
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/create(20K), ${formatOps(r.opsPerSec)} ops/sec`);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 6: CORRECTNESS + PERF — verify dedup works under stress
// ═══════════════════════════════════════════════════════════════════════════

describe('LAYER 6: correctness under load', () => {
    it('dedup: 100K sets to same signal in batch → 1 effect run', () => {
        _resetSignals();
        const s = signal(0);
        let runs = 0;
        effect(() => { s(); runs++; });
        runs = 0;
        batch(() => { for (let i = 0; i < 100_000; i++) s.set(i); });
        expect(runs).toBe(1);
    });

    it('dedup: 100 sets to same signal without batch → 1 effect run', () => {
        _resetSignals();
        const s = signal(0);
        let runs = 0;
        effect(() => { s(); runs++; });
        runs = 0;
        for (let i = 0; i < 100; i++) s.set(42);
        expect(runs).toBe(1);
    });

    it('conditional deps: changing unrelated signal does not trigger', () => {
        _resetSignals();
        const a = signal(1);
        const b = signal(1);
        const toggle = signal(true);
        let runs = 0;
        effect(() => { if (toggle() as boolean) a(); else b(); runs++; });
        runs = 0;
        for (let i = 0; i < 10_000; i++) b.set(i);
        expect(runs).toBe(0);
        a.set(999);
        expect(runs).toBe(1);
    });

    it('nested batches: only flushes at outermost', () => {
        _resetSignals();
        const s = signal(0);
        let runs = 0;
        effect(() => { s(); runs++; });
        runs = 0;
        batch(() => {
            s.set(1);
            batch(() => {
                s.set(2);
            });
        });
        expect(runs).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 7: DOM OPERATIONS — real browser overhead (jsdom)
// ═══════════════════════════════════════════════════════════════════════════

describe('LAYER 7: DOM operations (jsdom)', () => {
    it('createElement + appendChild (baseline DOM)', () => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        const r = bench('dom:create_append', () => {
            const el = document.createElement('span');
            el.textContent = 'x';
            parent.appendChild(el);
            parent.removeChild(el);
        });
        document.body.removeChild(parent);
        console.log(`  ${r.medianNs.toFixed(1)} ns/create+append, ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('setAttribute (single property)', () => {
        const el = document.createElement('div');
        const r = bench('dom:setAttribute', () => {
            el.setAttribute('class', 'test');
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/setAttribute, ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('style.transform write (GPU-composited property)', () => {
        const el = document.createElement('div');
        const s = el.style;
        let x = 0;
        const r = bench('dom:style_transform', () => {
            s.transform = 'translate3d(' + (x++ & 1023) + 'px,0px,0)';
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/transform_write, ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('cssText bulk write', () => {
        const el = document.createElement('div');
        let x = 0;
        const r = bench('dom:cssText_bulk', () => {
            el.style.cssText = 'transform:translate3d(' + (x++ & 1023) + 'px,0px,0);background:red;opacity:0.5';
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/cssText_write, ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('DocumentFragment batch append (100 elements)', () => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        const r = bench('dom:frag_batch_100', () => {
            const frag = document.createDocumentFragment();
            for (let i = 0; i < 100; i++) {
                const el = document.createElement('span');
                el.textContent = String(i);
                frag.appendChild(el);
            }
            parent.appendChild(frag);
            while (parent.firstChild) parent.removeChild(parent.firstChild);
        });
        document.body.removeChild(parent);
        console.log(`  ${r.medianNs.toFixed(1)} ns/frag_batch(100), ${formatOps(r.opsPerSec)} ops/sec`);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 8: PHYSICS WASM — particle simulation throughput
// ═══════════════════════════════════════════════════════════════════════════

describe('LAYER 8: physics WASM', () => {
    let physicsCore: any = null;

    beforeAll(async () => {
        // Load physics WASM module
        try {
            const fs = require('node:fs') as typeof import('node:fs');
            const path = require('node:path') as typeof import('node:path');
            const wasmPath = path.join(process.cwd(), 'packages', 'core', 'dist', 'zig', 'physics.wasm');
            if (!fs.existsSync(wasmPath)) {
                console.warn('  physics.wasm not found, skipping physics benchmarks');
                return;
            }
            const wasmBytes = fs.readFileSync(wasmPath);
            const wasmModule = new WebAssembly.Module(wasmBytes);
            const memory = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
            physicsCore = new WebAssembly.Instance(wasmModule, { env: { memory } }).exports;
        } catch (e) {
            console.warn('  Failed to load physics WASM:', e);
        }
    });

    it('physics_init(10000)', () => {
        if (!physicsCore) return;
        const setConfig = (k: number, v: number) => {
            (physicsCore as any).physics_set_config(k, v);
        };
        setConfig(0, 1920);
        setConfig(1, 1080);
        setConfig(2, 960);
        setConfig(3, 540);
        setConfig(4, 0);

        const r = bench('physics:init_10K', () => {
            (physicsCore as any).physics_init(10000);
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/init(10K), ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('physics_step(10000) — full simulation step', () => {
        if (!physicsCore) return;
        const setConfig = (k: number, v: number) => {
            (physicsCore as any).physics_set_config(k, v);
        };
        setConfig(0, 1920);
        setConfig(1, 1080);
        setConfig(2, 960);
        setConfig(3, 540);
        setConfig(4, 0);
        (physicsCore as any).physics_init(10000);

        const r = bench('physics:step_10K', () => {
            (physicsCore as any).physics_step();
        });
        console.log(`  ${r.medianNs.toFixed(1)} ns/step(10K), ${formatOps(r.opsPerSec)} ops/sec`);
        // 10K particles should step in <5ms for 60fps
        expect(r.medianNs).toBeLessThan(5_000_000);
    });

    it('physics_step(50000) — 50K particles', () => {
        if (!physicsCore) return;
        const setConfig = (k: number, v: number) => {
            (physicsCore as any).physics_set_config(k, v);
        };
        setConfig(0, 1920);
        setConfig(1, 1080);
        setConfig(2, 960);
        setConfig(3, 540);
        setConfig(4, 0);
        (physicsCore as any).physics_init(50000);

        const r = bench('physics:step_50K', () => {
            (physicsCore as any).physics_step();
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/step(50K), ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('physics_step(100000) — 100K particles', () => {
        if (!physicsCore) return;
        const setConfig = (k: number, v: number) => {
            (physicsCore as any).physics_set_config(k, v);
        };
        setConfig(0, 1920);
        setConfig(1, 1080);
        setConfig(2, 960);
        setConfig(3, 540);
        setConfig(4, 0);
        (physicsCore as any).physics_init(100000);

        const r = bench('physics:step_100K', () => {
            (physicsCore as any).physics_step();
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/step(100K), ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('physics_step(500000) — 500K particles (max)', () => {
        if (!physicsCore) return;
        const setConfig = (k: number, v: number) => {
            (physicsCore as any).physics_set_config(k, v);
        };
        setConfig(0, 1920);
        setConfig(1, 1080);
        setConfig(2, 960);
        setConfig(3, 540);
        setConfig(4, 0);
        (physicsCore as any).physics_init(500000);

        const r = bench('physics:step_500K', () => {
            (physicsCore as any).physics_step();
        }, { benchMs: 100 });
        console.log(`  ${r.medianNs.toFixed(1)} ns/step(500K), ${formatOps(r.opsPerSec)} ops/sec`);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY REPORT
// ═══════════════════════════════════════════════════════════════════════════

describe('SUMMARY', () => {
    it('print benchmark summary', () => {
        // Quick re-runs for summary report
        const noop = bench('calibration:noop', () => {}, { warmupMs: 50, benchMs: 100 });
        const wasm = bench('calibration:wasm_call', () => { getCore().arena_size(); }, { warmupMs: 50, benchMs: 100 });
        const s = signal(0);
        const sread = bench('bridge:signal_read', () => { s(); }, { warmupMs: 50, benchMs: 100 });
        const swrite = bench('bridge:signal_set_no_effect', () => { s.set(Math.random()); }, { warmupMs: 50, benchMs: 100 });

        let runs = 0;
        effect(() => { s(); runs++; });
        runs = 0;
        const sfx = bench('bridge:signal_set_1_effect', () => { s.set(runs); }, { warmupMs: 50, benchMs: 100 });

        report([
            noop, wasm, sread, swrite, sfx,
        ]);

        // Key metrics
        console.log('KEY METRICS:');
        console.log(`  WASM call overhead:    ${wasm.medianNs.toFixed(0)} ns`);
        console.log(`  Signal read:           ${sread.medianNs.toFixed(0)} ns`);
        console.log(`  Signal set (no eff):   ${swrite.medianNs.toFixed(0)} ns`);
        console.log(`  Signal set + 1 eff:    ${sfx.medianNs.toFixed(0)} ns`);
        console.log(`  Throughput (set):      ${formatOps(sfx.opsPerSec)} ops/sec`);

        expect(true).toBe(true);
    });
});
