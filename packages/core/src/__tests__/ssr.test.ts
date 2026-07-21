import { describe, it, expect } from 'vitest';
import { renderToString, SSRInstruction } from '../ssr';

describe('renderToString', () => {
    it('renders empty for no instructions', () => {
        expect(renderToString([])).toBe('');
    });

    it('renders a single element', () => {
        const instructions: SSRInstruction[] = [
            { type: 'create', id: 'v0', tag: 'div' },
        ];
        expect(renderToString(instructions)).toBe('<div></div>');
    });

    it('renders element with attributes', () => {
        const instructions: SSRInstruction[] = [
            { type: 'create', id: 'v0', tag: 'div' },
            { type: 'attr', id: 'v0', target: 'v0', name: 'class', value: 'container' },
        ];
        expect(renderToString(instructions)).toBe('<div class="container"></div>');
    });

    it('renders text node', () => {
        const instructions: SSRInstruction[] = [
            { type: 'create', id: 'v0', tag: 'div' },
            { type: 'text', id: 'v1', value: 'Hello' },
            { type: 'append', id: 'v1', parent: 'v0' },
        ];
        expect(renderToString(instructions)).toBe('<div>Hello</div>');
    });

    it('renders nested elements', () => {
        const instructions: SSRInstruction[] = [
            { type: 'create', id: 'v0', tag: 'div' },
            { type: 'create', id: 'v1', tag: 'span' },
            { type: 'text', id: 'v2', value: 'World' },
            { type: 'append', id: 'v2', parent: 'v1' },
            { type: 'append', id: 'v1', parent: 'v0' },
        ];
        expect(renderToString(instructions)).toBe('<div><span>World</span></div>');
    });

    it('renders multiple attributes', () => {
        const instructions: SSRInstruction[] = [
            { type: 'create', id: 'v0', tag: 'input' },
            { type: 'attr', id: 'v0', target: 'v0', name: 'type', value: 'text' },
            { type: 'attr', id: 'v0', target: 'v0', name: 'value', value: 'hello' },
        ];
        expect(renderToString(instructions)).toBe('<input type="text" value="hello"></input>');
    });

    it('renders complex tree', () => {
        const instructions: SSRInstruction[] = [
            { type: 'create', id: 'v0', tag: 'div' },
            { type: 'attr', id: 'v0', target: 'v0', name: 'class', value: 'app' },
            { type: 'create', id: 'v1', tag: 'h1' },
            { type: 'text', id: 'v2', value: 'Title' },
            { type: 'append', id: 'v2', parent: 'v1' },
            { type: 'append', id: 'v1', parent: 'v0' },
            { type: 'create', id: 'v3', tag: 'p' },
            { type: 'text', id: 'v4', value: 'Body' },
            { type: 'append', id: 'v4', parent: 'v3' },
            { type: 'append', id: 'v3', parent: 'v0' },
        ];
        expect(renderToString(instructions)).toBe(
            '<div class="app"><h1>Title</h1><p>Body</p></div>'
        );
    });

    it('handles missing parent gracefully', () => {
        const instructions: SSRInstruction[] = [
            { type: 'create', id: 'v0', tag: 'div' },
            { type: 'append', id: 'v1', parent: 'v0' }, // v1 doesn't exist
        ];
        expect(renderToString(instructions)).toBe('<div></div>');
    });

    it('handles root ID determination correctly', () => {
        const instructions: SSRInstruction[] = [
            { type: 'create', id: 'v0', tag: 'div' },
            { type: 'create', id: 'v1', tag: 'span' },
        ];
        // v0 is first create, should be root
        expect(renderToString(instructions)).toBe('<div></div>');
    });
});
