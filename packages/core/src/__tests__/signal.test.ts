import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, effect, computed, batch, flushSync, signalArray, _resetSignals } from '../signal';

beforeEach(() => {
    _resetSignals();
});

describe('signal', () => {
    it('creates a signal with initial value', () => {
        const s = signal(42);
        expect(s()).toBe(42);
        expect(s.get()).toBe(42);
    });

    it('updates value via set()', () => {
        const s = signal(0);
        s.set(5);
        expect(s()).toBe(5);
    });

    it('updates value via update()', () => {
        const s = signal(10);
        s.update((n) => n + 5);
        expect(s()).toBe(15);
    });

    it('does not notify subscribers when value is unchanged', () => {
        const s = signal(1);
        const fn = vi.fn();
        s.subscribe(fn);
        s.set(1); // same value
        expect(fn).not.toHaveBeenCalled();
    });

    it('notifies subscribers on change', () => {
        const s = signal(0);
        const fn = vi.fn();
        s.subscribe(fn);
        s.set(1);
        expect(fn).toHaveBeenCalledOnce();
    });

    it('supports multiple subscribers', () => {
        const s = signal(0);
        const fn1 = vi.fn();
        const fn2 = vi.fn();
        s.subscribe(fn1);
        s.subscribe(fn2);
        s.set(1);
        expect(fn1).toHaveBeenCalledOnce();
        expect(fn2).toHaveBeenCalledOnce();
    });

    it('unsubscribe works', () => {
        const s = signal(0);
        const fn = vi.fn();
        const unsub = s.subscribe(fn);
        s.set(1);
        expect(fn).toHaveBeenCalledOnce();
        unsub();
        s.set(2);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe('effect', () => {
    it('runs immediately', () => {
        const s = signal(0);
        let value = -1;
        effect(() => {
            value = s();
        });
        expect(value).toBe(0);
    });

    it('re-runs when subscribed signal changes', () => {
        const s = signal(0);
        let runCount = 0;
        effect(() => {
            s();
            runCount++;
        });
        expect(runCount).toBe(1);
        s.set(1);
        expect(runCount).toBe(2);
        s.set(2);
        expect(runCount).toBe(3);
    });

    it('cleans up old dependencies correctly', () => {
        const a = signal(1);
        const b = signal(10);
        const toggle = signal(true);
        let result = 0;

        effect(() => {
            if (toggle()) {
                result = a();
            } else {
                result = b();
            }
        });

        expect(result).toBe(1);

        // Change b — should NOT re-run (effect depends on a, not b)
        b.set(99);
        expect(result).toBe(1);

        // Toggle to depend on b
        toggle.set(false);
        expect(result).toBe(99);

        // Now changing a should NOT re-run
        a.set(50);
        expect(result).toBe(99);

        // But changing b should
        b.set(200);
        expect(result).toBe(200);
    });

    it('handles nested effects', () => {
        const s = signal(0);
        const inner = signal('hello');
        let outerVal = -1;
        let innerVal = '';

        effect(() => {
            outerVal = s();
            effect(() => {
                innerVal = inner();
            });
        });

        expect(outerVal).toBe(0);
        expect(innerVal).toBe('hello');

        s.set(1);
        expect(outerVal).toBe(1);
    });
});

describe('computed', () => {
    it('computes derived value', () => {
        const s = signal(2);
        const doubled = computed(() => s() * 2);
        expect(doubled()).toBe(4);
    });

    it('updates when dependency changes', () => {
        const s = signal(2);
        const doubled = computed(() => s() * 2);
        s.set(5);
        expect(doubled()).toBe(10);
    });

    it('only recomputes when dependency changes', () => {
        const s = signal(2);
        let computeCount = 0;
        const doubled = computed(() => {
            computeCount++;
            return s() * 2;
        });
        expect(computeCount).toBe(1);
        s.set(5);
        expect(doubled()).toBe(10);
        expect(computeCount).toBe(2);
    });
});

describe('batch', () => {
    it('defers signal notifications until batch completes', () => {
        const s1 = signal(0);
        const s2 = signal(0);
        let runCount = 0;

        effect(() => {
            s1();
            s2();
            runCount++;
        });

        const initial = runCount;
        batch(() => {
            s1.set(1);
            s2.set(2);
        });

        // Effect should have run during batch drain
        expect(runCount).toBeGreaterThan(initial);
    });

    it('deduplicates dirty signals', () => {
        const s = signal(0);
        let runCount = 0;
        effect(() => {
            s();
            runCount++;
        });

        batch(() => {
            s.set(1);
            s.set(2);
            s.set(3);
        });

        // Should only re-run once after batch (deduped)
        expect(runCount).toBe(2); // 1 initial + 1 after batch
    });

    it('nested batches only flush at outermost', () => {
        const s = signal(0);
        let runCount = 0;
        effect(() => {
            s();
            runCount++;
        });

        batch(() => {
            s.set(1);
            batch(() => {
                s.set(2);
            });
        });

        // Only 1 re-run after all batches complete
        expect(runCount).toBe(2);
    });

    it('multiple batch calls schedule correctly', () => {
        const s = signal(0);
        let runCount = 0;
        effect(() => {
            s();
            runCount++;
        });

        batch(() => { s.set(1); });
        batch(() => { s.set(2); });

        expect(runCount).toBe(3); // 1 initial + 1 from batch1 + 1 from batch2
    });
});

describe('flushSync', () => {
    it('manually drains pending signals', () => {
        const s = signal(0);
        let lastValue = -1;
        effect(() => {
            lastValue = s();
        });

        // flushSync when nothing pending should be a no-op
        flushSync();
        expect(lastValue).toBe(0);
    });
});

describe('stress test', () => {
    it('handles 1000 signals efficiently', () => {
        const signals = Array.from({ length: 1000 }, (_, i) => signal(i));
        let sum = 0;
        effect(() => {
            sum = signals.reduce((acc, s) => acc + s(), 0);
        });

        expect(sum).toBe(499500);

        batch(() => {
            for (let i = 0; i < 1000; i++) {
                signals[i]!.set(i * 2);
            }
        });

        expect(sum).toBe(999000);
    });

    it('handles rapid subscribe/unsubscribe cycles', () => {
        const s = signal(0);
        const fns = Array.from({ length: 100 }, () => vi.fn());

        fns.forEach((fn) => s.subscribe(fn));
        s.set(1);
        fns.forEach((fn) => expect(fn).toHaveBeenCalledOnce());

        const unsubs = fns.map((fn) => s.subscribe(fn));
        unsubs.forEach((unsub) => unsub());
        s.set(2);
        // Original subs still fire, new (unsubscribed) ones don't
    });
});

describe('multi-subscriber Zig effects (regression)', () => {
    it('runs both effects on unbatched set', () => {
        const s = signal(0);
        let a = 0;
        let b = 0;
        effect(() => { a = s(); });
        effect(() => { b = s(); });
        expect(a).toBe(0);
        expect(b).toBe(0);
        s.set(5);
        expect(a).toBe(5);
        expect(b).toBe(5);
    });

    it('runs both effects on batched set', () => {
        const s = signal(0);
        let a = 0;
        let b = 0;
        effect(() => { a = s(); });
        effect(() => { b = s(); });
        batch(() => { s.set(5); });
        expect(a).toBe(5);
        expect(b).toBe(5);
    });

    it('only re-runs an effect when its own dep changes (dep pruning across effects)', () => {
        const s = signal(0);
        const t = signal(0);
        let countA = 0;
        let countB = 0;
        let countC = 0;
        effect(() => { s(); countA++; });
        effect(() => { t(); countB++; });
        effect(() => { t(); countC++; });

        expect(countA).toBe(1);
        s.set(1);
        expect(countA).toBe(2);
        expect(countB).toBe(1);
        t.set(1);
        expect(countB).toBe(2);
        expect(countC).toBe(2);
    });

    it('dispatches three+ Zig subscribers via WASM snapshot', () => {
        const s = signal(0);
        let hits = 0;
        for (let i = 0; i < 5; i++) {
            effect(() => { s(); hits++; });
        }
        s.set(7);
        expect(hits).toBe(10);
        batch(() => { s.set(9); });
        expect(hits).toBe(15);
    });

    it('handles signalArray with multiple subscribers', () => {
        const arr = signalArray(3, 0);
        let a = 0;
        let b = 0;
        effect(() => { a = arr.get(1); });
        effect(() => { b = arr.get(1); });
        arr.set(1, 42);
        expect(a).toBe(42);
        expect(b).toBe(42);
        arr.setValues([1, 2, 3]);
        expect(a).toBe(2);
        expect(b).toBe(2);
    });
});
