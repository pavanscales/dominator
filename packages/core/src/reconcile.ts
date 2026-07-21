export interface ReconcileItem<T = unknown> {
    key: string | number;
    nodes: Node[];
    data?: T;
}

let _oldMap = new Map<string | number, ReconcileItem>();

export const reconcile = <T>(
    anchor: Comment,
    oldItems: ReconcileItem<T>[],
    newData: T[],
    keyFn: (item: T) => string | number,
    renderFn: (item: T) => Node[]
): ReconcileItem<T>[] => {
    _oldMap.clear();
    for (let i = 0; i < oldItems.length; i++) {
        _oldMap.set(oldItems[i].key, oldItems[i] as ReconcileItem);
    }

    const newItems: ReconcileItem<T>[] = new Array(newData.length);
    const parent = anchor.parentNode!;
    const nextSibling = anchor.nextSibling;

    for (let i = 0; i < newData.length; i++) {
        const key = keyFn(newData[i]!);
        const existing = _oldMap.get(key);
        if (existing) {
            _oldMap.delete(key);
            newItems[i] = existing as ReconcileItem<T>;
        } else {
            newItems[i] = { key, nodes: renderFn(newData[i]!), data: newData[i]! };
        }
    }

    const removed = Array.from(_oldMap.values());
    for (let i = 0; i < removed.length; i++) {
        const item = removed[i]!;
        for (let j = 0; j < item.nodes.length; j++) {
            item.nodes[j]!.parentNode?.removeChild(item.nodes[j]!);
        }
    }
    _oldMap.clear();

    let insertBefore = nextSibling;
    for (let i = 0; i < newItems.length; i++) {
        const item = newItems[i]!;
        const nodes = item.nodes;
        for (let j = 0; j < nodes.length; j++) {
            const node = nodes[j]!;
            if (node.parentNode !== parent || node.nextSibling !== insertBefore) {
                parent.insertBefore(node, insertBefore);
            }
        }
        if (nodes.length > 0) {
            insertBefore = nodes[nodes.length - 1]!.nextSibling;
        }
    }

    return newItems;
};
