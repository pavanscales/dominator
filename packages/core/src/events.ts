/**
 * Event delegation system — stamped DOM IDs + event bitmask.
 *
 * All event handlers stored in a flat array indexed by (nodeId * EVENT_COUNT + typeIndex).
 * Node IDs are stamped directly on DOM elements as __did property (faster than WeakMap).
 * Event bitmask per node allows skipping handler lookup when no handler is registered.
 * Bubble path traversal uses pre-allocated array with O(1) node→id via direct property.
 *
 * Multiple delegation roots are supported: each call to setupDelegation(root) attaches
 * listeners to that root only. teardownDelegation(root?) removes them.
 *
 * PERFORMANCE: Direct property access (no WeakMap), bitmask early-exit, pre-allocated buffers.
 */

interface EventTypeDef {
    type: string;
    capture: boolean;
}

// Bubbling events use the default bubble phase. Non-bubbling events (focus, blur,
// scroll, mouseenter/leave, pointerenter/leave) must be captured at the root so the
// handler still sees every descendant target.
const EVENT_TYPES: EventTypeDef[] = [
    { type: 'click', capture: false },
    { type: 'dblclick', capture: false },
    { type: 'mousedown', capture: false },
    { type: 'mouseup', capture: false },
    { type: 'mousemove', capture: false },
    { type: 'mouseover', capture: false },
    { type: 'mouseout', capture: false },
    { type: 'mouseenter', capture: true },
    { type: 'mouseleave', capture: true },
    { type: 'wheel', capture: false },
    { type: 'scroll', capture: true },
    { type: 'keydown', capture: false },
    { type: 'keyup', capture: false },
    { type: 'input', capture: false },
    { type: 'change', capture: false },
    { type: 'submit', capture: false },
    { type: 'focus', capture: true },
    { type: 'blur', capture: true },
    { type: 'contextmenu', capture: false },
    { type: 'touchstart', capture: false },
    { type: 'touchmove', capture: false },
    { type: 'touchend', capture: false },
    { type: 'dragstart', capture: false },
    { type: 'drag', capture: false },
    { type: 'dragend', capture: false },
    { type: 'dragover', capture: false },
    { type: 'drop', capture: false },
    { type: 'copy', capture: false },
    { type: 'cut', capture: false },
    { type: 'paste', capture: false },
    { type: 'focusin', capture: false },
    { type: 'focusout', capture: false },
    { type: 'pointerdown', capture: false },
    { type: 'pointerup', capture: false },
    { type: 'pointermove', capture: false },
    { type: 'pointerenter', capture: true },
    { type: 'pointerleave', capture: true },
    { type: 'transitionend', capture: false },
    { type: 'animationend', capture: false },
] as const;

const EVENT_COUNT = EVENT_TYPES.length;

// O(1) event type lookup via map
const _TYPE_INDEX: Record<string, number> = {};
for (let i = 0; i < EVENT_COUNT; i++) _TYPE_INDEX[EVENT_TYPES[i]!.type] = i;

function _typeIndex(type: string): number {
    const idx = _TYPE_INDEX[type];
    if (idx !== undefined) return idx;
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        console.warn(`[dominator] Unsupported event type: "${type}"`);
    }
    return -1;
}

// ── Flat handler storage: nodeId → typeIndex → handler ─────────────────
let _handlerFns: ((e: Event) => void)[] = new Array(1024);
let _handlerCount = 0;
let _freeFnIds: number[] = [];
// Flat 2D array: _nodeHandlersFlat[nodeId * EVENT_COUNT + typeIdx] = fnId
let _nodeHandlersFlat: Int32Array = new Int32Array(256 * EVENT_COUNT);
let _nodeHandlersCap = 256;
let _nextNodeId = 0;
// Event bitmask per node: _nodeEventMask[nodeId] = bitmask of registered event types
// Uint32Array so masks support up to 32 event types.
let _nodeEventMask: Uint32Array = new Uint32Array(256);
let _nodeEventMaskCap = 256;

// ── Bubble path: per-call scratch buffer ─────────────────────
// Each event handler call gets its own path buffer from a pool,
// eliminating the shared mutable state race condition.
const MAX_BUBBLE_DEPTH = 128;
const _bubblePathPool: Node[][] = [];
let _bubblePathPoolIdx = 0;

function _acquireBubblePath(): Node[] {
    if (_bubblePathPoolIdx >= _bubblePathPool.length) {
        _bubblePathPool.push(new Array(MAX_BUBBLE_DEPTH));
    }
    return _bubblePathPool[_bubblePathPoolIdx++]!;
}

function _resetBubblePaths(): void {
    _bubblePathPoolIdx = 0;
}

// DOM node ID property name (hidden, non-enumerable)
const DID_PROP = '__did';

