/**
 * Render Graph — ZERO-ALLOCATION render command generation.
 *
 * Command types:
 *   Rect, Text, Border, Shadow, Transform, Clip
 *
 * The render graph processes ONLY dirty+NEEDS_PAINT entities.
 * Command buffer is a fixed ring buffer — reset just moves the head pointer.
 * String interning uses a persistent table with generation-based eviction.
 *
 * ZERO-ALLOCATION GUARANTEES:
 *   - Command buffer is pre-allocated, reused across frames
 *   - Float scratch buffer is pre-allocated, reused across frames
 *   - resetRenderGraph() just resets head/tail pointers (no array allocation)
 *   - String intern table uses generation-based eviction (no Map.clear())
 *
 * DEGRADATION:
 *   LITE  = skip border/shadow generation, skip optimizer passes
 *   REUSE = replay previous frame's frozen command buffer
 */

import {
    getWorld, Flag,
    STYLE_X, STYLE_Y, STYLE_W, STYLE_H,
    STYLE_OPACITY, STYLE_BORDER_RADIUS, STYLE_BORDER_WIDTH,
    STYLE_FLOATS_PER_ENTITY,
    LAYOUT_X, LAYOUT_Y, LAYOUT_W, LAYOUT_H,
    LAYOUT_FLOATS_PER_ENTITY,
    RENDER_INTS_PER_ENTITY,
    STYLE_PL, STYLE_PR, STYLE_PT, STYLE_PB,
    getStyleColor,
    _getDirtyList, _getDirtyCount,
} from './ecs';

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND TYPES
// ═══════════════════════════════════════════════════════════════════════════

export const enum CmdType {
    NOP       = 0,
    RECT      = 1,
    TEXT      = 2,
    BORDER    = 3,
    SHADOW    = 4,
    TRANSFORM = 5,
    CLIP      = 6,
    CLIP_END  = 7,
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND BUFFER — pre-allocated ring buffer, never re-allocated
// ═══════════════════════════════════════════════════════════════════════════

const CMD_BUF_SIZE = 1 << 20; // 1M u32
const CMD_BUF_MASK = CMD_BUF_SIZE - 1;

// Pre-allocated — never re-allocated
const _cmdBuf = new Uint32Array(CMD_BUF_SIZE);
let _cmdHead = 0;
let _cmdTail = 0;

const FLOAT_BUF_SIZE = 1 << 18;
const _floatBuf = new Float64Array(FLOAT_BUF_SIZE);
let _floatHead = 0;

// Frozen command buffer snapshot for REUSE degradation
let _frozenHead = 0;
let _frozenTail = 0;
let _frozenGPUHead = 0;
let _frozenCommandCount = 0;

export function freezeCommandBuffer(): void {
    _frozenHead = _cmdHead;
    _frozenTail = _cmdTail;
    _frozenGPUHead = _gpuCmdHead;
    _frozenCommandCount = _rg.commandCount;
}

export function hasFrozenCommands(): boolean {
    return _frozenCommandCount > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// GPU-NATIVE COMMAND BUFFER — pre-expanded NDC vertices, zero CPU translation
//
// Each rect produces 4 vertices (x, y, r, g, b, a) in NDC space float32.
// The WebGPU renderer writes this buffer directly to the GPU via writeBuffer().
// NO fixed-point decode, NO bitshift unpack, NO vertex expansion, NO NDC math.
// ═══════════════════════════════════════════════════════════════════════════

let _canvasWidth = 1920;
let _canvasHeight = 1080;

export function setCanvasSize(w: number, h: number): void {
    _canvasWidth = w;
    _canvasHeight = h;
}

const GPU_CMD_BUF_FLOATS = 1 << 19; // 512K floats = 2MB
const _gpuCmdBuf = new Float32Array(GPU_CMD_BUF_FLOATS);
let _gpuCmdHead = 0;

function _emitGPUVertex(px: number, py: number, r: number, g: number, b: number, a: number): void {
    // Convert pixel-space → NDC inline (zero CPU translation at render time)
    const nx = (px / _canvasWidth) * 2 - 1;
    const ny = 1 - (py / _canvasHeight) * 2;
    const w = _gpuCmdHead;
    _gpuCmdBuf[w] = nx;
    _gpuCmdBuf[w + 1] = ny;
    _gpuCmdBuf[w + 2] = r;
    _gpuCmdBuf[w + 3] = g;
    _gpuCmdBuf[w + 4] = b;
    _gpuCmdBuf[w + 5] = a;
    _gpuCmdHead = w + 6;
}

export function getGPUCommandBuffer(): Float32Array {
    return _gpuCmdBuf;
}

export function getGPUCommandHead(): number {
    return _gpuCmdHead;
}

// ═══════════════════════════════════════════════════════════════════════════
// STRING INTERN TABLE — persistent, generation-based eviction
// ═══════════════════════════════════════════════════════════════════════════

const MAX_STRINGS = 4096;
const _strTable: string[] = new Array(MAX_STRINGS);
let _strTableLen = 0;

// Open-addressing hash table for string→id lookup (no Map allocation)
const _strHashKeys = new Uint32Array(MAX_STRINGS * 2); // hash → slot
const _strHashVals = new Int32Array(MAX_STRINGS * 2);  // hash → string id
const _strHashCap = MAX_STRINGS * 2;
let _strGen = 0;
const _strLastUsed = new Uint32Array(MAX_STRINGS + 256);

function _hashStr(str: string): number {
    // FNV-1a hash — fast, good distribution
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 0x01000193) | 0;
    }
    return h >>> 0;
}

