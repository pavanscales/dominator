/**
 * Arena: Thin TypeScript wrapper around Zig WASM arena allocator.
 *
 * v6:
 * - Strings are JS-backed (real WASM slot + JS value map): no WASM string
 *   alloc, no memcpyAlias panic, no per-write leak
 * - Bounded object tracking (cleanup old mappings on write)
 * - Cached tag view with dirty flag
 */

import {
    getCore, getF64View, getU8View,
    TAG_START, TAG_NUMBER, TAG_STRING, TAG_BOOLEAN, TAG_OBJECT,
} from './wasm-glue';

// JS object map with cleanup
const _objectMap = new Map<number, unknown>();
const _objectReverseMap = new Map<unknown, number>();
let _nextObjectId = 0;

// String storage (JS-backed: slot id → string value)
const _slotStringMap = new Map<number, string>();

// Cached tag view
let _cachedTagView: Uint8Array | null = null;
let _tagViewDirty = true;

export { TAG_NUMBER, TAG_STRING, TAG_BOOLEAN, TAG_OBJECT };

export const arenaSize = (): number => getCore().arena_size();

const SNAPSHOT_WORD_INDEX = 55808; // WASM snapshot buffer word index

export function arenaCompact(liveBitmap: Uint32Array): number {
    // arena_compact remaps WASM slot ids, but the JS maps and any live signal
    // ids are keyed by the ORIGINAL ids. Compaction therefore corrupts those
    // references. It is only safe at idle/reset — refuse otherwise rather than
    // silently aliasing live data.
    if (_slotStringMap.size > 0 || _objectMap.size > 0) {
        throw new Error(
            'arenaCompact(): unsafe while string/object values are live — signals or ' +
            'objects still hold WASM ids that compaction would remap'
        );
    }
    const core = getCore();
    const u8 = getU8View();
    u8.set(new Uint8Array(liveBitmap.buffer, liveBitmap.byteOffset, liveBitmap.byteLength), SNAPSHOT_WORD_INDEX * 4);
    _tagViewDirty = true;
    return core.arena_compact(SNAPSHOT_WORD_INDEX);
}

export function arenaAllocNum(value: number): number {
    _tagViewDirty = true;
    return getCore().arena_alloc_num(value);
}

// String storage is fully JS-backed: a real WASM arena slot is consumed (so
// arenaSize()/tags stay consistent) but the string bytes never touch WASM.
// The old path staged bytes at DYNAMIC_START and copied them into the arena
// string region that starts at the SAME address — the first alloc self-copied
// and hit Zig's memcpyAlias trap ("unreachable"). It also leaked a new WASM
// string on every write. JS-backing fixes both.
export function arenaAllocStr(value: string): number {
    _tagViewDirty = true;
    const id = getCore().arena_alloc_num(0);
    getU8View()[TAG_START * 4 + id * 4] = TAG_STRING;
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
    return '';
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
        // Clean up old forward mapping to prevent memory leak
        _objectMap.delete(oldObjectId);
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
    _tagViewDirty = false;
    return _cachedTagView;
}
