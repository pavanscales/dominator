import { describe, it, expect } from 'vitest';
import { parse, isStaticNode } from '../compiler/parse';

describe('parse', () => {
    it('parses a simple div element', () => {
        const ast = parse('<div></div>');
        expect(ast.type).toBe('Program');
        expect(ast.children).toHaveLength(1);
        expect(ast.children![0]!.type).toBe('Element');
        expect(ast.children![0]!.tag).toBe('div');
    });

    it('parses element with attributes', () => {
        const ast = parse('<div class="foo" id="bar"></div>');
        const el = ast.children![0]!;
        expect(el.type).toBe('Element');
        expect(el.attributes).toEqual({ class: 'foo', id: 'bar' });
    });

    it('parses self-closing tags', () => {
        const ast = parse('<br />');
        const el = ast.children![0]!;
        expect(el.type).toBe('Element');
        expect(el.tag).toBe('br');
        expect(el.children).toEqual([]);
    });

    it('parses text nodes', () => {
        const ast = parse('Hello World');
        expect(ast.children).toHaveLength(1);
        expect(ast.children![0]!.type).toBe('Text');
        expect(ast.children![0]!.value).toBe('Hello World');
    });

    it('parses expressions', () => {
        const ast = parse('{name}');
        expect(ast.children).toHaveLength(1);
        expect(ast.children![0]!.type).toBe('Expression');
        expect(ast.children![0]!.expression).toBe('name');
    });

    it('parses nested elements', () => {
        const ast = parse('<div><span>Hello</span></div>');
        const div = ast.children![0]!;
        expect(div.type).toBe('Element');
        expect(div.children).toHaveLength(1);
        expect(div.children![0]!.tag).toBe('span');
    });

    it('parses each blocks', () => {
        const ast = parse('{#each items as item}<p>{item}</p>{/each}');
        const eachNode = ast.children![0]!;
        expect(eachNode.type).toBe('Each');
        expect(eachNode.expression).toBe('items');
        expect(eachNode.context).toBe('item');
        expect(eachNode.children).toHaveLength(1);
    });

    it('parses if blocks', () => {
        const ast = parse('{#if show}<p>Visible</p>{/if}');
        const ifNode = ast.children![0]!;
        expect(ifNode.type).toBe('If');
        expect(ifNode.expression).toBe('show');
    });

    it('parses if/else blocks', () => {
        const ast = parse('{#if show}<p>Yes</p>{:else}<p>No</p>{/if}');
        const ifNode = ast.children![0]!;
        expect(ifNode.type).toBe('If');
        expect(ifNode.else).toBeDefined();
        expect(ifNode.else!.type).toBe('Else');
    });

    it('parses dynamic attributes', () => {
        const ast = parse('<div class="{myClass}"></div>');
        const el = ast.children![0]!;
        expect(el.attributes!['class']).toBe('{myClass}');
    });

    it('parses component tags', () => {
        const ast = parse('<MyComponent />');
        const el = ast.children![0]!;
        expect(el.type).toBe('Component');
        expect(el.tag).toBe('MyComponent');
    });

    it('parses event handlers', () => {
        const ast = parse('<button onclick="handleClick">Click</button>');
        const el = ast.children![0]!;
        expect(el.attributes!['onclick']).toBe('handleClick');
    });

    it('parses boolean attributes', () => {
        const ast = parse('<input disabled />');
        const el = ast.children![0]!;
        expect(el.attributes!['disabled']).toBe(true);
    });

    it('parses complex templates', () => {
        const template = `
            <div class="app">
                <h1>{title}</h1>
                {#each items as item}
                    <div class="item">{item.name}</div>
                {/each}
            </div>
        `;
        const ast = parse(template);
        expect(ast.type).toBe('Program');
        expect(ast.children!.length).toBeGreaterThanOrEqual(1);
    });
});

describe('isStaticNode', () => {
    it('returns true for text nodes', () => {
        expect(isStaticNode({ type: 'Text', value: 'hello' })).toBe(true);
    });

    it('returns false for expressions', () => {
        expect(isStaticNode({ type: 'Expression', expression: 'name' })).toBe(false);
    });

    it('returns false for each blocks', () => {
        expect(isStaticNode({ type: 'Each', expression: 'items', context: 'item', children: [] })).toBe(false);
    });

    it('returns false for if blocks', () => {
        expect(isStaticNode({ type: 'If', expression: 'show', children: [] })).toBe(false);
    });

    it('returns true for static elements', () => {
        expect(isStaticNode({
            type: 'Element',
            tag: 'div',
            attributes: { class: 'foo' },
            children: [{ type: 'Text', value: 'hello' }],
        })).toBe(true);
    });

    it('returns false for elements with dynamic attributes', () => {
        expect(isStaticNode({
            type: 'Element',
            tag: 'div',
            attributes: { class: '{myClass}' },
            children: [],
        })).toBe(false);
    });

    it('returns false for elements with dynamic children', () => {
        expect(isStaticNode({
            type: 'Element',
            tag: 'div',
            attributes: {},
            children: [{ type: 'Expression', expression: 'name' }],
        })).toBe(false);
    });
});
