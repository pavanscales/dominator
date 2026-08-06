import { describe, it, expect, beforeEach } from 'vitest';
import { optimize } from '../compiler/optimize';
import type { Instruction } from '../compiler/ssa';

describe('optimize', () => {
    describe('dead code elimination', () => {
        it('removes empty text nodes', () => {
            const input: Instruction[] = [
                { op: 'create', target: 'v0', args: ['div'] },
                { op: 'text', target: 'v1', args: [''] },
                { op: 'append', target: 'v0', args: ['v1'] },
            ];
            const result = optimize(input);
            expect(result).toHaveLength(1);
            expect(result[0]!.op).toBe('create');
        });

        it('keeps non-empty text nodes', () => {
            const input: Instruction[] = [
                { op: 'text', target: 'v0', args: ['hello'] },
            ];
            const result = optimize(input);
            expect(result).toHaveLength(1);
            expect(result[0]!.args[0]).toBe('hello');
        });
    });

    describe('constant folding', () => {
        it('folds numeric expressions in text', () => {
            const input: Instruction[] = [
                { op: 'expr', target: 'v0', args: ['42'] },
            ];
            const result = optimize(input);
            expect(result).toHaveLength(1);
            expect(result[0]!.op).toBe('text');
            expect(result[0]!.args[0]).toBe('42');
        });

        it('folds arithmetic expressions', () => {
            const input: Instruction[] = [
                { op: 'expr', target: 'v0', args: ['2 + 3'] },
            ];
            const result = optimize(input);
            expect(result).toHaveLength(1);
            expect(result[0]!.op).toBe('text');
            expect(result[0]!.args[0]).toBe('5');
        });

        it('folds string literals in attributes', () => {
            const input: Instruction[] = [
                { op: 'create', target: 'v0', args: ['div'] },
                { op: 'attr', target: 'v0', args: ['class', '"foo"'] },
            ];
            const result = optimize(input);
            expect(result[1]!.args[1]).toBe('"foo"');
        });

        it('folds boolean literals', () => {
            const input: Instruction[] = [
                { op: 'expr', target: 'v0', args: ['true'] },
            ];
            const result = optimize(input);
            expect(result[0]!.op).toBe('text');
            expect(result[0]!.args[0]).toBe('true');
        });

        it('does not fold dynamic expressions', () => {
            const input: Instruction[] = [
                { op: 'expr', target: 'v0', args: ['count + 1'] },
            ];
            const result = optimize(input);
            expect(result[0]!.op).toBe('expr');
            expect(result[0]!.args[0]).toBe('count + 1');
        });
    });

    describe('static text merging', () => {
        it('merges adjacent static text nodes', () => {
            const input: Instruction[] = [
                { op: 'create', target: 'v0', args: ['div'] },
                { op: 'text', target: 'v1', args: ['hello '] },
                { op: 'text', target: 'v2', args: ['world'] },
                { op: 'append', target: 'v0', args: ['v1'] },
                { op: 'append', target: 'v0', args: ['v2'] },
            ];
            const result = optimize(input);
            const textOps = result.filter((i: Instruction) => i.op === 'text');
            expect(textOps).toHaveLength(1);
            expect(textOps[0]!.args[0]).toBe('hello world');
        });
    });

    describe('nested optimization', () => {
        it('optimizes inside each blocks', () => {
            const input: Instruction[] = [
                { op: 'each', target: 'v0', args: ['items', 'item'], nested: [
                    { op: 'expr', target: 'v1', args: ['42'] },
                ] },
            ];
            const result = optimize(input);
            const nested = result[0]!.nested!;
            expect(nested[0]!.op).toBe('text');
            expect(nested[0]!.args[0]).toBe('42');
        });
    });
});
