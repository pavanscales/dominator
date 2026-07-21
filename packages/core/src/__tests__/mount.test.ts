import { describe, it, expect } from 'vitest';
import { mount } from '../mount';
import { createVNode } from '../vnode';

describe('mount', () => {
    it('mounts a string as text node', () => {
        const node = mount('Hello');
        expect(node).toBeInstanceOf(Text);
        expect(node.textContent).toBe('Hello');
    });

    it('mounts a simple element', () => {
        const vnode = createVNode('div');
        const el = mount(vnode);
        expect(el).toBeInstanceOf(HTMLDivElement);
        expect(vnode.el).toBe(el);
    });

    it('mounts element with props', () => {
        const vnode = createVNode('div', { class: 'foo', id: 'bar' });
        const el = mount(vnode) as HTMLElement;
        expect(el.getAttribute('class')).toBe('foo');
        expect(el.id).toBe('bar');
    });

    it('mounts element with children', () => {
        const child = createVNode('span');
        const parent = createVNode('div', null, [child]);
        const el = mount(parent) as HTMLElement;
        expect(el.children.length).toBe(1);
        expect(el.children[0]).toBeInstanceOf(HTMLSpanElement);
    });

    it('mounts mixed string and VNode children', () => {
        const parent = createVNode('div', null, ['Hello', createVNode('span')]);
        const el = mount(parent) as HTMLElement;
        expect(el.childNodes.length).toBe(2);
        expect(el.childNodes[0]).toBeInstanceOf(Text);
        expect(el.childNodes[1]).toBeInstanceOf(HTMLSpanElement);
    });

    it('mounts nested elements', () => {
        const tree = createVNode('div', null, [
            createVNode('ul', null, [
                createVNode('li', null, ['Item 1']),
                createVNode('li', null, ['Item 2']),
            ]),
        ]);
        const el = mount(tree) as HTMLElement;
        expect(el.children[0].children.length).toBe(2);
    });
});
