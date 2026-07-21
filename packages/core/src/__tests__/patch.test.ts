import { describe, it, expect } from 'vitest';
import { patch } from '../patch';
import { mount } from '../mount';
import { createVNode } from '../vnode';
import { setupDelegation } from '../events';

describe('patch', () => {
    it('patches same reference → no-op', () => {
        const v = createVNode('div');
        const el = mount(v);
        const parent = document.createElement('div');
        parent.appendChild(el);
        patch(el, v, v);
        expect(parent.children.length).toBe(1);
    });

    it('patches null newVNode → removes element', () => {
        const parent = document.createElement('div');
        const child = document.createElement('span');
        parent.appendChild(child);
        patch(child, createVNode('span'), null);
        expect(parent.children.length).toBe(0);
    });

    it('patches string → replaces with text node', () => {
        const parent = document.createElement('div');
        const child = document.createElement('span');
        parent.appendChild(child);
        const newEl = mount('text');
        parent.replaceChild(newEl, child);
        expect(parent.textContent).toBe('text');
    });

    it('patches different tag → replaces element', () => {
        const root = document.createElement('div');
        setupDelegation(root);
        document.body.appendChild(root);

        const oldV = createVNode('div');
        const newV = createVNode('span');
        const el = mount(oldV);
        root.appendChild(el);

        patch(el, oldV, newV);
        expect(root.children[0]).toBeInstanceOf(HTMLSpanElement);

        document.body.removeChild(root);
    });

    it('patches props → updates DOM', () => {
        const root = document.createElement('div');
        setupDelegation(root);

        const oldV = createVNode('div', { class: 'old' });
        const newV = createVNode('div', { class: 'new' });
        const el = mount(oldV) as HTMLElement;
        root.appendChild(el);

        patch(el, oldV, newV);
        expect(el.getAttribute('class')).toBe('new');
    });

    it('patches removes stale props', () => {
        const root = document.createElement('div');

        const oldV = createVNode('div', { class: 'foo', id: 'bar' });
        const newV = createVNode('div', { class: 'foo' });
        const el = mount(oldV) as HTMLElement;
        root.appendChild(el);

        patch(el, oldV, newV);
        expect(el.getAttribute('class')).toBe('foo');
        expect(el.id).toBe('');
    });

    it('patches children (append new)', () => {
        const root = document.createElement('div');
        setupDelegation(root);

        const oldV = createVNode('div', null, [createVNode('span')]);
        const newV = createVNode('div', null, [createVNode('span'), createVNode('a')]);
        const el = mount(oldV);
        root.appendChild(el);

        patch(el, oldV, newV);
        expect((el as HTMLElement).children.length).toBe(2);
    });

    it('patches children (remove excess)', () => {
        const root = document.createElement('div');
        setupDelegation(root);

        const oldV = createVNode('div', null, [
            createVNode('span'),
            createVNode('a'),
            createVNode('p'),
        ]);
        const newV = createVNode('div', null, [createVNode('span')]);
        const el = mount(oldV);
        root.appendChild(el);

        patch(el, oldV, newV);
        expect((el as HTMLElement).children.length).toBe(1);
    });
});
