/**
 * ECS — Entity Component System with SoA (Struct of Arrays) storage.
 *
 * Every component type is a contiguous typed array.
 * Systems iterate arrays — no object allocation, no pointer chasing.
 * Component access is O(1) via entity ID → array index.
 *
 * MEMORY LAYOUT (per entity):
 *   parent[]    : Int32Array   — parent entity ID (-1 = root)
 *   children[]  : Int32Array   — first child entity ID (-1 = none)
 *   nextSibling[]: Int32Array  — next sibling entity ID (-1 = none)
 *   childCount[] : Uint16Array — number of children
 *   depth[]     : Uint16Array  — tree depth
 *   flags[]     : Uint32Array  — bitmask: dirty|visible|layout|paint|event|text
 *   style[]     : StyleStore   — packed style data
 *   layout[]    : LayoutStore  — layout rectangles
 *   render[]    : RenderStore  — render commands
 *   event[]     : EventStore   — event bindings
 *   domRef[]    : Int32Array   — DOM node ID (-1 = none)
 */

// ═══════════════════════════════════════════════════════════════════════════
// FLAGS — bitmask per entity
// ═══════════════════════════════════════════════════════════════════════════

export const enum Flag {
    NONE       = 0,
    DIRTY      = 1 << 0,
    VISIBLE    = 1 << 1,
    NEEDS_LAYOUT = 1 << 2,
    NEEDS_PAINT  = 1 << 3,
    HAS_EVENT    = 1 << 4,
    HAS_TEXT     = 1 << 5,
    HAS_STYLE   = 1 << 6,
    REMOVED     = 1 << 7,
    ROOT        = 1 << 8,
    IS_LEAF     = 1 << 9,
}

// ═══════════════════════════════════════════════════════════════════════════
// STYLE STORE — packed Float32Array per entity
// ═══════════════════════════════════════════════════════════════════════════

// Style layout: 16 floats per entity
// [0] x, [1] y, [2] width, [3] height
// [4] paddingLeft, [5] paddingRight, [6] paddingTop, [7] paddingBottom
// [8] marginLeft, [9] marginRight, [10] marginTop, [11] marginBottom
// [12] opacity, [13] borderRadius, [14] borderWidth, [15] reserved
const STYLE_FLOATS = 16;

// Color storage: 4 uint8 per entity (RGBA) packed into Uint32Array
// bgRgba, fgRgba, borderRgba, shadowRgba — 4 x Uint32 = 16 bytes
const COLOR_UINT32S = 4;

export interface StyleStore {
    floats: Float32Array;
    colors: Uint32Array;
    count: number;
    cap: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYOUT STORE — computed rectangles
// ═══════════════════════════════════════════════════════════════════════════

// Layout: 8 floats per entity
// [0] x, [1] y, [2] width, [3] height
// [4] contentWidth, [5] contentHeight
// [6] scrollWidth, [7] scrollHeight
const LAYOUT_FLOATS = 8;

export interface LayoutStore {
    data: Float32Array;
    count: number;
    cap: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDER STORE — render command references
// ═══════════════════════════════════════════════════════════════════════════

// Render: 4 ints per entity
// [0] commandStart index in command buffer
// [1] commandCount number of commands
// [2] clipId — clipping region ID (-1 = none)
// [3] zIndex — z-ordering
const RENDER_INTS = 4;

export interface RenderStore {
    data: Int32Array;
    count: number;
    cap: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT STORE — event handler bindings
// ═══════════════════════════════════════════════════════════════════════════

// Event: 3 ints per entity
// [0] handlerId — index into handler function array (-1 = none)
// [1] eventMask — bitmask of registered event types
// [2] reserved
const EVENT_INTS = 3;

export interface EventStore {
    data: Int32Array;
    count: number;
    cap: number;
    handlerFns: ((e: Event) => void)[];
    handlerCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// ECS WORLD — the central store
// ═══════════════════════════════════════════════════════════════════════════

export interface ECSWorld {
    // Entity arrays
    parent: Int32Array;
    children: Int32Array;
    nextSibling: Int32Array;
    childCount: Uint16Array;
    depth: Uint16Array;
    flags: Uint32Array;
    domRef: Int32Array;

