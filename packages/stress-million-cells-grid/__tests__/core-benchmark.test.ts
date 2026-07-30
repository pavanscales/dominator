import { describe, it, expect, beforeEach } from 'vitest';
import { signal, effect, batch, computed, _resetSignals, flushSync } from '../../core/src/signal';

const RUNS = 100_000;

describe('core reactivity microbenchmarks (signal/effect/batch)', () => {

    beforeEach(() => {
        _resetSignals();
    });

    it('signal set throughput (no effect, no batch)', () => {
        const s = signal(0);
        const start = performance.now();
        for (let i = 0; i < RUNS; i++) {
            s.set(i);
        }
        const elapsed = performance.now() - start;
        const opsPerMs = RUNS / elapsed;
        console.log(`[BENCH] signal.set() x${RUNS}: ${elapsed.toFixed(2)}ms (${(opsPerMs / 1000).toFixed(1)}M ops/sec)`);
        expect(s()).toBe(RUNS - 1);
    });

    it('signal set + effect re-run throughput (1 effect)', () => {
        const s = signal(0);
        let effectCalls = 0;
        effect(() => {
            s();
            effectCalls++;
        });
        effectCalls = 0;

        const start = performance.now();
        for (let i = 0; i < RUNS; i++) {
            s.set(i);
        }
        const elapsed = performance.now() - start;
        const opsPerMs = RUNS / elapsed;
        console.log(`[BENCH] signal.set() + 1 effect x${RUNS}: ${elapsed.toFixed(2)}ms (${(opsPerMs / 1000).toFixed(1)}M ops/sec)`);
        expect(effectCalls).toBe(RUNS - 1);
    });

    it('signal set with multiple chained dependencies', () => {
        const a = signal(1);
        const b = computed(() => a() * 2);
        const c = computed(() => b() + 3);
        const d = computed(() => c() * 4);

        let result = 0;
        effect(() => { result = d(); });
        flushSync();

        const start = performance.now();
        for (let i = 0; i < RUNS; i++) {
            a.set(i);
        }
        const elapsed = performance.now() - start;
        const opsPerMs = RUNS / elapsed;
        console.log(`[BENCH] signal -> 3 computed -> 1 effect x${RUNS}: ${elapsed.toFixed(2)}ms (${(opsPerMs / 1000).toFixed(1)}M ops/sec)`);
        expect(result).toBe(((RUNS - 1) * 2 + 3) * 4);
    });

    it('batch with many signal sets (simulating the stress grid pattern)', () => {
        const grid = signal(0);
        let effectRuns = 0;
        effect(() => { grid(); effectRuns++; });
        effectRuns = 0;

        const BATCH_SIZE = 3000;
        const BATCHES = 100;
        const totalOps = BATCH_SIZE * BATCHES;

        const start = performance.now();
        for (let b = 0; b < BATCHES; b++) {
            batch(() => {
                for (let i = 0; i < BATCH_SIZE; i++) {
                    grid.set(b * BATCH_SIZE + i);
                }
            });
        }
        const elapsed = performance.now() - start;
        const opsPerMs = totalOps / elapsed;
        console.log(`[BENCH] batch(${BATCH_SIZE} sets) x${BATCHES}: ${elapsed.toFixed(2)}ms (${(opsPerMs / 1000).toFixed(1)}M ops/sec)`);
        expect(effectRuns).toBe(BATCHES);
    });

    it('batch with viewport-style signal pattern (4 viewport + 1 grid signal)', () => {
        const rowStart = signal(0);
        const rowEnd = signal(80);
        const colStart = signal(0);
        const colEnd = signal(60);
        const gridVersion = signal(0);

        let computeCount = 0;
        const visibleRows = computed(() => {
            const start = rowStart();
            const end = rowEnd();
            const len = end - start + 1;
            computeCount++;
            return new Array(len).fill(0).map((_, i) => start + i);
        });

        let effectRuns = 0;
        effect(() => {
            gridVersion();
            visibleRows();
            effectRuns++;
        });
        effectRuns = 0;
        computeCount = 0;

        const start = performance.now();
        for (let i = 0; i < 1000; i++) {
            batch(() => {
                const rs = Math.floor(Math.random() * 500);
                rowStart.set(rs);
                rowEnd.set(Math.min(999, rs + 80 + Math.floor(Math.random() * 20)));
                const cs = Math.floor(Math.random() * 500);
                colStart.set(cs);
                colEnd.set(Math.min(999, cs + 60 + Math.floor(Math.random() * 20)));
                gridVersion.set(i);
            });
        }
        const elapsed = performance.now() - start;
        console.log(`[BENCH] viewport-style batching 1000 updates: ${elapsed.toFixed(2)}ms (${(1000 / (elapsed / 1000)).toFixed(0)} updates/sec)`);
    });

    it('signal set with 150 effects (simulating 50 visible cells x 3 effects each)', () => {
        const grid = signal(0);
        const effectCount = 150;
        let totalRuns = 0;

        for (let i = 0; i < effectCount; i++) {
            effect(() => {
                grid();
                totalRuns++;
            });
        }
        totalRuns = 0;

        const expected = 200 * effectCount;
        let perBatchRuns = 0;
        let prevTotal = totalRuns;
        const batchCounts: number[] = [];

        for (let b = 0; b < 200; b++) {
            batch(() => {
                grid.set(b + 1);
            });
            perBatchRuns = totalRuns - prevTotal;
            batchCounts.push(perBatchRuns);
            prevTotal = totalRuns;
        }

        const minBatch = Math.min(...batchCounts);
        const maxBatch = Math.max(...batchCounts);
        const avgBatch = batchCounts.reduce((s, c) => s + c, 0) / batchCounts.length;
        const batchesWithLoss = batchCounts.filter(c => c < effectCount).length;
        console.log(`[BENCH] 1 signal + ${effectCount} effects, 200 batch flushes: ${totalRuns} total, min=${minBatch} max=${maxBatch} avg=${avgBatch.toFixed(1)}`);
        if (batchesWithLoss > 0) console.log(`[BENCH] Batches with <${effectCount} runs: ${batchesWithLoss} (first few: ${batchCounts.filter(c => c < effectCount).slice(0, 5).join(',')})`);
        expect(totalRuns).toBe(expected);
    });

    it('memory allocation test - repeated signal creation', () => {
        const count = 50000;
        const start = performance.now();
        const sigs: ReturnType<typeof signal>[] = [];
        for (let i = 0; i < count; i++) {
            sigs.push(signal(i));
        }
        const elapsed = performance.now() - start;
        console.log(`[BENCH] Create ${count} signals: ${elapsed.toFixed(2)}ms (${(count / elapsed).toFixed(0)}/ms)`);
        expect(sigs.length).toBe(count);
        expect(sigs[0]()).toBe(0);
        expect(sigs[count - 1]()).toBe(count - 1);
    });

    it('computed GC/no-allocation test - computed does not create closures per read', () => {
        const s = signal(42);
        const c = computed(() => s() * 2);

        const start = performance.now();
        let sum = 0;
        for (let i = 0; i < RUNS; i++) {
            sum += c();
        }
        const elapsed = performance.now() - start;
        const opsPerMs = RUNS / elapsed;
        console.log(`[BENCH] computed() read x${RUNS}: ${elapsed.toFixed(2)}ms (${(opsPerMs / 1000).toFixed(1)}M reads/sec)`);
        expect(sum).toBe(42 * 2 * RUNS);
    });

    it('stress: worst-case dirty bitmap with >8192 signal IDs', () => {
        const signals: ReturnType<typeof signal>[] = [];
        for (let i = 0; i < 10000; i++) {
            signals.push(signal(0));
        }

        let effectRuns = 0;
        effect(() => {
            for (let i = 0; i < 10000; i++) signals[i]();
            effectRuns++;
        });
        effectRuns = 0;

        const start = performance.now();
        batch(() => {
            for (let i = 0; i < 10000; i++) {
                signals[i].set(i + 1);
            }
        });
        const elapsed = performance.now() - start;
        console.log(`[BENCH] 10K signals (exceeds 8192 bitmap) batched set + effect: ${elapsed.toFixed(3)}ms`);
        expect(effectRuns).toBe(1);
    });
});
