import { describe, it, expect, beforeEach } from 'vitest';
import { parse, isStaticNode, ASTNode } from '../compiler/parse';
import { ssa, Instruction } from '../compiler/ssa';
import { optimize } from '../compiler/optimize';
import { codegen, validateExpression } from '../compiler/codegen';

describe('compiler pipeline', () => {
    describe('SSA generation', () => {
        it('generates instructions from simple element', () => {
            const ast = parse('<div></div>');
            const instructions = ssa(ast);
            expect(instructions).toHaveLength(1);
            expect(instructions[0]!.op).toBe('create');
            expect(instructions[0]!.args[0]).toBe('div');
        });

        it('generates attr instructions for attributes', () => {
            const ast = parse('<div class="foo"></div>');
            const instructions = ssa(ast);
            expect(instructions).toHaveLength(2);
            expect(instructions[1]!.op).toBe('attr');
            expect(instructions[1]!.args[0]).toBe('class');
            expect(instructions[1]!.args[1]).toBe('foo');
        });

        it('generates event instructions for onclick', () => {
            const ast = parse('<button onclick="handleClick">Click</button>');
            const instructions = ssa(ast);
            const eventIns = instructions.find(i => i.op === 'event');
            expect(eventIns).toBeDefined();
            expect(eventIns!.args[0]).toBe('click');
        });

        it('generates text instructions', () => {
            const ast = parse('Hello');
            const instructions = ssa(ast);
            expect(instructions).toHaveLength(1);
            expect(instructions[0]!.op).toBe('text');
            expect(instructions[0]!.args[0]).toBe('Hello');
        });

        it('generates expr instructions for expressions', () => {
            const ast = parse('{name}');
            const instructions = ssa(ast);
            expect(instructions).toHaveLength(1);
            expect(instructions[0]!.op).toBe('expr');
            expect(instructions[0]!.args[0]).toBe('name');
        });

        it('generates each instructions', () => {
            const ast = parse('{#each items as item}<p>{item}</p>{/each}');
            const instructions = ssa(ast);
            expect(instructions).toHaveLength(1);
            expect(instructions[0]!.op).toBe('each');
            expect(instructions[0]!.nested).toBeDefined();
            expect(instructions[0]!.nested!.length).toBeGreaterThan(0);
        });

        it('generates if instructions', () => {
            const ast = parse('{#if show}<p>Visible</p>{/if}');
            const instructions = ssa(ast);
            expect(instructions).toHaveLength(1);
            expect(instructions[0]!.op).toBe('if');
            expect(instructions[0]!.nested).toBeDefined();
        });
    });

    describe('codegen', () => {
        it('generates valid JS from instructions', () => {
            const ast = parse('<div class="foo"><span>Hello</span></div>');
            const instructions = ssa(ast);
            const output = codegen(instructions);
            expect(output).toContain("import { effect } from '@dominator/core'");
            expect(output).toContain('document.createElement("div")');
            expect(output).toContain('document.createElement("span")');
            expect(output).toContain("return v");
        });

        it('generates effect calls for dynamic attributes', () => {
            const ast = parse('<div class="{myClass}"></div>');
            const instructions = ssa(ast);
            const output = codegen(instructions);
            expect(output).toContain('effect(() => {');
        });

        it('uses custom state import path', () => {
            const ast = parse('<div></div>');
            const instructions = ssa(ast);
            const output = codegen(instructions, { stateImportPath: './my-state' });
            expect(output).toContain("from './my-state'");
        });

        it('uses custom function name', () => {
            const ast = parse('<div></div>');
            const instructions = ssa(ast);
            const output = codegen(instructions, { functionName: 'myRender' });
            expect(output).toContain('export const myRender');
        });
    });

    describe('full pipeline', () => {
        it('compiles simple template to code', () => {
            const source = '<div class="app"><h1>{title}</h1><p>Hello World</p></div>';
            const ast = parse(source);
            const instructions = ssa(ast);
            const optimized = optimize(instructions);
            const output = codegen(optimized);
            expect(output).toContain('effect');
            expect(output).toContain('createElement');
        });

        it('compiles each block template', () => {
            const source = '{#each items as item}<div>{item}</div>{/each}';
            const ast = parse(source);
            const instructions = ssa(ast);
            const optimized = optimize(instructions);
            const output = codegen(optimized);
            expect(output).toContain('createDocumentFragment');
            expect(output).toContain('for (let');
        });

        it('compiles if block template', () => {
            const source = '{#if show}<p>Visible</p>{/if}';
            const ast = parse(source);
            const instructions = ssa(ast);
            const optimized = optimize(instructions);
            const output = codegen(optimized);
            expect(output).toContain('if (show)');
        });
    });
});

describe('validateExpression', () => {
    it('allows safe expressions', () => {
        expect(validateExpression('count + 1')).toBe(true);
        expect(validateExpression('item.name')).toBe(true);
        expect(validateExpression('isActive ? "yes" : "no"')).toBe(true);
    });

    it('blocks require()', () => {
        expect(validateExpression('require("fs")')).toBe(false);
    });

    it('blocks eval()', () => {
        expect(validateExpression('eval("alert(1)")')).toBe(false);
    });

    it('blocks Function constructor', () => {
        expect(validateExpression('Function("return this")()')).toBe(false);
    });

    it('blocks __proto__', () => {
        expect(validateExpression('obj.__proto__')).toBe(false);
    });

    it('blocks process access', () => {
        expect(validateExpression('process.exit()')).toBe(false);
    });

    it('blocks import()', () => {
        expect(validateExpression('import("fs")')).toBe(false);
    });
});
