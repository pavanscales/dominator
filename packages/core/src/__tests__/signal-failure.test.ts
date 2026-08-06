import { describe, it, expect, beforeEach } from 'vitest';
import { signal, effect, batch, signalArray, _resetSignals } from '../signal';

beforeEach(() => {
    _resetSignals();
});

describe('peak failure: a throwing effect', () => {
    it('does not abort dispatch or corrupt later effects (unbatched)', () => {
        const s = signal(0);
        let a = 0;
        let c = 0;
        effect(() => { a++; s(); });
        expect(() => effect(() => { s(); throw new Error('boom'); })).toThrow();
        effect(() => { c++; s(); });

        expect(a).toBe(1);
        expect(c).toBe(1);

        expect(() => s.set(2)).not.toThrow();
        expect(a).toBe(2);
        expect(c).toBe(2);
    });

    it('does not abort a batched flush', () => {
        const s = signal(0);
        let a = 0;
        let c = 0;
        effect(() => { a++; s(); });
        expect(() => effect(() => { s(); throw new Error('boom'); })).toThrow();
        effect(() => { c++; s(); });

        // the throwing effect is still subscribed; a batch flush must not abort
        expect(() => batch(() => { s.set(7); })).not.toThrow();
        expect(a).toBe(2);
    });

    it('leaves active-effect tracking cleanly resettable for later reads', () => {
        const s = signal(0);
        let a = 0;
        effect(() => { a++; s(); });
        expect(() => effect(() => { s(); throw new Error('boom'); })).toThrow();

        // a top-level read must not be attributed to the wedged effect
        expect(s()).toBe(0);
        expect(a).toBe(1);
    });
});

describe('peak-failure: reentrancy', () => {
    it('an effect that sets its own dependency runs exactly once more (no dup/miss)', () => {
        const s = signal(0);
        let hits = 0;
        effect(() => {
            s();
            hits++;
            if (s() === 0) s.set(1);
        });
        expect(hits).toBe(2);
    });

    it('setting a sibling signal mid-dispatch does not corrupt either subscriber slot', () => {
        const a = signal(0);
        const b = signal(0);
        let countA = 0;
        let countB = 0;
        effect(() => { a(); countA++; });
        effect(() => {
            b();
            countB++;
            if (b() === 1 && a() === 0) a.set(1); // reentrant set of a's subscribers
        });
        expect(countA).toBe(1);
        expect(countB).toBe(1);
        b.set(1);
        expect(countA).toBe(2);
        expect(countB).toBe(2);
    });
});

describe('peak-failure: subscriber scaling', () => {
    it('every subscriber runs on a signal with >255 subscribers (invariant: no silent cap)', () => {
        const s = signal(0);
        const seen = new Array(300).fill(-1);
        for (let i = 0; i < 300; i++) {
            effect(() => { seen[i] = s(); });
        }
        s.set(5);
        for (let i = 0; i < 300; i++) {
            expect(seen[i]).toBe(5);
        }
    });

    it('an effect with id > 4096 coexists on the same signal as a low-id effect', () => {
        const s = signal(0);
        let low = -1;
        let high = -1;
        effect(() => { low = s(); });
        for (let i = 0; i < 4098; i++) effect(() => {});
        effect(() => { high = s(); });
        s.set(7);
        expect(low).toBe(7);
        expect(high).toBe(7);
    });
});

describe('peak-failure: multiple string/object signals (arena staging)', () => {
    it('creates and updates multiple string signals without WASM parity panic', () => {
        const a = signal('x');
        const b = signal('y');
        const c = signal('z');
        a.set('p');
        expect(a()).toBe('p');
        expect(b()).toBe('y');
        expect(c()).toBe('z');
    });
});

describe('peak-failure: identity boundary', () => {
    it('signalArray that crosses the WASM/JS value boundary stays consistent', () => {
        for (let i = 0; i < 4090; i++) signal(0);
        const arr = signalArray(20, 0);
        arr.set(1, 999);
        expect(arr.get(1)).toBe(999);
        arr.setValues([1, 2, 3, 4, 5]);
        expect(arr.get(0)).toBe(1);
        expect(arr.get(4)).toBe(5);
    });
});