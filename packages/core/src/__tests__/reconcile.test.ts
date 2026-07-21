import { describe, it, expect } from 'vitest';
import { reconcile, ReconcileItem } from '../reconcile';

interface TestData {
    id: string | number;
}

function createAnchor(): Comment {
    const anchor = document.createComment('anchor');
    document.body.appendChild(anchor);
    return anchor;
}

function cleanup(): void {
    document.body.innerHTML = '';
}

describe('reconcile', () => {
    it('renders new items from empty state', () => {
        const anchor = createAnchor();
        const data: TestData[] = [{ id: 1 }, { id: 2 }];
        const keyFn = (item: TestData) => item.id;
        const renderFn = (_item: TestData) => [document.createElement('div')];

        const result = reconcile(anchor, [], data, keyFn, renderFn);
        expect(result).toHaveLength(2);
        expect(result[0]!.key).toBe(1);
        expect(result[1]!.key).toBe(2);
        cleanup();
    });

    it('reuses existing items with matching keys', () => {
        const anchor = createAnchor();
        const oldItems: ReconcileItem<TestData>[] = [
            { key: 1, nodes: [document.createElement('div')] },
            { key: 2, nodes: [document.createElement('span')] },
        ];
        for (let i = 0; i < oldItems.length; i++) {
            for (let j = 0; j < oldItems[i]!.nodes.length; j++) {
                anchor.parentNode!.insertBefore(oldItems[i]!.nodes[j]!, anchor);
            }
        }

        const data: TestData[] = [{ id: 1 }, { id: 2 }];
        const keyFn = (item: TestData) => item.id;
        const renderFn = (_item: TestData) => [document.createElement('div')];

        const result = reconcile(anchor, oldItems, data, keyFn, renderFn);
        expect(result[0]!.nodes).toBe(oldItems[0]!.nodes);
        expect(result[1]!.nodes).toBe(oldItems[1]!.nodes);
        cleanup();
    });

    it('removes stale items from DOM', () => {
        const anchor = createAnchor();
        const staleDiv = document.createElement('div');
        anchor.parentNode!.insertBefore(staleDiv, anchor);
        const oldItems: ReconcileItem<TestData>[] = [{ key: 'stale', nodes: [staleDiv] }];

        const data: TestData[] = [{ id: 'new' }];
        const keyFn = (item: TestData) => item.id;
        const renderFn = (_item: TestData) => [document.createElement('span')];

        reconcile(anchor, oldItems, data, keyFn, renderFn);
        expect(staleDiv.parentNode).toBeNull();
        cleanup();
    });

    it('reorders items to match new data order', () => {
        const anchor = createAnchor();
        const div1 = document.createElement('div');
        div1.textContent = '1';
        const div2 = document.createElement('div');
        div2.textContent = '2';
        anchor.parentNode!.insertBefore(div1, anchor);
        anchor.parentNode!.insertBefore(div2, anchor);

        const oldItems: ReconcileItem<TestData>[] = [
            { key: 1, nodes: [div1] },
            { key: 2, nodes: [div2] },
        ];

        const data: TestData[] = [{ id: 2 }, { id: 1 }];
        const keyFn = (item: TestData) => item.id;
        const renderFn = (_item: TestData) => [document.createElement('div')];

        reconcile(anchor, oldItems, data, keyFn, renderFn);

        const parent = anchor.parentNode!;
        const childNodes: Node[] = [];
        for (let i = 0; i < parent.childNodes.length; i++) {
            const n = parent.childNodes[i]!;
            if (n !== anchor) childNodes.push(n);
        }
        expect(childNodes[0]).toBe(div2);
        expect(childNodes[1]).toBe(div1);
        cleanup();
    });

    it('handles empty data (clear all)', () => {
        const anchor = createAnchor();
        const div1 = document.createElement('div');
        anchor.parentNode!.insertBefore(div1, anchor);
        const oldItems: ReconcileItem<TestData>[] = [{ key: 1, nodes: [div1] }];

        reconcile(anchor, oldItems, [], (item) => item.id, () => [document.createElement('div')]);
        expect(div1.parentNode).toBeNull();
        cleanup();
    });

    it('handles multiple nodes per item', () => {
        const anchor = createAnchor();
        const data: TestData[] = [{ id: 1 }];
        const keyFn = (item: TestData) => item.id;
        const renderFn = (_item: TestData) => [
            document.createElement('span'),
            document.createElement('a'),
        ];

        const result = reconcile(anchor, [], data, keyFn, renderFn);
        expect(result[0]!.nodes).toHaveLength(2);
        cleanup();
    });
});
