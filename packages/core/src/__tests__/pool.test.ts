import { describe, it, expect, vi } from 'vitest';
import { Pool } from '../pool';

describe('Pool', () => {
    it('creates objects via factory when pool is empty', () => {
        const factory = vi.fn(() => ({ val: 0 }));
        const pool = new Pool(factory, () => {});
        const obj = pool.get();
        expect(factory).toHaveBeenCalledOnce();
        expect(obj).toEqual({ val: 0 });
    });

    it('recycles released objects', () => {
        const pool = new Pool(
            () => ({ val: 0 }),
            (o) => { o.val = 0; }
        );
        const obj = pool.get();
        obj.val = 42;
        pool.release(obj);
        const obj2 = pool.get();
        expect(obj2).toBe(obj); // same reference
        expect(obj2.val).toBe(0); // reset
    });

    it('respects capacity (power of 2)', () => {
        const pool = new Pool(
            () => ({ val: 0 }),
            (o) => { o.val = 0; },
            4
        );
        const objs = Array.from({ length: 8 }, () => pool.get());
        objs.forEach((o) => pool.release(o));
        expect(pool.size).toBe(4); // capped at capacity
    });

    it('clear() empties the pool', () => {
        const pool = new Pool(
            () => ({ val: 0 }),
            (o) => { o.val = 0; }
        );
        const obj1 = pool.get();
        const obj2 = pool.get();
        pool.release(obj1);
        pool.release(obj2);
        expect(pool.size).toBe(2);
        pool.clear();
        expect(pool.size).toBe(0);
    });

    it('get() after clear creates new objects', () => {
        const pool = new Pool(
            () => ({ val: 0 }),
            (o) => { o.val = 0; }
        );
        const obj1 = pool.get();
        pool.release(obj1);
        pool.clear();
        const obj2 = pool.get();
        expect(obj2).not.toBe(obj1);
    });

    it('tracks size correctly', () => {
        const pool = new Pool(
            () => ({}),
            () => {}
        );
        expect(pool.size).toBe(0);
        const o = pool.get();
        expect(pool.size).toBe(0);
        pool.release(o);
        expect(pool.size).toBe(1);
    });
});

describe('Pool stress test', () => {
    it('handles 10000 get/release cycles', () => {
        const pool = new Pool(
            () => ({ x: 0 }),
            (o) => { o.x = 0; }
        );

        for (let i = 0; i < 10000; i++) {
            const obj = pool.get();
            obj.x = i;
            pool.release(obj);
        }
        expect(pool.size).toBeLessThanOrEqual(1024);
    });
});
