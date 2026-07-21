import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDelegation, addEventListener } from '../events';

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('Event Delegation', () => {
    it('setupDelegation creates a delegation root', () => {
        const root = document.createElement('div');
        setupDelegation(root);
        // No error thrown = success
        expect(root).toBeDefined();
    });

    it('delegates click events from child to handler', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        setupDelegation(root);

        const child = document.createElement('button');
        root.appendChild(child);

        const handler = vi.fn();
        addEventListener(child, 'click', handler);

        child.click();
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(expect.any(Event));
    });

    it('stops propagation when cancelBubble is set', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        setupDelegation(root);

        const child = document.createElement('span');
        const grandchild = document.createElement('a');
        child.appendChild(grandchild);
        root.appendChild(child);

        const childHandler = vi.fn((e: Event) => {
            e.stopPropagation();
        });
        const grandchildHandler = vi.fn();

        addEventListener(child, 'click', childHandler);
        addEventListener(grandchild, 'click', grandchildHandler);

        grandchild.click();
        expect(grandchildHandler).toHaveBeenCalledOnce();
        expect(childHandler).toHaveBeenCalledOnce();
    });

    it('supports multiple event types', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        setupDelegation(root);

        const input = document.createElement('input');
        root.appendChild(input);

        const clickHandler = vi.fn();
        const inputHandler = vi.fn();

        addEventListener(input, 'click', clickHandler);
        addEventListener(input, 'input', inputHandler);

        input.click();
        expect(clickHandler).toHaveBeenCalledOnce();

        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(inputHandler).toHaveBeenCalledOnce();
    });

    it('overwrites handler on same event type', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        setupDelegation(root);

        const child = document.createElement('div');
        root.appendChild(child);

        const handler1 = vi.fn();
        const handler2 = vi.fn();

        addEventListener(child, 'click', handler1);
        addEventListener(child, 'click', handler2);

        child.click();
        expect(handler1).not.toHaveBeenCalled();
        expect(handler2).toHaveBeenCalledOnce();
    });

    it('handles deep nesting', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        setupDelegation(root);

        const level1 = document.createElement('div');
        const level2 = document.createElement('div');
        const level3 = document.createElement('button');
        level2.appendChild(level3);
        level1.appendChild(level2);
        root.appendChild(level1);

        const handler = vi.fn();
        addEventListener(level3, 'click', handler);

        level3.click();
        expect(handler).toHaveBeenCalledOnce();
    });
});
