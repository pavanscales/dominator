/**
 * Arena: Thin TypeScript wrapper around Zig WASM arena allocator.
 *
 * v5 optimizations:
 * - Zero-copy string reads (subarray instead of slice)
 * - Bounded object tracking (cleanup old mappings on write)
 * - Cached tag view with dirty flag
 */

import {
    getCore, getF64View, getU8View, getU32View,
    TAG_START, TAG_NUMBER, TAG_STRING, TAG_BOOLEAN, TAG_OBJECT,
    writeStringToWasm,
} from './wasm-glue';

// JS object map with cleanup
const _objectMap = new Map<number, unknown>();
const _objectReverseMap = new Map<unknown, number>();
let _nextObjectId = 0;

// String change detection
const _slotStringMap = new Map<number, string>();

const _decoder = new TextDecoder('utf-8', { fatal: false });

// Cached tag view
let _cachedTagView: Uint8Array | null = null;
let _cachedTagViewSize = -1;
let _tagViewDirty = true;

// Reusable buffer for medium strings (< 4KB)
const _strBuf = new Uint8Array(4096);

export { TAG_NUMBER, TAG_STRING, TAG_BOOLEAN, TAG_OBJECT };

export const arenaSize = (): number => getCore().arena_size();
export const arenaCapacity = (): number => getCore().arena_capacity();

export function arenaCompact(liveBitmap: Uint32Array): number {
    const core = getCore();
    const u8 = getU8View();
    u8.set(new Uint8Array(liveBitmap.buffer, liveBitmap.byteOffset, liveBitmap.byteLength), 55808 * 4);
    _tagViewDirty = true;
    return core.arena_compact(55808);
}

export function arenaAllocNum(value: number): number {
    _tagViewDirty = true;
    return getCore().arena_alloc_num(value);
}

export function arenaAllocStr(value: string): number {
    _tagViewDirty = true;
    const core = getCore();
    const { ptr, len } = writeStringToWasm(value);
    const id = core.arena_alloc_str(ptr, len);
    _slotStringMap.set(id, value);
    return id;
}

export function arenaAllocBool(value: boolean): number {
    _tagViewDirty = true;
    return getCore().arena_alloc_bool(value ? 1 : 0);
}

export function arenaAllocObj(value: unknown): number {
    _tagViewDirty = true;
    let objectId = _objectReverseMap.get(value);
    if (objectId === undefined) {
        objectId = _nextObjectId++;
        _objectMap.set(objectId, value);
        _objectReverseMap.set(value, objectId);
    }
    return getCore().arena_alloc_obj(objectId);
}

export function arenaReadNum(id: number): number {
    return getCore().arena_read_num(id);
}

export function arenaReadStr(id: number): string {
    const tracked = _slotStringMap.get(id);
    if (tracked !== undefined) return tracked;

    const core = getCore();
    const u8 = getU8View();
    const u32 = getU32View();

    const stringId = Math.trunc(core.arena_read_num(id));
    const metaBase = 16384 + stringId * 2;
    const wordOffset = u32[metaBase];
    const byteLen = u32[metaBase + 1];

    const byteStart = wordOffset * 4;

    // Zero-copy: decode directly from WASM memory subarray
    if (byteLen <= _strBuf.length) {
        const view = u8.subarray(byteStart, byteStart + byteLen);
        return _decoder.decode(view);
    }

    // Large string: slice only what's needed
    const bytes = u8.slice(byteStart, byteStart + byteLen);
    return _decoder.decode(bytes);
}

export function arenaReadBool(id: number): boolean {
    return getCore().arena_read_bool(id) === 1;
}

export function arenaReadObj(id: number): unknown {
    const objectId = Math.trunc(getCore().arena_read_num(id));
    return _objectMap.get(objectId);
}

export function arenaReadTag(id: number): number {
    return getCore().arena_read_tag(id);
}

export function arenaWriteNum(id: number, value: number): boolean {
    return getCore().arena_write_num(id, value) === 1;
}

export function arenaWriteStr(id: number, value: string): boolean {
    const oldValue = _slotStringMap.get(id);
    if (oldValue === value) return false;
    _slotStringMap.set(id, value);
    const core = getCore();
    const { ptr, len } = writeStringToWasm(value);
    const newStrId = core.arena_alloc_str(ptr, len);
    core.arena_write_num(id, newStrId);
    return true;
}

export function arenaWriteBool(id: number, value: boolean): boolean {
    return getCore().arena_write_bool(id, value ? 1 : 0) === 1;
}

export function arenaWriteObj(id: number, value: unknown): boolean {
    const oldObjectId = Math.trunc(getCore().arena_read_num(id));
    if (oldObjectId !== -1) {
        const oldObj = _objectMap.get(oldObjectId);
        if (oldObj === value) return false;
        // Clean up old reverse mapping
        if (oldObj !== undefined) {
            _objectReverseMap.delete(oldObj);
        }
    }
    let newObjectId = _objectReverseMap.get(value);
    if (newObjectId === undefined) {
        newObjectId = _nextObjectId++;
        _objectMap.set(newObjectId, value);
        _objectReverseMap.set(value, newObjectId);
    }
    return getCore().arena_write_obj(id, newObjectId) === 1;
}

export function arenaWriteRaw(id: number, value: unknown): boolean {
    const tag = arenaReadTag(id);
    switch (tag) {
        case TAG_NUMBER: return arenaWriteNum(id, value as number);
        case TAG_STRING: return arenaWriteStr(id, value as string);
        case TAG_BOOLEAN: return arenaWriteBool(id, value as boolean);
        case TAG_OBJECT: return arenaWriteObj(id, value);
        default: return false;
    }
}

export function arenaReadRaw(id: number): unknown {
    const tag = arenaReadTag(id);
    switch (tag) {
        case TAG_NUMBER: return arenaReadNum(id);
        case TAG_STRING: return arenaReadStr(id);
        case TAG_BOOLEAN: return arenaReadBool(id);
        case TAG_OBJECT: return arenaReadObj(id);
        default: return undefined;
    }
}

export function arenaReset(): void {
    getCore().arena_reset();
    _objectMap.clear();
    _objectReverseMap.clear();
    _nextObjectId = 0;
    _slotStringMap.clear();
    _tagViewDirty = true;
    _cachedTagView = null;
    _cachedTagViewSize = -1;
}

export function arenaGetNumView(): Float64Array {
    return getF64View();
}

export function arenaGetTagView(): Uint8Array {
    if (!_tagViewDirty && _cachedTagView !== null) {
        return _cachedTagView;
    }
    const u8 = getU8View();
    const size = arenaSize();
    if (!_cachedTagView || _cachedTagView.length !== size) {
        _cachedTagView = new Uint8Array(size);
    }
    const byteBase = TAG_START * 4;
    for (let i = 0; i < size; i++) {
        _cachedTagView[i] = u8[byteBase + i * 4];
    }
    _cachedTagViewSize = size;
    _tagViewDirty = false;
    return _cachedTagView;
}
