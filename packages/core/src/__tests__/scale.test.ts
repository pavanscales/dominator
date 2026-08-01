import { describe, it, expect, beforeEach } from 'vitest';
import { signal, effect, batch, signalArray, _resetSignals } from '../signal';
import { refreshViews } from '../wasm-glue';

beforeEach(() => {
    _resetSignals();
});

describe('scale', () => {
    it('runs every effect when more than 8192 signals are dirty in one batch', () => {
        const N = 20_000;
        const sigs = Array.from({ length: N }, (_, i) => signal(0));
        const runs = new Int32Array(N);
        const scopes = new Array(N);

        for (let i = 0; i < N; i++) {
            const idx = i;
            scopes[i] = effect(() => {
                sigs[idx]!();
                runs[idx]!++;
            });
        }

        batch(() => {
            for (let i = 0; i < N; i++) {
                sigs[i]!.set(i + 1);
            }
        });

        for (let i = 0; i < N; i++) {
            expect(runs[i]).toBe(2);
        }

        for (let i = 0; i < N; i++) {
            scopes[i]!.dispose();
        }
    });

    it('runs more than 2048 distinct effects from one batch', () => {
        const N = 5_000;
        const sigs = Array.from({ length: N }, (_, i) => signal(0));
        let runs = 0;

        for (let i = 0; i < N; i++) {
            const idx = i;
            effect(() => {
                sigs[idx]!();
                runs++;
            });
        }

        batch(() => {
            for (let i = 0; i < N; i++) {
                sigs[i]!.set(i + 1);
            }
        });

        expect(runs).toBe(N * 2);
    });

    it('dedups effects above id 8192 subscribed to multiple signals', () => {
        const N = 9_000;
        const filler = Array.from({ length: N }, () => signal(0));
        void filler;

        const a = signal(0);
        const b = signal(0);
        let runCount = 0;

        effect(() => {
            a();
            b();
            runCount++;
        });

        expect(runCount).toBe(1);

        batch(() => {
            a.set(1);
            b.set(2);
        });

        expect(runCount).toBe(2);
    });

    it('setValues does not notify when values are unchanged', () => {
        const arr = signalArray(1_000, 7);
        let runCount = 0;
        effect(() => {
            arr.get(0);
            runCount++;
        });

        const same = new Float64Array(1_000);
        same.fill(7);

        arr.setValues(same);
        expect(runCount).toBe(1);
    });

    it('setValues notifies once when values change', () => {
        const arr = signalArray(1_000, 0);
        let runCount = 0;
        effect(() => {
            arr.get(0);
            runCount++;
        });

        const next = new Float64Array(1_000);
        next.fill(1);

        arr.setValues(next);
        expect(runCount).toBe(2);
        expect(arr.get(999)).toBe(1);
    });

    it('setValues with more than 8192 changed elements notifies every subscriber', () => {
        const N = 50_000;
        const arr = signalArray(N, 0);
        let firstRuns = 0;
        let lastRuns = 0;

        effect(() => {
            arr.get(0);
            firstRuns++;
        });
        effect(() => {
            arr.get(N - 1);
            lastRuns++;
        });

        const next = new Float64Array(N);
        next.fill(1);

        arr.setValues(next);

        expect(firstRuns).toBe(2);
        expect(lastRuns).toBe(2);
        expect(arr.get(25_000)).toBe(1);
    });

    it('refreshViews preserves arena state and subscriptions', () => {
        const s = signal(42);
        let value = 0;
        effect(() => {
            value = s();
        });

        expect(value).toBe(42);
        s.set(100);
        expect(value).toBe(100);

        refreshViews();

        expect(s()).toBe(100);
        s.set(200);
        expect(value).toBe(200);
    });
});
