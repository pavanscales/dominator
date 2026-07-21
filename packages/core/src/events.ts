const EVENT_TYPES = ['click', 'input', 'change', 'submit', 'keydown'] as const;
const EVENT_COUNT = EVENT_TYPES.length;

// ── Flat handler storage: nodeId → typeIndex → handler ─────────────────
// Using two-level arrays instead of nested Maps for cache-line access
let _handlerFns: ((e: Event) => void)[] = new Array(256);
let _handlerCount = 0;
const _nodeIds = new WeakMap<Node, number>();
const _nodeHandlers: number[][] = [];
let _nextNodeId = 0;

// ── Bubble path: single pre-allocated array ────────────────────────────
let _bubblePath: Node[] = new Array(128);
let _bubblePathLen = 128;

export const setupDelegation = (root: Node): void => {
    const handler = (e: Event): void => {
        let target = e.target as Node | null;
        let depth = 0;

        while (target && target !== root) {
            if (depth >= _bubblePathLen) {
                if (_bubblePathLen < 2048) {
                    const newSize = Math.min(_bubblePathLen * 2, 2048);
                    const expanded = new Array(newSize);
                    for (let i = 0; i < depth; i++) expanded[i] = _bubblePath[i];
                    _bubblePath = expanded;
                    _bubblePathLen = newSize;
                } else {
                    break;
                }
            }
            _bubblePath[depth++] = target;
            target = target.parentNode;
        }

        for (let i = 0; i < depth; i++) {
            const nodeId = _nodeIds.get(_bubblePath[i]!);
            if (nodeId !== undefined) {
                const handlerIndices = _nodeHandlers[nodeId];
                if (handlerIndices) {
                    const typeIdx = EVENT_TYPES.indexOf(e.type as typeof EVENT_TYPES[number]);
                    if (typeIdx >= 0 && typeIdx < handlerIndices.length) {
                        const fnId = handlerIndices[typeIdx];
                        if (fnId >= 0 && fnId < _handlerCount) {
                            const fn = _handlerFns[fnId];
                            if (fn) {
                                fn(e);
                                if (e.cancelBubble) return;
                            }
                        }
                    }
                }
            }
            _bubblePath[i] = null!;
        }
    };

    for (let i = 0; i < EVENT_COUNT; i++) {
        root.addEventListener(EVENT_TYPES[i], handler);
    }
};

export const addEventListener = (el: Node, type: string, fn: Function): void => {
    let nodeId = _nodeIds.get(el);
    if (nodeId === undefined) {
        nodeId = _nextNodeId++;
        _nodeIds.set(el, nodeId);
        // Ensure handler arrays are big enough
        while (nodeId >= _nodeHandlers.length) {
            _nodeHandlers.push([-1, -1, -1, -1, -1]);
        }
    }

    const typeIdx = EVENT_TYPES.indexOf(type as typeof EVENT_TYPES[number]);
    if (typeIdx === -1) return;

    // Store handler in flat array
    const fnId = _handlerCount++;
    if (fnId >= _handlerFns.length) {
        const newSize = Math.max(_handlerFns.length * 2, 512);
        const newFns = new Array(newSize);
        for (let i = 0; i < _handlerFns.length; i++) newFns[i] = _handlerFns[i];
        _handlerFns = newFns;
    }
    _handlerFns[fnId] = fn as (e: Event) => void;
    _nodeHandlers[nodeId][typeIdx] = fnId;
};

export const removeEventListener = (el: Node, type: string): void => {
    const nodeId = _nodeIds.get(el);
    if (nodeId !== undefined) {
        const typeIdx = EVENT_TYPES.indexOf(type as typeof EVENT_TYPES[number]);
        if (typeIdx >= 0 && _nodeHandlers[nodeId]) {
            _nodeHandlers[nodeId][typeIdx] = -1;
        }
    }
};

export const removeAllEventListeners = (el: Node): void => {
    const nodeId = _nodeIds.get(el);
    if (nodeId !== undefined && _nodeHandlers[nodeId]) {
        const arr = _nodeHandlers[nodeId];
        for (let i = 0; i < arr.length; i++) arr[i] = -1;
    }
};