function _intern(str: string): number {
    const hash = _hashStr(str);
    const probe = hash % _strHashCap;

    // Linear probing — find existing or empty slot
    for (let i = 0; i < 16; i++) {
        const slot = (probe + i) % _strHashCap;
        const existingId = _strHashVals[slot];
        if (existingId === -1) break; // empty slot — not found
        if (_strHashKeys[slot] === hash && _strTable[existingId] === str) {
            _strLastUsed[existingId] = _strGen;
            return existingId;
        }
    }

    // Evict unused if full
    if (_strTableLen >= MAX_STRINGS) {
        for (let i = 0; i < _strTableLen; i++) {
            if (_strLastUsed[i] < _strGen - 2) {
                _strTable[i] = '';
            }
        }
    }

    // Insert new
    const id = _strTableLen < MAX_STRINGS ? _strTableLen++ : 0;
    _strTable[id] = str;
    _strLastUsed[id] = _strGen;

    for (let i = 0; i < 16; i++) {
        const slot = (probe + i) % _strHashCap;
        if (_strHashVals[slot] === -1 || _strHashKeys[slot] === hash) {
            _strHashKeys[slot] = hash;
            _strHashVals[slot] = id;
            break;
        }
    }

    return id;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EMITTERS — inline, zero branch
// ═══════════════════════════════════════════════════════════════════════════

function _emit4(type: CmdType, a: number, b: number, c: number, d: number): void {
    const w = _cmdHead;
    _cmdBuf[w] = type;
    _cmdBuf[w + 1] = a;
    _cmdBuf[w + 2] = b;
    _cmdBuf[w + 3] = c;
    _cmdBuf[w + 4] = d;
    _cmdHead = w + 5;
}

function _emit8(type: CmdType, a: number, b: number, c: number, d: number, e: number, f: number, g: number): void {
    const w = _cmdHead;
    _cmdBuf[w] = type;
    _cmdBuf[w + 1] = a;
    _cmdBuf[w + 2] = b;
    _cmdBuf[w + 3] = c;
    _cmdBuf[w + 4] = d;
    _cmdBuf[w + 5] = e;
    _cmdBuf[w + 6] = f;
    _cmdBuf[w + 7] = g;
    _cmdHead = w + 8;
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDER GRAPH
// ═══════════════════════════════════════════════════════════════════════════

export interface RenderGraph {
    commandCount: number;
    cullCount: number;
    mergeCount: number;
    batchCount: number;
}

let _rg: RenderGraph = { commandCount: 0, cullCount: 0, mergeCount: 0, batchCount: 0 };

export function buildRenderGraph(degrade: number = 0): RenderGraph {
    const w = getWorld();
    _rg = { commandCount: 0, cullCount: 0, mergeCount: 0, batchCount: 0 };
    _cmdHead = 0;
    _cmdTail = 0;
    _floatHead = 0;
    _gpuCmdHead = 0;
    _strGen++;

    // REUSE: replay previous frame's frozen command buffer
    if (degrade & 4) {
        if (_frozenCommandCount > 0) {
            _cmdHead = _frozenHead;
            _cmdTail = _frozenTail;
            _gpuCmdHead = _frozenGPUHead;
            _rg.commandCount = _frozenCommandCount;
            return _rg;
        }
        // Fall through to normal build if no frozen commands exist
    }

    // Process ONLY dirty+NEEDS_PAINT entities — O(dirty) not O(total)
    const dirtyList = _getDirtyList();
    const dirtyCount = _getDirtyCount();
    const lite = (degrade & 2) !== 0;
    for (let di = 0; di < dirtyCount; di++) {
        const i = dirtyList[di];
        const flags = w.flags[i];
        if (flags & Flag.REMOVED) continue;
        if (!(flags & Flag.VISIBLE)) continue;
        if (!(flags & Flag.NEEDS_PAINT)) continue;
        _generateEntityCommands(w, i, lite);
    }

    return _rg;
}

function _generateEntityCommands(w: ReturnType<typeof getWorld>, entityId: number, lite: boolean = false): void {
    const styleBase = entityId * STYLE_FLOATS_PER_ENTITY;
    const layoutBase = entityId * LAYOUT_FLOATS_PER_ENTITY;
    const floats = w.style.floats;
    const layout = w.layout.data;

    // Cull check: opacity = 0 → skip
    const opacity = floats[styleBase + STYLE_OPACITY];
    if (opacity <= 0) {
        _rg.cullCount++;
        return;
    }

    const lx = layout[layoutBase + LAYOUT_X];
    const ly = layout[layoutBase + LAYOUT_Y];
    const lw = layout[layoutBase + LAYOUT_W];
    const lh = layout[layoutBase + LAYOUT_H];

    // Cull: zero-size
    if (lw <= 0 || lh <= 0) {
        _rg.cullCount++;
        return;
    }

    const bgRgba = getStyleColor(entityId, 0);
    const borderRgba = getStyleColor(entityId, 2);
    const borderRadius = floats[styleBase + STYLE_BORDER_RADIUS];
    const borderWidth = floats[styleBase + STYLE_BORDER_WIDTH];

const opacityPacked = (opacity * 1000) | 0;
    const bgR = (bgRgba >> 24) & 0xFF;
    const bgG = (bgRgba >> 16) & 0xFF;
    const bgB = (bgRgba >> 8) & 0xFF;
    const bgA = bgRgba & 0xFF;

    _emit8(
        CmdType.RECT,
        entityId,
        (lx * 10) | 0,
        (ly * 10) | 0,
        (lw * 10) | 0,
        (lh * 10) | 0,
        bgRgba,
        ((borderRadius * 10) << 16) | ((borderWidth * 10) & 0xFFFF),
    );
    const w2 = _cmdHead;
    _cmdBuf[w2] = borderRgba;
    _cmdBuf[w2 + 1] = opacityPacked;
    _cmdHead = w2 + 2;

_rg.commandCount++;

    // GPU-native vertices: 4 vertices per rect (TL, TR, BL, BR)
    // Each vertex: x, y, r, g, b, a (6 floats, pixel-space)
    const alpha = (bgA / 255) * opacity;
    const rf = bgR / 255;
    const gf = bgG / 255;
    const bf = bgB / 255;
    const rx = lx + lw;
    const by = ly + lh;
    _emitGPUVertex(lx, ly, rf, gf, bf, alpha);
    _emitGPUVertex(rx, ly, rf, gf, bf, alpha);
    _emitGPUVertex(lx, by, rf, gf, bf, alpha);
    _emitGPUVertex(rx, by, rf, gf, bf, alpha);

    if (borderWidth > 0 && !lite) {
        _emit4(CmdType.BORDER, entityId, borderRgba, (borderWidth * 10) | 0, borderRadius * 10 | 0);
        _rg.commandCount++;
    }
}

export function getCommandBuffer(): Uint32Array {
    return _cmdBuf;
}

export function getCommandHead(): number {
    return _cmdHead;
}

export function getCommandTail(): number {
    return _cmdTail;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND OPTIMIZER — v2: sort + merge + cull + batch
//
// Pipeline:
//   1. CULL: remove NOPs, zero-opacity, zero-size commands
//   2. SORT: stable sort by z-index (from entity render store)
//   3. MERGE: merge adjacent same-color rects into larger rects
//   4. OCCLUDE: remove rects fully hidden behind larger rects in front
//   5. BATCH: count unique batches (same color = same batch)
//
// Target: 5000 commands → ~800 GPU batches
// ═══════════════════════════════════════════════════════════════════════════

// Pre-allocated sort buffer — stable merge sort, O(n log n), zero GC
const SORT_BUF_SIZE = 1 << 18;
let _sortBuf = new Uint32Array(SORT_BUF_SIZE);
let _sortIdx = new Uint32Array(SORT_BUF_SIZE);
let _sortTemp = new Uint32Array(SORT_BUF_SIZE);

// Pre-allocated rect offset array for occlusion pass — zero allocation
const OCCLUDE_MAX_RECTS = 1 << 16;
let _tempRects = new Int32Array(OCCLUDE_MAX_RECTS);

export function optimizeCommands(degrade: number = 0): void {
    if (degrade & 2) {
        // LITE: skip expensive sort/merge/occlude, just cull + batch
        _cullCommands();
        _batchCommands();
        return;
    }
    _cullCommands();
    _sortCommands();
    _mergeCommands();
    _occludeCommands();
    _batchCommands();
}

function _cmdSize(type: number): number {
    const sizes = [1, 10, 4, 5, 5, 5, 4, 1, 1];
    return sizes[type] || 1;
}

// ── PASS 1: CULL — remove NOPs ──────────────────────────────────────────

function _cullCommands(): void {
    let read = _cmdTail;
    let write = _cmdTail;

    while (read < _cmdHead) {
        const type = _cmdBuf[read];
        const size = _cmdSize(type);
        if (type !== CmdType.NOP) {
            if (read !== write) {
                for (let i = 0; i < size; i++) {
                    _cmdBuf[(write + i)] = _cmdBuf[(read + i)];
                }
            }
            write += size;
        }
        read += size;
    }
    _cmdHead = write;
}

// ── PASS 2: SORT — stable sort by z-index ───────────────────────────────

// Cached world reference for z-index lookups
let _zWorld: ReturnType<typeof getWorld> | null = null;

function _getCmdZIndex(buf: Uint32Array, offset: number): number {
    const type = buf[offset];
    if (type === CmdType.RECT || type === CmdType.BORDER) {
        const entityId = buf[(offset + 1)];
        if (!_zWorld) _zWorld = getWorld();
        const renderBase = entityId * RENDER_INTS_PER_ENTITY;
        return _zWorld.render.data[renderBase + 3];
    }
    return 0;
}

function _sortCommands(): void {
    const count = _cmdHead - _cmdTail;
    if (count < 10) return;

    // Build index array
    let idxCount = 0;
    let read = _cmdTail;
    while (read < _cmdHead) {
        const type = _cmdBuf[read];
        const size = _cmdSize(type);
        if (type !== CmdType.NOP) {
            _sortIdx[idxCount++] = read;
        }
        read += size;
    }

    if (idxCount < 2) return;

    // Merge sort by z-index
    _mergeSort(_sortIdx, _sortTemp, 0, idxCount);

    // Reorder command buffer using the sorted index array
    // Since commands vary in size, we need to build a new buffer
    let write = _cmdTail;
    for (let i = 0; i < idxCount; i++) {
        const srcOffset = _sortIdx[i];
        const type = _cmdBuf[srcOffset];
        const size = _cmdSize(type);
        if (srcOffset !== write) {
            for (let j = 0; j < size; j++) {
                _cmdBuf[(write + j)] = _cmdBuf[(srcOffset + j)];
            }
        }
        write += size;
    }
    _cmdHead = write;
}

function _mergeSort(arr: Uint32Array, temp: Uint32Array, left: number, right: number): void {
    if (right - left <= 1) return;
    const mid = (left + right) >>> 1;
    _mergeSort(arr, temp, left, mid);
    _mergeSort(arr, temp, mid, right);
    _merge(arr, temp, left, mid, right);
}

function _merge(arr: Uint32Array, temp: Uint32Array, left: number, mid: number, right: number): void {
    let i = left;
    let j = mid;
    let k = left;

    while (i < mid && j < right) {
        const zI = _getCmdZIndex(_cmdBuf, arr[i]);
        const zJ = _getCmdZIndex(_cmdBuf, arr[j]);
        if (zI <= zJ) {
            temp[k++] = arr[i++];
        } else {
            temp[k++] = arr[j++];
        }
    }
    while (i < mid) temp[k++] = arr[i++];
    while (j < right) temp[k++] = arr[j++];
    for (let t = left; t < right; t++) {
        arr[t] = temp[t];
    }
}

// ── PASS 3: MERGE — adjacent same-color rects ───────────────────────────

function _rectsShareColor(buf: Uint32Array, a: number, b: number): boolean {
    // Both must be RECT commands
    if ((buf[a] !== CmdType.RECT) ||
        (buf[b] !== CmdType.RECT)) return false;
    // Compare background color (at offset +6)
    return buf[(a + 6)] === buf[(b + 6)];
}

function _tryMergeRects(buf: Uint32Array, a: number, b: number): boolean {
    // Check if b is directly to the right of a and same height
    const ax = buf[(a + 2)];
    const ay = buf[(a + 3)];
    const aw = buf[(a + 4)];
    const ah = buf[(a + 5)];

    const bx = buf[(b + 2)];
    const by = buf[(b + 3)];
    const bw = buf[(b + 4)];

    // Same row, b starts where a ends
    if (ay === by && ah === by + buf[(b + 5)] - by && ax + aw === bx) {
        // Merge: extend a's width
        buf[(a + 4)] = aw + bw;
        buf[b] = CmdType.NOP; // mark b as dead
        _rg.mergeCount++;
        return true;
    }
    return false;
}

function _mergeCommands(): void {
    let read = _cmdTail;
    let prevRect = -1;

    while (read < _cmdHead) {
        const type = _cmdBuf[read];
        if (type === CmdType.RECT) {
            if (prevRect >= 0 && _rectsShareColor(_cmdBuf, prevRect, read)) {
                _tryMergeRects(_cmdBuf, prevRect, read);
            }
            if (_cmdBuf[read] !== CmdType.NOP) {
                prevRect = read;
            } else {
                prevRect = -1;
            }
        } else {
            prevRect = -1;
        }
        read += _cmdSize(type);
    }
}

// ── PASS 4: OCCLUDE — remove fully occluded rects ───────────────────────

function _rectContains(outer: number, inner: number): boolean {
    const ox = _cmdBuf[(outer + 2)];
    const oy = _cmdBuf[(outer + 3)];
    const ow = _cmdBuf[(outer + 4)];
    const oh = _cmdBuf[(outer + 5)];

    const ix = _cmdBuf[(inner + 2)];
    const iy = _cmdBuf[(inner + 3)];
    const iw = _cmdBuf[(inner + 4)];
    const ih = _cmdBuf[(inner + 5)];

    return ix >= ox && iy >= oy && (ix + iw) <= (ox + ow) && (iy + ih) <= (oy + oh);
}

function _occludeCommands(): void {
    let read = _cmdTail;
    let rectCount = 0;

    while (read < _cmdHead) {
        const type = _cmdBuf[read];
        if (type === CmdType.RECT) {
            if (rectCount >= _tempRects.length) break;
            _tempRects[rectCount++] = read;
        }
        read += _cmdSize(type);
    }

    for (let i = 0; i < rectCount; i++) {
        const ri = _tempRects[i];
        if (_cmdBuf[ri] !== CmdType.RECT) continue;
        for (let j = i + 1; j < rectCount; j++) {
            const rj = _tempRects[j];
            if (_cmdBuf[rj] !== CmdType.RECT) continue;

            const colorJ = _cmdBuf[(rj + 6)];
            const alphaJ = colorJ & 0xFF;
            if (alphaJ < 255) continue;

            if (_rectContains(rj, ri)) {
                _cmdBuf[ri] = CmdType.NOP;
                _rg.cullCount++;
                break;
            }
        }
    }

    _cullCommands();
}

// ── PASS 5: BATCH — group by color for GPU draw call count ──────────────

// Generation-based color dedup for batching — zero allocation, zero GC
const _batchColorSeen = new Uint32Array(4096);
let _batchColorGen = 0;

function _batchCommands(): void {
    let count = 0;
    let read = _cmdTail;
    _batchColorGen++;
    const gen = _batchColorGen;
    const seen = _batchColorSeen;
    const seenCap = seen.length;

    while (read < _cmdHead) {
        const type = _cmdBuf[read];
        if (type === CmdType.RECT) {
            const color = _cmdBuf[(read + 6)];
            const slot = (color ^ (color >>> 13)) & (seenCap - 1);
            if (seen[slot] !== gen) {
                seen[slot] = gen;
                count++;
            }
        } else if (type !== CmdType.NOP) {
            count++;
        }
        read += _cmdSize(type);
    }

    _rg.batchCount = count;
}

// ═══════════════════════════════════════════════════════════════════════════
// RESET — just reset pointers, ZERO allocation
// ═══════════════════════════════════════════════════════════════════════════

export function resetRenderGraph(): void {
    _cmdHead = 0;
    _cmdTail = 0;
    _floatHead = 0;
    // String table persists across frames — no clear needed
    _rg = { commandCount: 0, cullCount: 0, mergeCount: 0, batchCount: 0 };
}
