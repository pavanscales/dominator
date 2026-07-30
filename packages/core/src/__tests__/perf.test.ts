import { describe, it, expect, beforeEach } from 'vitest';
import { signal, effect, computed, batch, flushSync, _resetSignals, getSignalCount, getEffectCount } from '../signal';

beforeEach(() => {
    _resetSignals();
});

function bench(label: string, fn: () => void, timeMs = 500): { opsPerSec: number; avgNs: number } {
    // Warmup for 50ms
    const warmEnd = performance.now() + 50;
    while (performance.now() < warmEnd) fn();

    let ops = 0;
    const start = performance.now();
    const deadline = start + timeMs;
    while (performance.now() < deadline) {
        fn();
        ops++;
    }
    const elapsed = performance.now() - start;
    const opsPerSec = (ops / elapsed) * 1000;
    const avgNs = (elapsed * 1_000_000) / ops;

    console.log(`  ${label}: ${opsPerSec.toFixed(0)} ops/sec (${avgNs.toFixed(0)} ns/op, ${ops} iterations in ${elapsed.toFixed(0)}ms)`);
    return { opsPerSec, avgNs };
}

// ═══════════════════════════════════════════════════════════════════════
// SIGNAL READ/WRITE
// ═══════════════════════════════════════════════════════════════════════
describe('PERF: signal read/write', () => {
    it('signal.set() throughput (no effects)', () => {
        const s = signal(0);
        const r = bench('signal.set() no-effect', () => {
            s.set(Math.random());
        });
        expect(r.opsPerSec).toBeGreaterThan(500_000);
    });

    it('signal() read throughput', () => {
        const s = signal(42);
        let sink = 0;
        const r = bench('signal() read', () => {
            sink = s();
        });
        expect(r.opsPerSec).toBeGreaterThan(500_000);
        expect(sink).toBe(42);
    });

    it('signal.update() throughput', () => {
        const s = signal(0);
        const r = bench('signal.update()', () => {
            s.update(v => v + 1);
        });
        expect(r.opsPerSec).toBeGreaterThan(500_000);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// EFFECT
// ═══════════════════════════════════════════════════════════════════════
describe('PERF: effect reactivity', () => {
    it('signal.set() + 1 effect re-run', () => {
        const s = signal(0);
        let runs = 0;
        effect(() => { s(); runs++; });
        runs = 0;
        const r = bench('set() + 1 effect', () => {
            s.set(runs);
        });
        expect(r.opsPerSec).toBeGreaterThan(400_000);
    });

    it('signal.set() + 10 effects', () => {
        const s = signal(0);
        let totalRuns = 0;
        for (let i = 0; i < 10; i++) {
            effect(() => { s(); totalRuns++; });
        }
        totalRuns = 0;
        const r = bench('set() + 10 effects', () => {
            s.set(totalRuns);
        });
        expect(r.opsPerSec).toBeGreaterThan(200_000);
    });

    it('signal.set() + 100 effects', () => {
        const s = signal(0);
        let totalRuns = 0;
        for (let i = 0; i < 100; i++) {
            effect(() => { s(); totalRuns++; });
        }
        totalRuns = 0;
        const r = bench('set() + 100 effects', () => {
            s.set(totalRuns);
        });
        expect(r.opsPerSec).toBeGreaterThan(30_000);
    });

    it('effect dependency switching', () => {
        const a = signal(1);
        const b = signal(2);
        const toggle = signal(true);
        effect(() => { if (toggle()) a(); else b(); });
        const r = bench('effect dep switch', () => {
            toggle.update(v => !v);
        });
        expect(r.opsPerSec).toBeGreaterThan(100_000);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// COMPUTED CHAINS
// ═══════════════════════════════════════════════════════════════════════
describe('PERF: computed chains', () => {
    it('3-level computed chain', () => {
        const a = signal(1);
        const b = computed(() => a() * 2);
        const c = computed(() => b() + 3);
        const d = computed(() => c() * 4);
        let result = 0;
        effect(() => { result = d(); });
        result = 0;
        const r = bench('signal → 3 computed', () => {
            a.set(result + 1);
        });
        expect(r.opsPerSec).toBeGreaterThan(200_000);
    });

    it('diamond dependency', () => {
        const root = signal(1);
        const left = computed(() => root() + 1);
        const right = computed(() => root() * 2);
        let combo = 0;
        effect(() => { combo = left() + right(); });
        combo = 0;
        const r = bench('diamond dependency', () => {
            root.set(combo + 1);
        });
        expect(r.opsPerSec).toBeGreaterThan(100_000);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// BATCH
// ═══════════════════════════════════════════════════════════════════════
describe('PERF: batching', () => {
    it('batch with 10 signal sets', () => {
        const signals = Array.from({ length: 10 }, () => signal(0));
        let runs = 0;
        effect(() => { signals.forEach(s => s()); runs++; });
        runs = 0;
        const r = bench('batch(10 sets)', () => {
            batch(() => {
                for (let i = 0; i < 10; i++) signals[i]!.set(runs + i);
            });
        });
        expect(r.opsPerSec).toBeGreaterThan(20_000);
    });

    it('batch with 100 signal sets', () => {
        const signals = Array.from({ length: 100 }, () => signal(0));
        let runs = 0;
        effect(() => { signals.forEach(s => s()); runs++; });
        runs = 0;
        const r = bench('batch(100 sets)', () => {
            batch(() => {
                for (let i = 0; i < 100; i++) signals[i]!.set(runs + i);
            });
        });
        expect(r.opsPerSec).toBeGreaterThan(4_000);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// MEMORY / GC
// ═══════════════════════════════════════════════════════════════════════
describe('PERF: memory / GC', () => {
    it('effect create+dispose cycle', () => {
        const s = signal(0);
        const r = bench('effect create+dispose', () => {
            const scope = effect(() => { s(); });
            scope.dispose();
        });
        expect(r.opsPerSec).toBeGreaterThan(100_000);
    });

    it('subscribe/unsubscribe cycle', () => {
        const s = signal(0);
        const r = bench('subscribe/unsubscribe', () => {
            const unsub = s.subscribe(() => {});
            unsub();
        });
        expect(r.opsPerSec).toBeGreaterThan(100_000);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// EXTREME SCALE
// ═══════════════════════════════════════════════════════════════════════
describe('PERF: extreme scale', () => {
    it('10K signals all dirty in single batch', () => {
        const N = 10_000;
        const signals = Array.from({ length: N }, (_, i) => signal(i));
        let sum = 0;
        effect(() => { sum = signals.reduce((a, s) => a + (s() as number), 0); });
        sum = 0;
        const r = bench(`batch ${N} signals`, () => {
            batch(() => {
                for (let i = 0; i < N; i++) signals[i]!.set(i + 1);
            });
        }, 200);
        expect(r.opsPerSec).toBeGreaterThan(100);
    });

    it('1000 effects on single signal', () => {
        const s = signal(0);
        const N = 1000;
        let totalRuns = 0;
        for (let i = 0; i < N; i++) {
            effect(() => { s(); totalRuns++; });
        }
        totalRuns = 0;
        const r = bench(`1 signal → ${N} effects`, () => {
            s.set(totalRuns + 1);
        }, 200);
        expect(r.opsPerSec).toBeGreaterThan(200);
    });

    it('wide fan-in: 1000 signals → 1 effect', () => {
        const N = 1000;
        const signals = Array.from({ length: N }, (_, i) => signal(i));
        let runs = 0;
        effect(() => { signals.forEach(s => s()); runs++; });
        runs = 0;
        const r = bench(`${N} signals → 1 effect`, () => {
            batch(() => {
                for (let i = 0; i < N; i++) signals[i]!.set(runs + i);
            });
        }, 200);
        expect(r.opsPerSec).toBeGreaterThan(200);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// CORRECTNESS: deduplication
// ═══════════════════════════════════════════════════════════════════════
describe('PERF: dedup correctness', () => {
    it('batch dedup: 100K sets → 1 effect run', () => {
        const s = signal(0);
        let runs = 0;
        effect(() => { s(); runs++; });
        runs = 0;
        batch(() => { for (let i = 0; i < 100_000; i++) s.set(i); });
        expect(runs).toBe(1);
    });

    it('conditional deps: no re-run on unrelated signal', () => {
        const a = signal(1);
        const b = signal(1);
        const toggle = signal(true);
        let runs = 0;
        effect(() => { if (toggle()) a(); else b(); runs++; });
        runs = 0;
        for (let i = 0; i < 100_000; i++) b.set(i);
        expect(runs).toBe(0);
        a.set(999);
        expect(runs).toBe(1);
    });
});