    // Component stores
    style: StyleStore;
    layout: LayoutStore;
    render: RenderStore;
    event: EventStore;

    // Entity management
    count: number;
    cap: number;
    freeList: Int32Array;
    freeCount: number;
    generation: Uint32Array;

    // Root entity
    root: number;
}

let _world: ECSWorld | null = null;
let _sharedBuffer: SharedArrayBuffer | null = null;

const INITIAL_CAP = 4096;
const GROW_FACTOR = 2;

function _growArrays(world: ECSWorld): void {
    const oldCap = world.cap;
    const newCap = oldCap * GROW_FACTOR;

    const grow1 = (old: Int32Array): Int32Array => {
        const n = new Int32Array(newCap);
        n.set(old);
        n.fill(-1, oldCap);
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

    world.parent = grow1(world.parent);
    world.children = grow1(world.children);
    world.nextSibling = grow1(world.nextSibling);
    world.childCount = growU16(world.childCount);
    world.depth = growU16(world.depth);
    world.flags = growU32(world.flags);
    world.domRef = grow1(world.domRef);

    // Grow component stores
    const growStyleFloats = (old: Float32Array): Float32Array => {
        const n = new Float32Array(newCap * STYLE_FLOATS);
        n.set(old);
        return n;
    };
    const growStyleColors = (old: Uint32Array): Uint32Array => {
        const n = new Uint32Array(newCap * COLOR_UINT32S);
        n.set(old);
        return n;
    };
    world.style.floats = growStyleFloats(world.style.floats);
    world.style.colors = growStyleColors(world.style.colors);

    const growLayout = (old: Float32Array): Float32Array => {
        const n = new Float32Array(newCap * LAYOUT_FLOATS);
        n.set(old);
        return n;
    };
    world.layout.data = growLayout(world.layout.data);

    const growRender = (old: Int32Array): Int32Array => {
        const n = new Int32Array(newCap * RENDER_INTS);
        n.set(old);
        n.fill(-1, oldCap * RENDER_INTS);
        return n;
    };
    world.render.data = growRender(world.render.data);

    const growEvent = (old: Int32Array): Int32Array => {
        const n = new Int32Array(newCap * EVENT_INTS);
        n.set(old);
        n.fill(-1, oldCap * EVENT_INTS);
        return n;
    };
    world.event.data = growEvent(world.event.data);

    // Grow freeList — without this, despawn after grow overflows the buffer
    const growFreeList = (old: Int32Array): Int32Array => {
        const n = new Int32Array(newCap);
        n.set(old);
        return n;
    };
    world.freeList = growFreeList(world.freeList);

    world.cap = newCap;
    world.generation = growU32(world.generation);
}

function _allocEntity(world: ECSWorld): number {
    if (world.freeCount > 0) {
        world.freeCount--;
        return world.freeList[world.freeCount];
    }
    if (world.count >= world.cap) {
        if (_sharedBuffer) return -1; // Shared: fixed capacity, no growing
        _growArrays(world);
    }
    return world.count++;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

export function createWorld(capacity: number = INITIAL_CAP): ECSWorld {
    let cap = 1;
    while (cap < capacity) cap *= 2;

    const w: ECSWorld = {
        parent: new Int32Array(cap).fill(-1),
        children: new Int32Array(cap).fill(-1),
        nextSibling: new Int32Array(cap).fill(-1),
        childCount: new Uint16Array(cap),
        depth: new Uint16Array(cap),
        flags: new Uint32Array(cap),
        domRef: new Int32Array(cap).fill(-1),

        style: {
            floats: new Float32Array(cap * STYLE_FLOATS),
            colors: new Uint32Array(cap * COLOR_UINT32S),
            count: 0,
            cap,
        },
        layout: {
            data: new Float32Array(cap * LAYOUT_FLOATS),
            count: 0,
            cap,
        },
        render: {
            data: new Int32Array(cap * RENDER_INTS),
            count: 0,
            cap,
        },
        event: {
            data: new Int32Array(cap * EVENT_INTS),
            count: 0,
            cap,
            handlerFns: new Array(256),
            handlerCount: 0,
        },

        count: 1, // 0 is reserved as "null entity"
        cap,
        freeList: new Int32Array(cap),
        freeCount: 0,
        generation: new Uint32Array(cap),

        root: 0,
    };

    // Entity 0 is the root
    w.flags[0] = Flag.ROOT | Flag.VISIBLE;
    _world = w;
    return w;
}

export function getWorld(): ECSWorld {
    if (!_world) _world = createWorld();
    return _world;
}

export function destroyWorld(): void {
    _world = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHAREDARRAYBUFFER ECS — lock-free worker access
//
// Allocates all typed arrays from a single SharedArrayBuffer so the entire
// ECS world can be shared with Web Workers via postMessage().
// Fixed maximum capacity — no growing (HPC: entity count known upfront).
// ═══════════════════════════════════════════════════════════════════════════

export function createSharedWorld(maxCapacity: number = 16384): ECSWorld {
    let cap = 1;
    while (cap < maxCapacity) cap *= 2;

    const off = (bytes: number) => {
        const o = _sbOffset;
        _sbOffset += bytes;
        return o;
    };

    const totalBytes =
        cap * 4 +   // parent
        cap * 4 +   // children
        cap * 4 +   // nextSibling
        cap * 2 +   // childCount
        cap * 2 +   // depth
        cap * 4 +   // flags
        cap * 4 +   // domRef
        cap * STYLE_FLOATS * 4 +  // style.floats
        cap * COLOR_UINT32S * 4 + // style.colors
        cap * LAYOUT_FLOATS * 4 + // layout.data
        cap * RENDER_INTS * 4 +   // render.data
        cap * EVENT_INTS * 4 +    // event.data
        cap * 4 +   // freeList
        cap * 4;    // generation

    let _sbOffset = 0;
    const sb = new SharedArrayBuffer(totalBytes);

    const w: ECSWorld = {
        parent: new Int32Array(sb, off(cap * 4), cap).fill(-1),
        children: new Int32Array(sb, off(cap * 4), cap).fill(-1),
        nextSibling: new Int32Array(sb, off(cap * 4), cap).fill(-1),
        childCount: new Uint16Array(sb, off(cap * 2), cap),
        depth: new Uint16Array(sb, off(cap * 2), cap),
        flags: new Uint32Array(sb, off(cap * 4), cap),
        domRef: new Int32Array(sb, off(cap * 4), cap).fill(-1),

        style: {
            floats: new Float32Array(sb, off(cap * STYLE_FLOATS * 4), cap * STYLE_FLOATS),
            colors: new Uint32Array(sb, off(cap * COLOR_UINT32S * 4), cap * COLOR_UINT32S),
            count: 0,
            cap,
        },
        layout: {
            data: new Float32Array(sb, off(cap * LAYOUT_FLOATS * 4), cap * LAYOUT_FLOATS),
            count: 0,
            cap,
        },
        render: {
            data: new Int32Array(sb, off(cap * RENDER_INTS * 4), cap * RENDER_INTS),
            count: 0,
            cap,
        },
        event: {
            data: new Int32Array(sb, off(cap * EVENT_INTS * 4), cap * EVENT_INTS),
            count: 0,
            cap,
            handlerFns: new Array(256),
            handlerCount: 0,
        },

        count: 1,
        cap,
        freeList: new Int32Array(sb, off(cap * 4), cap),
        freeCount: 0,
        generation: new Uint32Array(sb, off(cap * 4), cap),

        root: 0,
    };

    w.flags[0] = Flag.ROOT | Flag.VISIBLE;
    _world = w;
    _sharedBuffer = sb;
    return w;
}

export function getWorldSharedBuffer(): SharedArrayBuffer | null {
    return _sharedBuffer;
}

export function createWorldView(sb: SharedArrayBuffer, cap: number): ECSWorld {
    let _sbOffset = 0;
    const off = (bytes: number) => {
        const o = _sbOffset;
        _sbOffset += bytes;
        return o;
    };

    const totalBytes =
        cap * 4 +   // parent
        cap * 4 +   // children
        cap * 4 +   // nextSibling
        cap * 2 +   // childCount
        cap * 2 +   // depth
        cap * 4 +   // flags
        cap * 4 +   // domRef
        cap * STYLE_FLOATS * 4 +  // style.floats
        cap * COLOR_UINT32S * 4 + // style.colors
        cap * LAYOUT_FLOATS * 4 + // layout.data
        cap * RENDER_INTS * 4 +   // render.data
        cap * EVENT_INTS * 4 +    // event.data
        cap * 4 +   // freeList
        cap * 4;    // generation

    if (sb.byteLength < totalBytes) {
        throw new Error(`createWorldView: SharedArrayBuffer too small (${sb.byteLength} < ${totalBytes})`);
    }

    return {
        parent: new Int32Array(sb, off(cap * 4), cap),
        children: new Int32Array(sb, off(cap * 4), cap),
        nextSibling: new Int32Array(sb, off(cap * 4), cap),
        childCount: new Uint16Array(sb, off(cap * 2), cap),
        depth: new Uint16Array(sb, off(cap * 2), cap),
        flags: new Uint32Array(sb, off(cap * 4), cap),
        domRef: new Int32Array(sb, off(cap * 4), cap),
        style: {
            floats: new Float32Array(sb, off(cap * STYLE_FLOATS * 4), cap * STYLE_FLOATS),
            colors: new Uint32Array(sb, off(cap * COLOR_UINT32S * 4), cap * COLOR_UINT32S),
            count: 0, cap,
        },
        layout: {
            data: new Float32Array(sb, off(cap * LAYOUT_FLOATS * 4), cap * LAYOUT_FLOATS),
            count: 0, cap,
        },
        render: {
            data: new Int32Array(sb, off(cap * RENDER_INTS * 4), cap * RENDER_INTS),
            count: 0, cap,
        },
        event: {
            data: new Int32Array(sb, off(cap * EVENT_INTS * 4), cap * EVENT_INTS),
            count: 0, cap,
            handlerFns: new Array(256),
            handlerCount: 0,
        },
        count: 1,
        cap,
        freeList: new Int32Array(sb, off(cap * 4), cap),
        freeCount: 0,
        generation: new Uint32Array(sb, off(cap * 4), cap),
        root: 0,
    };
}

export function spawn(parentId: number = -1): number {
    const w = getWorld();
    const id = _allocEntity(w);
    if (id < 0) return -1;

    w.parent[id] = parentId;
    w.flags[id] = Flag.VISIBLE | Flag.NEEDS_LAYOUT | Flag.NEEDS_PAINT | Flag.DIRTY;
    // Default opacity 1 — the render graph culls entities at opacity <= 0,
    // and typed arrays zero-fill by default (0 would hide every entity).
    w.style.floats[id * STYLE_FLOATS + STYLE_OPACITY] = 1;
    w.generation[id]++;
    _addToDirtyList(w, id);

    if (parentId >= 0) {
        w.nextSibling[id] = w.children[parentId];
        w.children[parentId] = id;
        w.childCount[parentId]++;
        w.depth[id] = w.depth[parentId] + 1;
        _markLayoutDirtyEntity(w, parentId);
    } else {
        w.depth[id] = 0;
    }

    return id;
}

export function despawn(id: number): void {
    const w = getWorld();
    if (id <= 0 || id >= w.count) return;
    if (w.flags[id] & Flag.REMOVED) return;

    // Detach from parent
    const pid = w.parent[id];
    if (pid >= 0) {
        // Remove from parent's child linked list
        let prev = -1;
        let child = w.children[pid];
        while (child >= 0) {
            if (child === id) {
                if (prev === -1) {
                    w.children[pid] = w.nextSibling[id];
                } else {
                    w.nextSibling[prev] = w.nextSibling[id];
                }
                w.childCount[pid]--;
                _markLayoutDirtyEntity(w, pid);
                break;
            }
            prev = child;
            child = w.nextSibling[child];
        }
    }

    // Iteratively despawn all descendants using a pre-allocated stack
    _despawnStackTop = 0;
    let child = w.children[id];
    while (child >= 0) {
        if (_despawnStackTop < 16384) {
            _despawnStack[_despawnStackTop++] = child;
        }
        child = w.nextSibling[child];
    }
    while (_despawnStackTop > 0) {
        const current = _despawnStack[--_despawnStackTop];
        // Push this entity's children onto the stack
        let ch = w.children[current];
        while (ch >= 0) {
            if (_despawnStackTop < 16384) {
                _despawnStack[_despawnStackTop++] = ch;
            }
            ch = w.nextSibling[ch];
        }
        // Despawn the entity itself (leaf first)
        w.flags[current] = Flag.REMOVED;
        w.parent[current] = -1;
        w.children[current] = -1;
        w.nextSibling[current] = -1;
        w.childCount[current] = 0;
        w.freeList[w.freeCount++] = current;
    }

    // Mark as removed
    w.flags[id] = Flag.REMOVED;
    w.parent[id] = -1;
    w.children[id] = -1;
    w.nextSibling[id] = -1;
    w.childCount[id] = 0;

    // Add to free list
    w.freeList[w.freeCount++] = id;
}

export function setParent(childId: number, newParentId: number): void {
    const w = getWorld();
    if (childId <= 0 || childId >= w.count) return;
    if (newParentId >= w.count || newParentId === childId) return;

    // Detach from old parent
    const oldParent = w.parent[childId];
    if (oldParent >= 0) {
        let prev = -1;
        let sibling = w.children[oldParent];
        while (sibling >= 0) {
            if (sibling === childId) {
                if (prev === -1) {
                    w.children[oldParent] = w.nextSibling[childId];
                } else {
                    w.nextSibling[prev] = w.nextSibling[childId];
                }
                w.childCount[oldParent]--;
                break;
            }
            prev = sibling;
            sibling = w.nextSibling[sibling];
        }
    }

    // Attach to new parent
    w.parent[childId] = newParentId;
    if (newParentId >= 0) {
        w.nextSibling[childId] = w.children[newParentId];
        w.children[newParentId] = childId;
        w.childCount[newParentId]++;
        w.depth[childId] = w.depth[newParentId] + 1;
    } else {
        w.depth[childId] = 0;
    }

    // Update depths of subtree
    _updateSubtreeDepth(w, childId);
}

const _depthUpdateStack = new Int32Array(16384);
let _depthUpdateTop = 0;

function _updateSubtreeDepth(w: ECSWorld, id: number): void {
    _depthUpdateTop = 0;
    _depthUpdateStack[_depthUpdateTop++] = id;
    while (_depthUpdateTop > 0) {
        const current = _depthUpdateStack[--_depthUpdateTop];
        let child = w.children[current];
        while (child >= 0) {
            w.depth[child] = w.depth[current] + 1;
            if (_depthUpdateTop < 16384) {
                _depthUpdateStack[_depthUpdateTop++] = child;
            }
            child = w.nextSibling[child];
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// O(1) DIRTY TRACKING — maintain dirty list, ZERO O(N) scans
//
// Every setStyleFloat/setStyleColor/markLayoutDirty/markPaintDirty call
// appends entity ID to _dirtyList if not already dirty.
// getDirtyEntities() returns the list — O(1).
// clearDirtyFlags() iterates only dirty entities — O(dirty), not O(total).
// ═══════════════════════════════════════════════════════════════════════════

let _dirtyList = new Int32Array(16384);
let _dirtyCount = 0;
let _dirtyListCap = 16384;

function _ensureDirtyList(): void {
    if (_dirtyCount < _dirtyListCap) return;
    const newCap = _dirtyListCap * 2;
    const nd = new Int32Array(newCap);
    nd.set(_dirtyList);
    _dirtyList = nd;
    _dirtyListCap = newCap;
}

function _addToDirtyList(w: ECSWorld, id: number): void {
    _ensureDirtyList();
    _dirtyList[_dirtyCount++] = id;
}

// NOTE: Returns a view (subarray) into the internal dirty list buffer.
// The view becomes stale after clearDirtyFlags() resets _dirtyCount —
// do not hold the reference across frames or across clearDirtyFlags calls.
export function _getDirtyList(): Int32Array {
    return _dirtyList.subarray(0, _dirtyCount);
}

export function _getDirtyCount(): number {
    return _dirtyCount;
}

export function _clearDirtyListCount(): void {
    _dirtyCount = 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// STYLE ACCESSORS — inline, cache-friendly
// ═══════════════════════════════════════════════════════════════════════════

export const STYLE_X = 0;
export const STYLE_Y = 1;
export const STYLE_W = 2;
export const STYLE_H = 3;
export const STYLE_PL = 4;
export const STYLE_PR = 5;
export const STYLE_PT = 6;
export const STYLE_PB = 7;
export const STYLE_ML = 8;
export const STYLE_MR = 9;
export const STYLE_MT = 10;
export const STYLE_MB = 11;
export const STYLE_OPACITY = 12;
export const STYLE_BORDER_RADIUS = 13;
export const STYLE_BORDER_WIDTH = 14;

export function setStyleFloat(entityId: number, offset: number, value: number): void {
    const w = getWorld();
    // Bounds guard: entityId beyond the world's allocated range indexes past
    // the SoA arrays (style.floats is cap*16) and silently corrupts adjacent
    // memory. Reject invalid IDs and out-of-range style slots up front.
    if (entityId < 0 || entityId >= w.count) return;
    if (offset < 0 || offset >= STYLE_FLOATS) return;
    w.style.floats[entityId * STYLE_FLOATS + offset] = value;
    const wasDirty = w.flags[entityId] & Flag.DIRTY;
    w.flags[entityId] |= Flag.HAS_STYLE | Flag.DIRTY | Flag.NEEDS_LAYOUT | Flag.NEEDS_PAINT;
    if (!wasDirty) _addToDirtyList(w, entityId);
    _markLayoutDirtyEntity(w, entityId);
}

export function getStyleFloat(entityId: number, offset: number): number {
    const w = getWorld();
    if (entityId < 0 || entityId >= w.count) return 0;
    if (offset < 0 || offset >= STYLE_FLOATS) return 0;
    return w.style.floats[entityId * STYLE_FLOATS + offset];
}

export function setStyleColor(entityId: number, slot: number, r: number, g: number, b: number, a: number): void {
    const w = getWorld();
    if (entityId < 0 || entityId >= w.count) return;
    if (slot < 0 || slot >= COLOR_UINT32S) return;
    const packed = ((r & 0xFF) << 24) | ((g & 0xFF) << 16) | ((b & 0xFF) << 8) | (a & 0xFF);
    w.style.colors[entityId * COLOR_UINT32S + slot] = packed >>> 0;
    const wasDirty = w.flags[entityId] & Flag.DIRTY;
    w.flags[entityId] |= Flag.HAS_STYLE | Flag.DIRTY | Flag.NEEDS_PAINT;
    if (!wasDirty) _addToDirtyList(w, entityId);
}

export function getStyleColor(entityId: number, slot: number): number {
    const w = getWorld();
    if (entityId < 0 || entityId >= w.count) return 0;
    if (slot < 0 || slot >= COLOR_UINT32S) return 0;
    return w.style.colors[entityId * COLOR_UINT32S + slot];
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYOUT ACCESSORS
// ═══════════════════════════════════════════════════════════════════════════

export const LAYOUT_X = 0;
export const LAYOUT_Y = 1;
export const LAYOUT_W = 2;
export const LAYOUT_H = 3;
export const LAYOUT_CW = 4;
export const LAYOUT_CH = 5;
export const LAYOUT_SW = 6;
export const LAYOUT_SH = 7;

export function setLayoutRect(entityId: number, x: number, y: number, w: number, h: number): void {
    const data = getWorld().layout.data;
    const wld = getWorld();
    if (entityId < 0 || entityId >= wld.count) return;
    const base = entityId * LAYOUT_FLOATS;
    data[base] = x;
    data[base + 1] = y;
    data[base + 2] = w;
    data[base + 3] = h;
}

export function getLayoutRect(entityId: number): { x: number; y: number; w: number; h: number } {
    const data = getWorld().layout.data;
    const wld = getWorld();
    if (entityId < 0 || entityId >= wld.count) return { x: 0, y: 0, w: 0, h: 0 };
    const base = entityId * LAYOUT_FLOATS;
    return { x: data[base], y: data[base + 1], w: data[base + 2], h: data[base + 3] };
}

function _markLayoutDirtyEntity(w: ECSWorld, entityId: number): void {
    const wasDirty = w.flags[entityId] & Flag.DIRTY;
    w.flags[entityId] |= Flag.NEEDS_LAYOUT | Flag.DIRTY;
    if (!wasDirty) _addToDirtyList(w, entityId);
    // Propagate dirty up to root so runLayout's root gate opens
    let pid = w.parent[entityId];
    while (pid >= 0) {
        const parentWasDirty = w.flags[pid] & Flag.DIRTY;
        w.flags[pid] |= Flag.NEEDS_LAYOUT | Flag.DIRTY;
        if (!parentWasDirty) _addToDirtyList(w, pid);
        pid = w.parent[pid];
    }
}

export function markLayoutDirty(entityId: number): void {
    const w = getWorld();
    if (entityId < 0 || entityId >= w.count) return;
    _markLayoutDirtyEntity(w, entityId);
}

export function markPaintDirty(entityId: number): void {
    const w = getWorld();
    if (entityId < 0 || entityId >= w.count) return;
    const wasDirty = w.flags[entityId] & Flag.DIRTY;
    w.flags[entityId] |= Flag.NEEDS_PAINT | Flag.DIRTY;
    if (!wasDirty) _addToDirtyList(w, entityId);
}

// ═══════════════════════════════════════════════════════════════════════════
// TREE ITERATION — depth-first, zero-allocation, typed array stack
// ═══════════════════════════════════════════════════════════════════════════

// Pre-allocated stack for DFS traversal — typed array, zero GC
const _dfsStack = new Int32Array(16384);
let _dfsStackTop = 0;

// Pre-allocated stack for despawn traversal — zero GC
const _despawnStack = new Int32Array(16384);
let _despawnStackTop = 0;

export function forEachChild(parentId: number, fn: (entityId: number) => void): void {
    const w = getWorld();
    let child = w.children[parentId];
    while (child >= 0) {
        fn(child);
        child = w.nextSibling[child];
    }
}

export function forEachDescendant(entityId: number, fn: (id: number, depth: number) => void): void {
    const w = getWorld();
    _dfsStackTop = 0;
    _dfsStack[_dfsStackTop++] = entityId;

    while (_dfsStackTop > 0) {
        const current = _dfsStack[--_dfsStackTop];
        let child = w.children[current];
        while (child >= 0) {
            fn(child, w.depth[child]);
            // Push children in reverse for correct DFS order
            let sib = w.children[child];
            let count = 0;
            while (sib >= 0) {
                count++;
                sib = w.nextSibling[sib];
            }
            // Push from back to front
            sib = w.children[child];
            for (let skip = 0; skip < count - 1; skip++) {
                sib = w.nextSibling[sib];
            }
            while (sib >= 0) {
                if (_dfsStackTop < 16384) {
                    _dfsStack[_dfsStackTop++] = sib;
                }
                // Walk backwards: find parent of sib to get previous sibling
                let prev = -1;
                let scan = w.children[current];
                while (scan >= 0 && scan !== sib) {
                    prev = scan;
                    scan = w.nextSibling[scan];
                }
                sib = prev;
            }
            child = w.nextSibling[child];
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DIRTY ENTITY ACCESS — O(1) dirty list, ZERO O(N) scans
// ═══════════════════════════════════════════════════════════════════════════

export function getDirtyEntities(): Int32Array {
    // Return a copy: the caller owns it, so mutating it cannot corrupt the
    // internal dirty list (a live view would be a footgun for public API).
    return _dirtyList.slice(0, _dirtyCount);
}

export function getDirtyEntityCount(): number {
    return _dirtyCount;
}

export function clearDirtyFlags(): void {
    const w = getWorld();
    const mask = ~(Flag.DIRTY | Flag.NEEDS_LAYOUT | Flag.NEEDS_PAINT);
    const list = _dirtyList;
    const count = _dirtyCount;
    for (let i = 0; i < count; i++) {
        w.flags[list[i]] &= mask;
    }
    _dirtyCount = 0;
}

export const STYLE_FLOATS_PER_ENTITY = STYLE_FLOATS;
export const LAYOUT_FLOATS_PER_ENTITY = LAYOUT_FLOATS;
export const RENDER_INTS_PER_ENTITY = RENDER_INTS;