// Per-root delegation: root → cleanup
const _delegationCleanups = new Map<Node, () => void>();

export const setupDelegation = (root: Node): void => {
    if (_delegationCleanups.has(root)) return;

    const handler = (e: Event): void => {
        const path = _acquireBubblePath();
        try {
            let target = e.target as Node | null;
            let depth = 0;

            while (target && target !== root) {
                if (depth >= MAX_BUBBLE_DEPTH) {
                    break;
                }
                path[depth++] = target;
                target = target.parentNode;
            }

            const typeIdx = _typeIndex(e.type as string);
            if (typeIdx < 0) {
                return;
            }

            const typeBit = 1 << typeIdx;

            for (let i = 0; i < depth; i++) {
                const node = path[i]!;
                // Direct property access — ~3x faster than WeakMap.get()
                const nodeId = (node as any)[DID_PROP] as number | undefined;
                if (nodeId !== undefined) {
                    // Bitmask check: skip if no handler for this event type
                    if ((_nodeEventMask[nodeId] & typeBit) === 0) {
                        path[i] = null!;
                        continue;
                    }
                    const fnId = _nodeHandlersFlat[nodeId * EVENT_COUNT + typeIdx];
                    if (fnId >= 0 && fnId < _handlerCount) {
                        const fn = _handlerFns[fnId];
                        if (fn) {
                            fn(e);
                            if (e.cancelBubble) {
                                return;
                            }
                        }
                    }
                }
                path[i] = null!;
            }
        } finally {
            // Always release the pooled path, even if a handler threw — otherwise
            // the pool leaks a 128-slot array per throw and grows unboundedly.
            _resetBubblePaths();
        }
    };

    const cleanupFns: (() => void)[] = [];
    for (let i = 0; i < EVENT_COUNT; i++) {
        root.addEventListener(EVENT_TYPES[i]!.type, handler, EVENT_TYPES[i]!.capture);
        cleanupFns.push(() => root.removeEventListener(EVENT_TYPES[i]!.type, handler, EVENT_TYPES[i]!.capture));
    }
    _delegationCleanups.set(root, () => {
        for (const fn of cleanupFns) fn();
        _delegationCleanups.delete(root);
    });
};

function _ensureNodeSlot(nodeId: number): void {
    const needed = (nodeId + 1) * EVENT_COUNT;
    if (needed > _nodeHandlersFlat.length) {
        const newCap = Math.max(nodeId + 1, _nodeHandlersCap * 2);
        const newBuf = new Int32Array(newCap * EVENT_COUNT);
        newBuf.set(_nodeHandlersFlat.subarray(0, _nodeHandlersCap * EVENT_COUNT));
        newBuf.fill(-1, _nodeHandlersCap * EVENT_COUNT);
        _nodeHandlersFlat = newBuf;
        const newMask = new Uint32Array(newCap);
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

    // Store handler in flat array — recycle free slot if available
    let fnId: number;
    if (_freeFnIds.length > 0) {
        fnId = _freeFnIds.pop()!;
    } else {
        fnId = _handlerCount++;
        if (fnId >= _handlerFns.length) {
            const newLen = Math.max(_handlerFns.length * 2, 2048);
            const newFns = new Array(newLen);
            for (let i = 0; i < _handlerFns.length; i++) newFns[i] = _handlerFns[i];
            _handlerFns = newFns;
        }
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
        const fnId = _nodeHandlersFlat[nodeId * EVENT_COUNT + typeIdx];
        _nodeHandlersFlat[nodeId * EVENT_COUNT + typeIdx] = -1;
        // Clear handler reference to prevent memory leak
        if (fnId >= 0 && fnId < _handlerFns.length) {
            _handlerFns[fnId] = undefined!;
            _freeFnIds.push(fnId);
        }
        // Clear bitmask bit
        _nodeEventMask[nodeId] &= ~(1 << typeIdx);
    }
};

export const removeAllEventListeners = (el: Node): void => {
    const nodeId = (el as any)[DID_PROP] as number | undefined;
    if (nodeId !== undefined) {
        const base = nodeId * EVENT_COUNT;
        for (let i = 0; i < EVENT_COUNT; i++) {
            const fnId = _nodeHandlersFlat[base + i];
            _nodeHandlersFlat[base + i] = -1;
            if (fnId >= 0 && fnId < _handlerFns.length) {
                _handlerFns[fnId] = undefined!;
                _freeFnIds.push(fnId);
            }
        }
        _nodeEventMask[nodeId] = 0;
    }
};

// Removes listeners for a specific root, or all roots if none given.
export const teardownDelegation = (root?: Node): void => {
    if (root) {
        _delegationCleanups.get(root)?.();
    } else {
        for (const cleanup of Array.from(_delegationCleanups.values())) cleanup();
    }
};
