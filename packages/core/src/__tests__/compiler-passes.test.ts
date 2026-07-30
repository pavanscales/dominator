import { describe, it, expect } from 'vitest';
import { reorderInstructions } from '../compiler/reorder';
import { hoistEffects, isHoisted } from '../compiler/hoist';
import type { Instruction } from '../compiler/ssa';

describe('reorderInstructions', () => {
    it('groups creates first', () => {
        const input: Instruction[] = [
            { op: 'append', target: 'v0', args: ['v1'] },
            { op: 'create', target: 'v0', args: ['div'] },
            { op: 'create', target: 'v1', args: ['span'] },
        ];
        const result = reorderInstructions(input);
        expect(result[0]!.op).toBe('create');
        expect(result[1]!.op).toBe('create');
        expect(result[2]!.op).toBe('append');
    });

    it('puts static attrs before events before dynamic exprs', () => {
        const input: Instruction[] = [
            { op: 'expr', target: 'v2', args: ['x'] },
            { op: 'event', target: 'v0', args: ['click', 'handler'] },
            { op: 'attr', target: 'v0', args: ['class', 'foo'] },
            { op: 'create', target: 'v0', args: ['div'] },
            { op: 'append', target: 'parent', args: ['v0'] },
        ];
        const result = reorderInstructions(input);
        const ops = result.map(i => i.op);
        expect(ops).toEqual(['create', 'attr', 'event', 'append', 'expr']);
    });

    it('preserves relative order within groups', () => {
        const input: Instruction[] = [
            { op: 'create', target: 'v1', args: ['span'] },
            { op: 'create', target: 'v0', args: ['div'] },
        ];
        const result = reorderInstructions(input);
        expect(result[0]!.target).toBe('v1');
        expect(result[1]!.target).toBe('v0');
    });

    it('reorders nested each blocks recursively', () => {
        const inner: Instruction[] = [
            { op: 'append', target: 'v2', args: ['v3'] },
            { op: 'create', target: 'v2', args: ['li'] },
        ];
        const input: Instruction[] = [
            { op: 'each', target: 'v0', args: ['items', 'item'], nested: inner },
        ];
        const result = reorderInstructions(input);
        const nested = result[0]!.nested!;
        expect(nested[0]!.op).toBe('create');
        expect(nested[1]!.op).toBe('append');
    });
});

describe('hoistEffects', () => {
    it('merges adjacent dynamic effects on same target', () => {
        const input: Instruction[] = [
            { op: 'expr', target: 'v0', args: ['x'] },
            { op: 'expr', target: 'v0', args: ['y'] },
        ];
        const result = hoistEffects(input);
        expect(result.length).toBe(1);
        expect(isHoisted(result[0]!)).toBe(true);
        expect(result[0]!.nested!.length).toBe(2);
    });

    it('does not merge effects on different targets', () => {
        const input: Instruction[] = [
            { op: 'expr', target: 'v0', args: ['x'] },
            { op: 'expr', target: 'v1', args: ['y'] },
        ];
        const result = hoistEffects(input);
        expect(result.length).toBe(2);
        expect(isHoisted(result[0]!)).toBe(false);
        expect(isHoisted(result[1]!)).toBe(false);
    });

    it('does not merge static attrs with dynamic exprs', () => {
        const input: Instruction[] = [
            { op: 'attr', target: 'v0', args: ['class', 'static'] },
            { op: 'expr', target: 'v0', args: ['x'] },
        ];
        const result = hoistEffects(input);
        expect(result.length).toBe(2);
    });

    it('merges dynamic attr with dynamic expr on same target', () => {
        const input: Instruction[] = [
            { op: 'attr', target: 'v0', args: ['class', '{cls}'] },
            { op: 'expr', target: 'v0', args: ['x'] },
        ];
        const result = hoistEffects(input);
        expect(result.length).toBe(1);
        expect(isHoisted(result[0]!)).toBe(true);
    });

    it('does not merge events into hoisted groups', () => {
        const input: Instruction[] = [
            { op: 'expr', target: 'v0', args: ['x'] },
            { op: 'event', target: 'v0', args: ['click', 'handler'] },
            { op: 'expr', target: 'v0', args: ['y'] },
        ];
        const result = hoistEffects(input);
        expect(result.length).toBe(3);
    });

    it('handles empty input', () => {
        const result = hoistEffects([]);
        expect(result.length).toBe(0);
    });

    it('hoists groups of 3+ effects', () => {
        const input: Instruction[] = [
            { op: 'expr', target: 'v0', args: ['a'] },
            { op: 'expr', target: 'v0', args: ['b'] },
            { op: 'expr', target: 'v0', args: ['c'] },
            { op: 'expr', target: 'v0', args: ['d'] },
        ];
        const result = hoistEffects(input);
        expect(result.length).toBe(1);
        expect(result[0]!.nested!.length).toBe(4);
    });
});
