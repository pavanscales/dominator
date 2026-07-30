import { describe, it, expect, beforeEach } from 'vitest';
import {
    subsInit, subsAdd, subsRemove, subsGetLength, subsGetAt,
    subsForEach, subsReset,
} from '../subs-flat';

describe('subs-flat', () => {
    beforeEach(() => {
        subsReset();
    });

    it('initializes a signal with 0 subscribers', () => {
        subsInit(0);
        expect(subsGetLength(0)).toBe(0);
    });

    it('adds subscribers', () => {
        subsInit(0);
        subsAdd(0, 10);
        subsAdd(0, 20);
        subsAdd(0, 30);
        expect(subsGetLength(0)).toBe(3);
        expect(subsGetAt(0, 0)).toBe(10);
        expect(subsGetAt(0, 1)).toBe(20);
        expect(subsGetAt(0, 2)).toBe(30);
    });

    it('deduplicates subscribers', () => {
        subsInit(0);
        subsAdd(0, 10);
        subsAdd(0, 10);
        subsAdd(0, 10);
        expect(subsGetLength(0)).toBe(1);
    });

    it('removes subscribers with swap-remove', () => {
        subsInit(0);
        subsAdd(0, 10);
        subsAdd(0, 20);
        subsAdd(0, 30);

        subsRemove(0, 20);
        expect(subsGetLength(0)).toBe(2);
        // After swap-remove, the order may change but all remaining are present
        const remaining = new Set<number>();
        for (let i = 0; i < subsGetLength(0); i++) {
            remaining.add(subsGetAt(0, i));
        }
        expect(remaining.has(10)).toBe(true);
        expect(remaining.has(30)).toBe(true);
        expect(remaining.has(20)).toBe(false);
    });

    it('removes last subscriber cleanly', () => {
        subsInit(0);
        subsAdd(0, 10);
        subsRemove(0, 10);
        expect(subsGetLength(0)).toBe(0);
    });

    it('handles multiple signals independently', () => {
        subsInit(0);
        subsInit(1);
        subsInit(2);

        subsAdd(0, 100);
        subsAdd(1, 200);
        subsAdd(1, 300);
        subsAdd(2, 400);

        expect(subsGetLength(0)).toBe(1);
        expect(subsGetLength(1)).toBe(2);
        expect(subsGetLength(2)).toBe(1);
    });

    it('forEach iterates all subscribers', () => {
        subsInit(0);
        subsAdd(0, 5);
        subsAdd(0, 10);
        subsAdd(0, 15);

        const collected: number[] = [];
        subsForEach(0, (id) => collected.push(id));
        expect(collected).toEqual([5, 10, 15]);
    });

    it('handles rapid allocation of many signals', () => {
        for (let i = 0; i < 5000; i++) {
            subsInit(i);
            subsAdd(i, i * 10);
        }
        expect(subsGetLength(4999)).toBe(1);
        expect(subsGetAt(4999, 0)).toBe(49990);
    });

    it('resets cleanly', () => {
        subsInit(0);
        subsAdd(0, 10);
        subsReset();
        subsInit(0);
        expect(subsGetLength(0)).toBe(0);
    });

    it('max 255 subscribers per signal', () => {
        subsInit(0);
        for (let i = 0; i < 300; i++) {
            subsAdd(0, i);
        }
        expect(subsGetLength(0)).toBe(255);
    });
});
