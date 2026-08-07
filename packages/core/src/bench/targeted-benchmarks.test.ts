import { describe, it, expect, beforeEach } from 'vitest';
import { signal, effect, batch, _resetSignals } from '../reactive/signal';
import { calibrate, toMs, formatOps, getClockName } from './measurement';
import { bench, report, benchScale, reportScale, compare } from './microbench';
import { probeMegamorphic, logICState, megamorphicWarning, v8DeoptSummary } from './v8-diag';

beforeEach(() => {
    _resetSignals();
});

const SHORT = { measureMs: 100, warmupMs: 50 };

describe('BOTTLENECK 1: Closure megamorphism (_effectFns[id]())', () => {
    it('Bench 1a: current _effectFns[id]() pattern (megamorphic)', () => {
        const N = 10_000;
        const effectFns: (() => void)[] = new Array(N);
        for (let i = 0; i < N; i++) { const x = i; effectFns[i] = () => { let sink = x * 2; }; }
        let idx = 0;
        const r = bench('B1a: closure dispatch', () => {
            effectFns[idx]();
            idx = (idx + 1) % N;
        }, SHORT);
        console.log(`  Closure:  ${toMs(r.medianNs)} median, ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('Bench 1b: function table with handlerId (monomorphic fix)', () => {
        const N = 10_000;
        const handlerTable = [(id: number) => { let sink = id * 2; }];
        const handlerIds = new Int32Array(N);
        for (let i = 0; i < N; i++) handlerIds[i] = 0;
        const fn = handlerTable[0];
        let idx = 0;
        const r = bench('B1b: table dispatch', () => {
            fn(handlerIds[idx]);
            idx = (idx + 1) % N;
        }, SHORT);
        console.log(`  Table:    ${toMs(r.medianNs)} median, ${formatOps(r.opsPerSec)} ops/sec`);
    });

    it('Bench 1c: direct comparison — closure vs table', () => {
        const N = 10_000;
        const effectFns: (() => void)[] = new Array(N);
        for (let i = 0; i < N; i++) { const x = i; effectFns[i] = () => { let sink = x * 2; }; }
        const handlerTable = [(id: number) => { let sink = id * 2; }];
        const handlerIds = new Int32Array(N);
        for (let i = 0; i < N; i++) handlerIds[i] = 0;
        const tableFn = handlerTable[0];
        let idx = 0;
        compare('closure dispatch', () => { effectFns[idx](); idx = (idx + 1) % N; },
                'table dispatch', () => { tableFn(handlerIds[idx]); idx = (idx + 1) % N; }, SHORT);
    });
});

describe('BOTTLENECK 2: markSignalDirty O(N) scan', () => {
    it('Bench 2a: O(N) scan — current algorithm (scale sweep)', () => {
        const Ns = [100, 1_000, 10_000];
        for (const N of Ns) {
            const signalRef = new Int32Array(N);
            const dirty = new Uint8Array(N);
            for (let i = 0; i < N; i++) signalRef[i] = i;
            const signalId = N >>> 1;
            const r = bench(`O(N) scan N=${N}`, () => {
                for (let i = 0; i < N; i++) {
                    if (signalRef[i] === signalId && !dirty[i]) { dirty[i] = 1; break; }
                }
            }, { measureMs: 100, warmupMs: 30 });
            console.log(`  N=${N.toLocaleString()}: ${toMs(r.medianNs)}`);
        }
    });

    it('Bench 2b: O(1) lookup — reverse index fix (scale sweep)', () => {
        const Ns = [100, 1_000, 10_000];
        for (const N of Ns) {
            const signalToNode = new Int32Array(N);
            const dirty = new Uint8Array(N);
            for (let i = 0; i < N; i++) signalToNode[i] = i;
            const signalId = N >>> 1;
            const r = bench(`O(1) lookup N=${N}`, () => {
                const nodeId = signalToNode[signalId];
                if (nodeId >= 0 && !dirty[nodeId]) dirty[nodeId] = 1;
            }, { measureMs: 100, warmupMs: 30 });
            console.log(`  N=${N.toLocaleString()}: ${toMs(r.medianNs)}`);
        }
    });

    it('Bench 2c: O(N) vs O(1) at 10K scale', () => {
        const N = 10_000;
        const signalRef = new Int32Array(N);
        const signalToNode = new Int32Array(N);
        const dirtyA = new Uint8Array(N);
        const dirtyB = new Uint8Array(N);
        for (let i = 0; i < N; i++) { signalRef[i] = i; signalToNode[i] = i; }
        const signalId = N >>> 1;
        compare('markSignalDirty O(N) [10K]',
            () => { for (let i = 0; i < N; i++) { if (signalRef[i] === signalId && !dirtyA[i]) { dirtyA[i] = 1; break; } } },
            'markSignalDirty O(1) [10K]',
            () => { const nid = signalToNode[signalId]; if (nid >= 0 && !dirtyB[nid]) dirtyB[nid] = 1; },
            { measureMs: 200, warmupMs: 50 });
    });
});

describe('BOTTLENECK 3: Effect callback megamorphic (compute-graph)', () => {
    it('Bench 3a: closure callbacks vs function table (100 calls)', () => {
        const N = 10_000;
        const closures: (() => void)[] = new Array(N);
        const handlerTable = [(id: number) => { let sink = id * 2; }];
        const ids = new Int32Array(N);
        const tableFn = handlerTable[0];
        for (let i = 0; i < N; i++) { const x = i; closures[i] = () => { let sink = x * 2; }; ids[i] = 0; }

        compare('100 closure calls', () => { for (let i = 0; i < 100; i++) closures[i](); },
                '100 table calls', () => { for (let i = 0; i < 100; i++) tableFn(ids[i]); },
                { measureMs: 200, warmupMs: 50 });
    });
});

describe('BOTTLENECK 4: BFS queue overflow', () => {
    it('Bench 4a: fixed 32K BFS push', () => {
        const CAP = 32768;
        const queue = new Int32Array(CAP);
        let count = 0;
        const r = bench('BFS push to 32K', () => { if (count < CAP) queue[count++] = count; }, SHORT);
        console.log(`  Push to 32K: ${toMs(r.medianNs)} (no bounds check)`);
    });

    it('Bench 4b: dynamic growth BFS', () => {
        let queue = new Int32Array(1024);
        let cap = 1024;
        let count = 0;
        const r = bench('BFS dynamic', () => {
            if (count >= cap) { cap *= 2; const nq = new Int32Array(cap); nq.set(queue.subarray(0, count)); queue = nq; }
            queue[count++] = count;
        }, SHORT);
        console.log(`  Dynamic:   ${toMs(r.medianNs)} (bounds check + grow)`);
    });
});

describe('BOTTLENECK 5: Animation compaction vs swap-remove', () => {
    it('Bench 5: compaction vs swap-remove at 10K', () => {
        const N = 10_000;
        const dataA = new Float64Array(N);
        const dataB = new Float64Array(N);
        for (let i = 0; i < N; i++) { dataA[i] = i; dataB[i] = i; }

        compare('compaction [10K]',
            () => { let w = 0; for (let r = 0; r < N; r++) { if (r % 3 === 0) continue; dataA[w++] = dataA[r]; } },
            'swap-remove [10K]',
            () => { let c = N; for (let i = c - 1; i >= 0; i--) { if (i % 3 === 0) dataB[i] = dataB[--c]; } },
            { measureMs: 200, warmupMs: 50 });
    });
});

describe('BOTTLENECK 6: Layout two-pass overhead', () => {
    it('Bench 6: two-pass vs fused at 10K', () => {
        const N = 10_000;
        const w = new Float64Array(N); const h = new Float64Array(N);
        const x = new Float64Array(N); const y = new Float64Array(N);
        for (let i = 0; i < N; i++) { w[i] = i % 100 + 10; h[i] = i % 50 + 10; }

        compare('two-pass [10K]',
            () => { for (let i = 0; i < N; i++) { x[i] = w[i] * 0.5; y[i] = h[i] * 0.5; } for (let i = 0; i < N; i++) { const s = x[i] + y[i]; x[i] = s; y[i] = s * 0.3; } },
            'fused [10K]',
            () => { for (let i = 0; i < N; i++) { const xi = w[i] * 0.5; const yi = h[i] * 0.5; const s = xi + yi; x[i] = s; y[i] = s * 0.3; } },
            { measureMs: 200, warmupMs: 50 });
    });
});

describe('BOTTLENECK 7: Text allocation per frame', () => {
    it('Bench 7: split+measureText vs cached', () => {
        const text = 'Hello world this is a test string for benchmarking layout';
        const words = text.split(' ');
        const cache = new Float64Array(words.length);
        const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;

        compare('split+measure',
            () => { const w = text.split(' '); let tw = 0; if (ctx) for (let i = 0; i < w.length; i++) tw += ctx.measureText(w[i]).width; },
            'cached',
            () => { let tw = 0; for (let i = 0; i < words.length; i++) tw += cache[i]; },
            { measureMs: 100, warmupMs: 30 });
    });
});

describe('AGGREGATE: signal.set() at scale', () => {
    it('signal.set() + 1K effects', () => {
        const s = signal(0);
        const N = 1_000;
        let sink = 0;
        for (let i = 0; i < N; i++) effect(() => { s(); sink++; });
        sink = 0;
        const r = bench(`set+${N}effects`, () => { s.set(sink + 1); }, { measureMs: 200, warmupMs: 50 });
        console.log(`  set + ${N} effects: ${toMs(r.medianNs)} median`);
    });

    it('signal.set() + 10K effects', () => {
        const s = signal(0);
        const N = 10_000;
        let sink = 0;
        for (let i = 0; i < N; i++) effect(() => { s(); sink++; });
        sink = 0;
        const r = bench(`set+${N}effects`, () => { s.set(sink + 1); }, { measureMs: 200, warmupMs: 50 });
        console.log(`  set + ${N} effects: ${toMs(r.medianNs)} median`);
    });
});

describe('V8 DIAGNOSTICS', () => {
    it('print V8 deopt analysis guide', () => {
        console.log(v8DeoptSummary());
    });

    it('detect megamorphic in signal.set() hot path', () => {
        const s = signal(0);
        let sink = 0;
        effect(() => { s(); sink++; });
        sink = 0;

        const N = 100;
        const effectFns: (() => void)[] = new Array(N);
        for (let i = 0; i < N; i++) { const x = i; effectFns[i] = () => { sink = x * 2; }; }

        const results = probeMegamorphic('_effectFns probe', [
            { name: 'eff[0]', fn: effectFns[0] },
            { name: 'eff[1]', fn: effectFns[1] },
            { name: 'eff[10]', fn: effectFns[10] },
            { name: 'eff[50]', fn: effectFns[50] },
            { name: 'eff[99]', fn: effectFns[99] },
        ]);
        logICState([results]);
        if (results.isMegamorphic) console.log(megamorphicWarning());
    });
});

describe('CALIBRATION', () => {
    it('print calibration info', () => {
        const oh = calibrate(20000);
        console.log(`  Clock: ${getClockName()}  Overhead: ${oh.toFixed(0)} ns`);
    });

    it('measure empty loop overhead', () => {
        const r = bench('empty loop', () => {}, SHORT);
        console.log(`  Empty loop: ${toMs(r.medianNs)} median, ${formatOps(r.opsPerSec)} ops/sec`);
        console.log(`  (should be ~0ns after overhead subtraction, ~30M+ ops/sec)`);
    });
});
