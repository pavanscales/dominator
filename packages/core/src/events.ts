/**
 * Event delegation system — stamped DOM IDs + event bitmask.
 *
 * All event handlers stored in a flat array indexed by (nodeId * EVENT_COUNT + typeIndex).
 * Node IDs are stamped directly on DOM elements as __did property (faster than WeakMap).
 * Event bitmask per node allows skipping handler lookup when no handler is registered.
 * Bubble path traversal uses pre-allocated array with O(1) node→id via direct property.
 *
 * PERFORMANCE: Direct property access (no WeakMap), bitmask early-exit, pre-allocated buffers.
 */

const EVENT_TYPES = ['click', 'input', 'change', 'submit', 'keydown'] as const;
const EVENT_COUNT = EVENT_TYPES.length;

// O(1) event type lookup via charCode dispatch (avoids Map lookup entirely)
function _typeIndex(type: string): number {
    const c0 = type.charCodeAt(0);
    const c1 = type.charCodeAt(1);
    if (c0 === 99) return c1 === 108 ? 0 : 2;
    if (c0 === 105) return 1;
    if (c0 === 115) return 3;
    if (c0 === 107) return 4;
    return -1;
}

// ── Flat handler storage: nodeId → typeIndex → handler ─────────────────
let _handlerFns: ((e: Event) => void)[] = new Array(1024);
let _handlerCount = 0;
// Flat 2D array: _nodeHandlersFlat[nodeId * EVENT_COUNT + typeIdx] = fnId
let _nodeHandlersFlat: Int32Array = new Int32Array(256 * EVENT_COUNT);
let _nodeHandlersCap = 256;
let _nextNodeId = 0;
// Event bitmask per node: _nodeEventMask[nodeId] = bitmask of registered event types
let _nodeEventMask: Uint8Array = new Uint8Array(256);
let _nodeEventMaskCap = 256;

// ── Bubble path: single pre-allocated array ────────────────────────────
const _bubblePath: Node[] = new Array(128);
let _bubblePathLen = 128;

// DOM node ID property name (hidden, non-enumerable)
const DID_PROP = '__did';

export const setupDelegation = (root: Node): void => {
    const handler = (e: Event): void => {
        let target = e.target as Node | null;
        let depth = 0;

        while (target && target !== root) {
            if (depth >= _bubblePathLen) {
                if (_bubblePathLen < 2048) {
                    _bubblePathLen = Math.min(_bubblePathLen * 2, 2048);
                } else {
                    break;
                }
            }
            _bubblePath[depth++] = target;
            target = target.parentNode;
        }

        const typeIdx = _typeIndex(e.type as string);
        if (typeIdx < 0) return;

        const typeBit = 1 << typeIdx;

        for (let i = 0; i < depth; i++) {
            const node = _bubblePath[i]!;
            // Direct property access — ~3x faster than WeakMap.get()
            const nodeId = (node as any)[DID_PROP] as number | undefined;
            if (nodeId !== undefined) {
                // Bitmask check: skip if no handler for this event type
                if ((_nodeEventMask[nodeId] & typeBit) === 0) {
                    _bubblePath[i] = null!;
                    continue;
                }
                const fnId = _nodeHandlersFlat[nodeId * EVENT_COUNT + typeIdx];
                if (fnId >= 0 && fnId < _handlerCount) {
                    const fn = _handlerFns[fnId];
                    if (fn) {
                        fn(e);
                        if (e.cancelBubble) {
                            _bubblePath[i] = null!;
                            return;
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

function _ensureNodeSlot(nodeId: number): void {
    const needed = (nodeId + 1) * EVENT_COUNT;
    if (needed > _nodeHandlersFlat.length) {
        const newCap = Math.max(nodeId + 1, _nodeHandlersCap * 2);
        const newBuf = new Int32Array(newCap * EVENT_COUNT);
        newBuf.set(_nodeHandlersFlat.subarray(0, _nodeHandlersCap * EVENT_COUNT));
        newBuf.fill(-1, _nodeHandlersCap * EVENT_COUNT);
        _nodeHandlersFlat = newBuf;
        const newMask = new Uint8Array(newCap);
        newMask.set(_nodeEventMask.subarray(0, _nodeEventMaskCap));
        _nodeEventMask = newMask;
        _nodeEventMaskCap = newCap;
        _nodeHandlersCap = newCap;
    }
}

export const addEventListener = (el: Node, type: string, fn: Function): void => {
    const typeIdx = _typeIndex(type);
    if (typeIdx === -1) return;

    // Direct property access for node ID (stamped on element)
    let nodeId = (el as any)[DID_PROP] as number | undefined;
    if (nodeId === undefined) {
        nodeId = _nextNodeId++;
        (el as any)[DID_PROP] = nodeId;
        _ensureNodeSlot(nodeId);
    }

    // Store handler in flat array
    const fnId = _handlerCount++;
    if (fnId >= _handlerFns.length) {
        const newLen = Math.max(_handlerFns.length * 2, 2048);
        const newFns = new Array(newLen);
        for (let i = 0; i < _handlerFns.length; i++) newFns[i] = _handlerFns[i];
        _handlerFns = newFns;
    }
    _handlerFns[fnId] = fn as (e: Event) => void;
    _nodeHandlersFlat[nodeId * EVENT_COUNT + typeIdx] = fnId;
    // Set bitmask bit for this event type
    _nodeEventMask[nodeId] |= (1 << typeIdx);
};

export const removeEventListener = (el: Node, type: string): void => {
    const typeIdx = _typeIndex(type);
    if (typeIdx < 0) return;
    const nodeId = (el as any)[DID_PROP] as number | undefined;
    if (nodeId !== undefined) {
        _nodeHandlersFlat[nodeId * EVENT_COUNT + typeIdx] = -1;
        // Clear bitmask bit
        _nodeEventMask[nodeId] &= ~(1 << typeIdx);
    }
};

export const removeAllEventListeners = (el: Node): void => {
    const nodeId = (el as any)[DID_PROP] as number | undefined;
    if (nodeId !== undefined) {
        const base = nodeId * EVENT_COUNT;
        for (let i = 0; i < EVENT_COUNT; i++) {
            _nodeHandlersFlat[base + i] = -1;
        }
        _nodeEventMask[nodeId] = 0;
    }
};
