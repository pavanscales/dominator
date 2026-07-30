/**
 * Reactive Compute Graph — unified signal + dependency + stage graph.
 *
 * Every signal, computed, effect, layout, paint, and GPU node is a vertex.
 * Edges = dependencies. Propagation = topological BFS through stages.
 *
 * ARCHITECTURE:
 *
 *   Signal ──→ Computed ──→ Effect ──→ Layout ──→ Paint ──→ GPU
 *     │            │            │           │          │        │
 *     └────────────┴────────────┴───────────┴──────────┴────────┘
 *                           │
 *                     Frame Stages
 *                (parallel dispatch per stage)
 *
 * STORAGE: SoA — all properties in flat typed arrays, zero object overhead.
 *
 * COMPUTE GRAPH FLOW:
 *   1. Signal system calls markSignalDirty(signalId) when value changes
 *   2. Computed nodes re-evaluate their dependencies
 *   3. Effects execute and mark ECS entities dirty
 *   4. ECS dirty entities flow through LAYOUT → PAINT → GPU stages
 */

import { getWorld, Flag } from './ecs';

// ═══════════════════════════════════════════════════════════════════════════
// NODE TYPES
// ═══════════════════════════════════════════════════════════════════════════

export const enum GraphNodeType {
    NONE           = 0,
    SIGNAL         = 1,
    COMPUTED       = 2,
    EFFECT         = 3,
    LAYOUT_NODE    = 4,
    PAINT_NODE     = 5,
    GPU_NODE       = 6,
    ANIMATION_NODE = 7,
    TEXT_NODE      = 8,
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE MASKS — which frame stage a node participates in
// ═══════════════════════════════════════════════════════════════════════════

export const STAGE_SIGNAL    = 1 << 0;
export const STAGE_EFFECT    = 1 << 1;
export const STAGE_LAYOUT    = 1 << 2;
export const STAGE_ANIMATION = 1 << 3;
export const STAGE_TEXT      = 1 << 4;
export const STAGE_VISIBILITY = 1 << 5;
export const STAGE_PAINT     = 1 << 6;
export const STAGE_GPU       = 1 << 7;

// ═══════════════════════════════════════════════════════════════════════════
// COMPUTE GRAPH — SoA storage
// ═══════════════════════════════════════════════════════════════════════════

const INITIAL_CAP = 16384;

export interface ComputeGraph {
    nodeType: Uint8Array;
    entityRef: Int32Array;
    signalRef: Int32Array;
    stageMask: Uint32Array;
    dirty: Uint8Array;

    outPtr: Int32Array;
    outLen: Uint16Array;
    outCap: Uint16Array;
    outData: Int32Array;

    inPtr: Int32Array;
    inLen: Uint16Array;
    inCap: Uint16Array;
    inData: Int32Array;

    count: number;
    cap: number;
    outDataTop: number;
    inDataTop: number;
    outDataCap: number;
    inDataCap: number;
}

const EDGE_GROW = 4;

let _graph: ComputeGraph | null = null;

function _ensureGraph(): ComputeGraph {
    if (_graph) return _graph;
    _graph = createGraph();
    return _graph;
}

export function createGraph(capacity: number = INITIAL_CAP): ComputeGraph {
    let cap = 1;
    while (cap < capacity) cap *= 2;

    const g: ComputeGraph = {
        nodeType: new Uint8Array(cap),
        entityRef: new Int32Array(cap).fill(-1),
        signalRef: new Int32Array(cap).fill(-1),
        stageMask: new Uint32Array(cap),
        dirty: new Uint8Array(cap),

        outPtr: new Int32Array(cap).fill(-1),
        outLen: new Uint16Array(cap),
        outCap: new Uint16Array(cap),
        outData: new Int32Array(cap * EDGE_GROW),

        inPtr: new Int32Array(cap).fill(-1),
        inLen: new Uint16Array(cap),
        inCap: new Uint16Array(cap),
        inData: new Int32Array(cap * EDGE_GROW),

        count: 0,
        cap,
        outDataTop: 0,
        inDataTop: 0,
        outDataCap: cap * EDGE_GROW,
        inDataCap: cap * EDGE_GROW,
    };

    _graph = g;
    return g;
}

export function getGraph(): ComputeGraph {
    return _ensureGraph();
}

export function destroyGraph(): void {
    _graph = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// NODE ALLOCATION
// ═══════════════════════════════════════════════════════════════════════════

function _growGraph(g: ComputeGraph): void {
    const oldCap = g.cap;
    const newCap = oldCap * 2;

    const growU8 = (old: Uint8Array): Uint8Array => {
        const n = new Uint8Array(newCap);
        n.set(old);
        return n;
    };
    const growU16 = (old: Uint16Array): Uint16Array => {
        const n = new Uint16Array(newCap);
        n.set(old);
        return n;
    };
    const growU32 = (old: Uint32Array): Uint32Array => {
        const n = new Uint32Array(newCap);
        n.set(old);
        return n;
    };
    const growI32 = (old: Int32Array): Int32Array => {
        const n = new Int32Array(newCap);
        n.set(old);
        n.fill(-1, oldCap);
        return n;
    };

    g.nodeType = growU8(g.nodeType);
    g.entityRef = growI32(g.entityRef);
    g.signalRef = growI32(g.signalRef);
    g.stageMask = growU32(g.stageMask);
    g.dirty = growU8(g.dirty);
    g.outPtr = growI32(g.outPtr);
    g.outLen = growU16(g.outLen);
    g.outCap = growU16(g.outCap);
    g.inPtr = growI32(g.inPtr);
    g.inLen = growU16(g.inLen);
    g.inCap = growU16(g.inCap);
    g.cap = newCap;
}

function _ensureEdgeData(arr: 'out' | 'in', needed: number): void {
    const g = _graph!;
    if (arr === 'out') {
        if (needed < g.outDataCap) return;
        const newCap = Math.max(needed * 2, g.outDataCap * 2);
        const n = new Int32Array(newCap);
        n.set(g.outData.subarray(0, g.outDataTop));
        g.outData = n;
        g.outDataCap = newCap;
    } else {
        if (needed < g.inDataCap) return;
        const newCap = Math.max(needed * 2, g.inDataCap * 2);
        const n = new Int32Array(newCap);
        n.set(g.inData.subarray(0, g.inDataTop));
        g.inData = n;
        g.inDataCap = newCap;
    }
}

function _addEdge(g: ComputeGraph, from: number, to: number): void {
    const oPtr = g.outPtr[from];
    let oLen = g.outLen[from];
    let oCap = g.outCap[from];

    if (oCap === 0) {
        const newPtr = g.outDataTop;
        _ensureEdgeData('out', newPtr + EDGE_GROW);
        g.outData[newPtr] = to;
        g.outPtr[from] = newPtr;
        g.outLen[from] = 1;
        g.outCap[from] = EDGE_GROW;
        g.outDataTop = newPtr + EDGE_GROW;
    } else if (oLen < oCap) {
        g.outData[oPtr + oLen] = to;
        g.outLen[from] = oLen + 1;
    } else {
        const newCap = oCap + EDGE_GROW;
        const newPtr = g.outDataTop;
        _ensureEdgeData('out', newPtr + newCap);
        for (let i = 0; i < oLen; i++) {
            g.outData[newPtr + i] = g.outData[oPtr + i];
        }
        g.outData[newPtr + oLen] = to;
        g.outPtr[from] = newPtr;
        g.outLen[from] = oLen + 1;
        g.outCap[from] = newCap;
        g.outDataTop = newPtr + newCap;
    }

    const iPtr = g.inPtr[to];
    let iLen = g.inLen[to];
    let iCap = g.inCap[to];

    if (iCap === 0) {
        const newPtr = g.inDataTop;
        _ensureEdgeData('in', newPtr + EDGE_GROW);
        g.inData[newPtr] = from;
        g.inPtr[to] = newPtr;
        g.inLen[to] = 1;
        g.inCap[to] = EDGE_GROW;
        g.inDataTop = newPtr + EDGE_GROW;
    } else if (iLen < iCap) {
        g.inData[iPtr + iLen] = from;
        g.inLen[to] = iLen + 1;
    } else {
        const newCap = iCap + EDGE_GROW;
        const newPtr = g.inDataTop;
        _ensureEdgeData('in', newPtr + newCap);
        for (let i = 0; i < iLen; i++) {
            g.inData[newPtr + i] = g.inData[iPtr + i];
        }
        g.inData[newPtr + iLen] = from;
        g.inPtr[to] = newPtr;
        g.inLen[to] = iLen + 1;
        g.inCap[to] = newCap;
        g.inDataTop = newPtr + newCap;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

export function addNode(
    nodeType: GraphNodeType,
    entityId: number,
    signalId: number,
    stageMask: number,
): number {
    const g = _ensureGraph();
    if (g.count >= g.cap) _growGraph(g);
    const id = g.count++;
    g.nodeType[id] = nodeType;
    g.entityRef[id] = entityId;
    g.signalRef[id] = signalId;
    g.stageMask[id] = stageMask;
    g.dirty[id] = 0;
    _linkSignalNode(id, signalId);
    return id;
}

export function addEdge(fromId: number, toId: number): void {
    const g = _ensureGraph();
    _addEdge(g, fromId, toId);
}

// ═══════════════════════════════════════════════════════════════════════════
// O(1) DIRTY TRACKING — dirty node list + signal→node reverse index
// ═══════════════════════════════════════════════════════════════════════════

let _dirtyNodeList = new Int32Array(8192);
let _dirtyNodeCount = 0;
let _dirtyNodeCap = 8192;

let _signalToNodeHead: Int32Array = new Int32Array(4096).fill(-1);
let _signalToNodeNext: Int32Array = new Int32Array(INITIAL_CAP).fill(-1);
let _signalToNodeCap = 4096;

function _ensureSignalIndex(signalId: number): void {
    if (signalId < _signalToNodeCap) return;
    const old = _signalToNodeCap;
    const newCap = Math.max(signalId + 512, old * 2);
    const nh = new Int32Array(newCap);
    nh.fill(-1, old);
    nh.set(_signalToNodeHead.subarray(0, old));
    _signalToNodeHead = nh;
    _signalToNodeCap = newCap;
}

function _ensureSignalNext(id: number): void {
    if (id < _signalToNodeNext.length) return;
    const old = _signalToNodeNext.length;
    const newLen = Math.max(id + 256, old * 2);
    const nn = new Int32Array(newLen);
    nn.fill(-1, old);
    nn.set(_signalToNodeNext.subarray(0, old));
    _signalToNodeNext = nn;
}

function _linkSignalNode(nodeId: number, signalId: number): void {
    if (signalId < 0) return;
    _ensureSignalIndex(signalId);
    _ensureSignalNext(nodeId);
    _signalToNodeNext[nodeId] = _signalToNodeHead[signalId];
    _signalToNodeHead[signalId] = nodeId;
}

function _ensureDirtyList(): void {
    if (_dirtyNodeCount < _dirtyNodeCap) return;
    _dirtyNodeCap *= 2;
    const nd = new Int32Array(_dirtyNodeCap);
    nd.set(_dirtyNodeList);
    _dirtyNodeList = nd;
}

export function markSignalDirty(signalId: number): void {
    const g = _graph;
    if (!g) return;
    if (signalId >= _signalToNodeCap) return;
    let nodeId = _signalToNodeHead[signalId];
    while (nodeId >= 0 && nodeId < g.count) {
        if (!g.dirty[nodeId]) {
            g.dirty[nodeId] = 1;
            _ensureDirtyList();
            _dirtyNodeList[_dirtyNodeCount++] = nodeId;
        }
        nodeId = _signalToNodeNext[nodeId];
    }
}

export function markEntityDirty(entityId: number, stageMask: number): void {
    const g = _graph;
    if (!g) return;
    for (let i = 0; i < g.count; i++) {
        if (g.entityRef[i] === entityId && (g.stageMask[i] & stageMask) && !g.dirty[i]) {
            g.dirty[i] = 1;
            _ensureDirtyList();
            _dirtyNodeList[_dirtyNodeCount++] = i;
        }
    }
}

export function getDirtyNodes(): Int32Array {
    return _dirtyNodeList.subarray(0, _dirtyNodeCount);
}

export function getDirtyNodeCount(): number {
    return _dirtyNodeCount;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROPAGATION — topological BFS through the compute graph
//
// 1. Collect dirty root nodes from O(1) dirty list
// 2. BFS to all downstream nodes, tracking ALL dirty nodes
// 3. Return dirty count for per-stage dispatch
// ═══════════════════════════════════════════════════════════════════════════

let _bfsQueue = new Int32Array(32768);
let _bfsHead = 0;
let _bfsTail = 0;
let _bfsCap = 32768;

function _ensureBfsQueue(needed: number): void {
    if (needed < _bfsCap) return;
    const newCap = _bfsCap >= 262144 ? _bfsCap + 131072 : _bfsCap * 2;
    const nq = new Int32Array(newCap);
    nq.set(_bfsQueue.subarray(0, _bfsTail));
    _bfsQueue = nq;
    _bfsCap = newCap;
}

let _allDirtyNodes = new Int32Array(8192);
let _allDirtyCount = 0;
let _allDirtyCap = 8192;

function _ensureAllDirty(): void {
    if (_allDirtyCount < _allDirtyCap) return;
    _allDirtyCap *= 2;
    const nd = new Int32Array(_allDirtyCap);
    nd.set(_allDirtyNodes);
    _allDirtyNodes = nd;
}

export function propagateDirty(): number {
    const g = _graph;
    if (!g || g.count === 0) return 0;

    _bfsHead = 0;
    _bfsTail = 0;
    _allDirtyCount = 0;

    // Seed BFS queue from O(1) dirty root list
    const rootCount = _dirtyNodeCount;
    const roots = _dirtyNodeList;
    _ensureBfsQueue(_bfsTail + rootCount + 512);
    let i = 0;
    while (i < rootCount) {
        const nodeId = roots[i];
        _bfsQueue[_bfsTail++] = nodeId;
        _ensureAllDirty();
        _allDirtyNodes[_allDirtyCount++] = nodeId;
        i++;
    }
    _dirtyNodeCount = 0;

    // PREFETCH-ACCELERATED BFS — process 4 nodes per iteration
    // Software pipelining: read 4 nodes' metadata upfront, then process all their edges
    const outPtr = g.outPtr;
    const outLen = g.outLen;
    const outData = g.outData;
    const dirty = g.dirty;

    while (_bfsHead < _bfsTail) {
        // Batch 4 nodes: prefetch their outPtr/outLen into local vars
        const remaining = _bfsTail - _bfsHead;
        const batchSize = remaining < 4 ? remaining : 4;

        // Ensure room for 4 nodes × typical max edges
        _ensureBfsQueue(_bfsTail + 512);
        let queue = _bfsQueue;

        let b0 = 0, b1 = 0, b2 = 0, b3 = 0;
        let l0 = 0, l1 = 0, l2 = 0, l3 = 0;

        // Manual prefetch: read metadata for up to 4 nodes
        const h = _bfsHead;
        if (batchSize >= 1) { const n = queue[h];     b0 = outPtr[n]; l0 = outLen[n]; }
        if (batchSize >= 2) { const n = queue[h + 1]; b1 = outPtr[n]; l1 = outLen[n]; }
        if (batchSize >= 3) { const n = queue[h + 2]; b2 = outPtr[n]; l2 = outLen[n]; }
        if (batchSize >= 4) { const n = queue[h + 3]; b3 = outPtr[n]; l3 = outLen[n]; }
        _bfsHead += batchSize;

        // Refresh queue alias after potential growth
        queue = _bfsQueue;

        // Process each node's edges — unrolled inner loops for common edge lengths
        // Node 0
        let j = 0;
        while (j < l0) {
            const target = outData[b0 + j];
            if (!dirty[target]) {
                dirty[target] = 1;
                queue[_bfsTail++] = target;
                _ensureAllDirty();
                _allDirtyNodes[_allDirtyCount++] = target;
            }
            j++;
        }
        // Node 1
        j = 0;
        while (j < l1) {
            const target = outData[b1 + j];
            if (!dirty[target]) {
                dirty[target] = 1;
                queue[_bfsTail++] = target;
                _ensureAllDirty();
                _allDirtyNodes[_allDirtyCount++] = target;
            }
            j++;
        }
        // Node 2
        j = 0;
        while (j < l2) {
            const target = outData[b2 + j];
            if (!dirty[target]) {
                dirty[target] = 1;
                queue[_bfsTail++] = target;
                _ensureAllDirty();
                _allDirtyNodes[_allDirtyCount++] = target;
            }
            j++;
        }
        // Node 3
        j = 0;
        while (j < l3) {
            const target = outData[b3 + j];
            if (!dirty[target]) {
                dirty[target] = 1;
                queue[_bfsTail++] = target;
                _ensureAllDirty();
                _allDirtyNodes[_allDirtyCount++] = target;
            }
            j++;
        }
    }

    return _allDirtyCount;
}

// ═══════════════════════════════════════════════════════════════════════════
// PER-STAGE NODE COLLECTION — O(dirty), zero O(N) scan
// ═══════════════════════════════════════════════════════════════════════════

let _stageOutputBuf = new Int32Array(8192);
let _stageOutputCount = 0;

export function getNodesByStage(stageMask: number): Int32Array {
    const g = _graph!;
    _stageOutputCount = 0;
    const dirtyList = _allDirtyNodes;
    const dirtyCount = _allDirtyCount;
    for (let i = 0; i < dirtyCount; i++) {
        const nodeId = dirtyList[i];
        if (g.stageMask[nodeId] & stageMask) {
            _stageOutputBuf[_stageOutputCount++] = nodeId;
        }
    }
    return _stageOutputBuf.subarray(0, _stageOutputCount);
}

export function getStageNodeCount(): number {
    return _stageOutputCount;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLEAR DIRTY — O(dirty), zero O(N) fill
// ═══════════════════════════════════════════════════════════════════════════

export function clearDirty(): void {
    const g = _graph!;
    const list = _allDirtyNodes;
    const count = _allDirtyCount;
    for (let i = 0; i < count; i++) {
        g.dirty[list[i]] = 0;
    }
    _allDirtyCount = 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// EFFECT CALLBACK EXECUTION — BARE METAL
//
// When the compute graph is active, effect callbacks are stored here and
// executed by the frame scheduler's SIGNALS stage after dirty propagation.
// This ELIMINATES the old signal system's subscriber dispatch entirely.
//
// STORAGE: flat array indexed by graph node ID, zero object overhead.
// ═══════════════════════════════════════════════════════════════════════════

let _effectCallbacks: (() => void)[] = new Array(4096);

export function registerEffectCallback(nodeId: number, fn: () => void): void {
    if (nodeId >= _effectCallbacks.length) {
        const oldLen = _effectCallbacks.length;
        const newLen = Math.max(nodeId + 256, oldLen * 2);
        const nc = new Array(newLen);
        for (let i = 0; i < oldLen; i++) nc[i] = _effectCallbacks[i];
        _effectCallbacks = nc;
    }
    _effectCallbacks[nodeId] = fn;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTE DIRTY EFFECTS — O(dirty), zero O(N) scan
//
// After propagateDirty(), iterate only dirty nodes.
// For each EFFECT node, call its registered callback.
// This is the BRIDGE between the compute graph and actual DOM mutations.
//
// GUARANTEE: every effect callback is called at most once per frame
// (duplicate elimination via dirty bitmap, not hash set)
// ═══════════════════════════════════════════════════════════════════════════

export function executeDirtyEffects(): number {
    const g = _graph;
    if (!g) return 0;
    let executed = 0;
    const list = _allDirtyNodes;
    const count = _allDirtyCount;
    const nodeType = g.nodeType;
    const callbacks = _effectCallbacks;
    for (let i = 0; i < count; i++) {
        const nodeId = list[i];
        if (nodeType[nodeId] === GraphNodeType.EFFECT) {
            const fn = callbacks[nodeId];
            if (fn) { fn(); executed++; }
        }
    }
    return executed;
}

// ═══════════════════════════════════════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════════════════════════════════════

export function resetGraph(): void {
    if (_graph) {
        _graph.count = 0;
        _graph.outDataTop = 0;
        _graph.inDataTop = 0;
        _graph.nodeType.fill(0);
        _graph.entityRef.fill(-1);
        _graph.signalRef.fill(-1);
        _graph.stageMask.fill(0);
        _graph.dirty.fill(0);
        _graph.outPtr.fill(-1);
        _graph.outLen.fill(0);
        _graph.outCap.fill(0);
        _graph.inPtr.fill(-1);
        _graph.inLen.fill(0);
        _graph.inCap.fill(0);
    }
    _dirtyNodeCount = 0;
    _allDirtyCount = 0;
    _bfsHead = 0;
    _bfsTail = 0;
}