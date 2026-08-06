/**
 * SubsFlat: Now fully absorbed into the Zig WASM module.
 * This file re-exports the Zig-backed implementations for backwards compatibility.
 *
 * All subscriber storage (flat, bit-packed) lives in WASM linear memory.
 * TypeScript only calls through to the Zig exports.
 */

import { getCore, getU32View, SNAPSHOT_BUF_START } from './wasm-glue';

export function subsInit(signalId: number): void {
    getCore().subs_init(signalId);
}

export function subsAdd(signalId: number, effectId: number): void {
    getCore().subs_add(signalId, effectId);
}

export function subsRemove(signalId: number, effectId: number): void {
    getCore().subs_remove(signalId, effectId);
}

export function subsGetLength(signalId: number): number {
    return getCore().subs_get_length(signalId);
}

export function subsGetAt(signalId: number, index: number): number {
    return getCore().subs_get_at(signalId, index);
}

export function subsForEach(signalId: number, fn: (effectId: number) => void): void {
    const len = getCore().subs_get_length(signalId);
    for (let i = 0; i < len; i++) {
        fn(getCore().subs_get_at(signalId, i));
    }
}

export function subsSnapshotInto(signalId: number, target: Uint32Array, maxLen: number): number {
    const len = getCore().subs_snapshot(signalId, maxLen);
    if (len > 0) {
        const snapStart = SNAPSHOT_BUF_START;
        const u32 = getU32View();
        for (let i = 0; i < len && i < target.length; i++) {
            target[i] = u32[snapStart + i];
        }
    }
    return len;
}

export function subsReset(): void {
    getCore().full_reset();
}
