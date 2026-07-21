import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVNode } from '../vnode';

describe('createVNode', () => {
    it('creates a VNode with tag', () => {
        const v = createVNode('div');
        expect(v.tag).toBe('div');
        expect(v.props).toBeNull();
        expect(v.children).toBeNull();
        expect(v.key).toBeNull();
        expect(v.el).toBeNull();
    });

    it('creates a VNode with props', () => {
        const v = createVNode('div', { class: 'foo', id: 'bar' });
        expect(v.props).toEqual({ class: 'foo', id: 'bar' });
    });

    it('creates a VNode with children', () => {
        const child = createVNode('span');
        const v = createVNode('div', null, [child]);
        expect(v.children).toHaveLength(1);
        expect(v.children![0]).toBe(child);
    });

    it('creates a VNode with key', () => {
        const v = createVNode('div', null, null, 'item-1');
        expect(v.key).toBe('item-1');
    });

    it('creates a VNode with string children', () => {
        const v = createVNode('p', null, ['Hello World']);
        expect(v.children).toEqual(['Hello World']);
    });

    it('creates null tag VNode (fragment)', () => {
        const v = createVNode(null);
        expect(v.tag).toBeNull();
    });
});
