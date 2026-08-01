/**
 * Dominator Reactive Engine — BARE METAL EDITION (v6)
 *
 * Architecture: JS owns EVERYTHING on the hot path. WASM owns only arena allocation.
 *
 * BARE METAL OPTIMIZATIONS (v6):
 * - Flat Int32Array subscriber storage per signal (contiguous, cache-friendly)
 * - Flat Int32Array dependency storage per effect (contiguous, cache-friendly)
 * - Per-signal _lastTrackGen for O(1) fast-path dedup in _trackSignal
 *   (eliminates linked-list traversal for all but the first signal read per effect run)
 * - ZERO WASM calls on signal.set() hot path
 * - Generation-based batch dedup
 * - Pre-sized arrays with exponential growth, swap-with-last removal
 */

import {
    getCore,
    getU32View,
    getF64View,
    onViewRefresh,
} from './wasm-glue';

import {
    arenaAllocNum, arenaAllocStr, arenaAllocObj,
    arenaReadStr, arenaReadObj, arenaReadBool,
    arenaWriteStr, arenaWriteObj, arenaWriteBool,
    TAG_NUMBER, TAG_STRING, TAG_OBJECT,
} from './arena';

import { drainCmdBuffer, cmdBufferPending, _resetCmdBuffer } from './dom-cmd';

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL — flat storage, zero allocation
// ═══════════════════════════════════════════════════════════════════════════

type Subscriber = () => void;

let _core: ReturnType<typeof getCore>;
let _u32!: Uint32Array;
let _f64: Float64Array;
let _initialized = false;
let _viewRefreshRegistered = false;

function _rebindViews(): void {
    _u32 = getU32View();
    _f64 = getF64View();
}

function _ensureCore(): void {
    if (_initialized) return;
    _core = getCore();
    _rebindViews();
    if (!_viewRefreshRegistered) {
        onViewRefresh(_rebindViews);
        _viewRefreshRegistered = true;
    }
    _initialized = true;
}

// ═══════════════════════════════════════════════════════════════════════════
// DIRECT-EFFECT SIGNALS — BARE METAL v8
//
// For the 90% case (1 subscriber), store the effect callback DIRECTLY on
// the signal, bypassing subscriber arrays AND the effect dispatch system.
// signal.set() → _f64[fid]=val → _directEff[fid]() 
// That's 3 array ops + 1 function call vs 7+ ops + 3 function calls in v7.
// ═══════════════════════════════════════════════════════════════════════════

let _directEff: (() => void)[] = new Array(2048);
let _directEffFirst: Int32Array = new Int32Array(2048); // effect ID for clean dep tracking

function _ensureDirectEff(id: number): void {
    if (id < _directEff.length) return;
    const oldLen = _directEff.length;
    const newLen = Math.max(id + 512, oldLen * 2);
    const ne = new Array(newLen);
    const nf = new Int32Array(newLen);
    nf.fill(-1, oldLen);
    for (let i = 0; i < oldLen; i++) ne[i] = _directEff[i];
    nf.set(_directEffFirst.subarray(0, oldLen));
    _directEff = ne;
    _directEffFirst = nf;
}

function _setDirectEff(sigId: number, effId: number, fn: () => void): void {
    _ensureDirectEff(sigId);
    _directEff[sigId] = fn;
    _directEffFirst[sigId] = effId;
}

function _clearDirectEff(sigId: number): void {
    _directEff[sigId] = undefined as any;
    _directEffFirst[sigId] = -1;
}

let _subFirst: Int32Array = new Int32Array(2048);
let _subsPtr: Int32Array = new Int32Array(2048);
let _subsLen: Uint8Array = new Uint8Array(2048);
let _subsCap: Uint8Array = new Uint8Array(2048);
let _subsData: Int32Array = new Int32Array(4096);
let _subsDataTop = 0;
const SUBS_GROW = 8;

// Fast-path dedup: last track generation per signal
let _lastTrackGen: Uint32Array = new Uint32Array(2048);
let _subGen = 0;
let _subsDataCap = 4096;

function _ensureSubs(signalId: number): void {
    if (signalId < _subsPtr.length) return;
    const old = _subsPtr.length;
    const newLen = Math.max(signalId + 512, old * 2);
    const nf = new Int32Array(newLen);
    const np = new Int32Array(newLen);
    const nl = new Uint8Array(newLen);
    const nc = new Uint8Array(newLen);
    const nt = new Uint32Array(newLen);
    nf.fill(-1, old);
    np.fill(-1, old);
    nf.set(_subFirst.subarray(0, old));
    np.set(_subsPtr);
    nl.set(_subsLen);
    nc.set(_subsCap);
    nt.set(_lastTrackGen);
    _subFirst = nf;
    _subsPtr = np;
    _subsLen = nl;
    _subsCap = nc;
    _lastTrackGen = nt;
}

function _ensureSubsData(needed: number): void {
    if (needed < _subsDataCap) return;
    const newCap = Math.max(needed * 2, _subsDataCap * 2);
    const nd = new Int32Array(newCap);
    nd.set(_subsData);
    _subsData = nd;
    _subsDataCap = newCap;
}

function _addSub(sigId: number, effId: number): void {
    const ptr = _subsPtr[sigId];
    let len = _subsLen[sigId];
    let cap = _subsCap[sigId];

    // DIRECT EFFECT: store callback inline for single-subscriber case
    const fn = _effectFns[effId];
    if (len === 0 && _directEff[sigId] === undefined) {
        _setDirectEff(sigId, effId, fn);
        return;
    }

    // First subscriber was direct — migrate to flat array
    if (len === 0 && _directEff[sigId] !== undefined) {
        const firstEffId = _directEffFirst[sigId];
        const newPtr = _subsDataTop;
        _ensureSubsData(newPtr + SUBS_GROW);
        _subsData[newPtr] = firstEffId;
        _subsData[newPtr + 1] = effId;
        _subFirst[sigId] = firstEffId;
        _subsPtr[sigId] = newPtr;
        _subsLen[sigId] = 2;
        _subsCap[sigId] = SUBS_GROW;
        _subsDataTop = newPtr + SUBS_GROW;
        _clearDirectEff(sigId);
        return;
    }

    if (cap === 0) {
        // First allocation — store in inline slot + _subsData
        const newPtr = _subsDataTop;
        _ensureSubsData(newPtr + SUBS_GROW);
        _subsData[newPtr] = effId;
        _subFirst[sigId] = effId;  // INLINE: cache first subscriber
        _subsPtr[sigId] = newPtr;
        _subsLen[sigId] = 1;
        _subsCap[sigId] = SUBS_GROW;
        _subsDataTop = newPtr + SUBS_GROW;
        return;
    }

    if (len < cap) {
        _subsData[ptr + len] = effId;
        _subsLen[sigId] = len + 1;
        return;
    }

    // Grow: allocate new block, copy
    const newCap = cap + SUBS_GROW;
    const newPtr = _subsDataTop;
    _ensureSubsData(newPtr + newCap);
    let j = 0;
    while (j < len) {
        _subsData[newPtr + j] = _subsData[ptr + j];
        j++;
    }
    _subsData[newPtr + len] = effId;
    _subFirst[sigId] = _subsData[newPtr];  // INLINE: update first subscriber
    _subsPtr[sigId] = newPtr;
    _subsLen[sigId] = len + 1;
    _subsCap[sigId] = newCap;
    _subsDataTop = newPtr + newCap;
}

function _removeSub(sigId: number, effId: number): void {
    // Check direct effect first (90% case — single subscriber)
    if (_directEff[sigId] !== undefined && _directEffFirst[sigId] === effId) {
        _clearDirectEff(sigId);
        _subFirst[sigId] = -1;
        return;
    }

    // Flat subscriber array
    const ptr = _subsPtr[sigId];
    const len = _subsLen[sigId];
    const data = _subsData;
    for (let i = 0; i < len; i++) {
        if (data[ptr + i] === effId) {
            data[ptr + i] = data[ptr + len - 1];
            const newLen = len - 1;
            _subsLen[sigId] = newLen;
            if (newLen === 0) {
                _subFirst[sigId] = -1;
            } else {
                _subFirst[sigId] = data[ptr];
            }
            return;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// FLAT DEPENDENCY STORAGE — per effect
//
// _effDepsPtr[effId] = start index in _effDepsData
// _effDepsLen[effId] = current dep count
// _effDepsCap[effId] = allocated capacity
// ═══════════════════════════════════════════════════════════════════════════

let _effDepsPtr: Int32Array = new Int32Array(4096);
let _effDepsLen: Uint8Array = new Uint8Array(4096);
let _effDepsCap: Uint8Array = new Uint8Array(4096);
let _effDepsData: Int32Array = new Int32Array(4096);
let _effDepsTop = 0;
const DEPS_GROW = 4;
let _effDepsDataCap = 4096;

function _ensureEff(effId: number): void {
    if (effId < _effDepsPtr.length) return;
    const old = _effDepsPtr.length;
    const newLen = Math.max(effId + 512, old * 2);
    const np = new Int32Array(newLen);
    const nl = new Uint8Array(newLen);
    const nc = new Uint8Array(newLen);
    np.fill(-1, old);
    np.set(_effDepsPtr);
    nl.set(_effDepsLen);
    nc.set(_effDepsCap);
    _effDepsPtr = np;
    _effDepsLen = nl;
    _effDepsCap = nc;
}

function _ensureDepData(needed: number): void {
    if (needed < _effDepsDataCap) return;
    const newCap = Math.max(needed * 2, _effDepsDataCap * 2);
    const nd = new Int32Array(newCap);
    nd.set(_effDepsData);
    _effDepsData = nd;
    _effDepsDataCap = newCap;
}

function _addDep(effId: number, sigId: number): void {
    const ptr = _effDepsPtr[effId];
    let len = _effDepsLen[effId];
    let cap = _effDepsCap[effId];

    if (cap === 0) {
        const newPtr = _effDepsTop;
        _ensureDepData(newPtr + DEPS_GROW);
        _effDepsData[newPtr] = sigId;
        _effDepsPtr[effId] = newPtr;
        _effDepsLen[effId] = 1;
        _effDepsCap[effId] = DEPS_GROW;
        _effDepsTop = newPtr + DEPS_GROW;
        return;
    }

    if (len < cap) {
        _effDepsData[ptr + len] = sigId;
        _effDepsLen[effId] = len + 1;
        return;
    }

    const newCap = cap + DEPS_GROW;
    const newPtr = _effDepsTop;
    _ensureDepData(newPtr + newCap);
    let j = 0;
    while (j < len) {
        _effDepsData[newPtr + j] = _effDepsData[ptr + j];
        j++;
    }
    _effDepsData[newPtr + len] = sigId;
    _effDepsPtr[effId] = newPtr;
    _effDepsLen[effId] = len + 1;
    _effDepsCap[effId] = newCap;
    _effDepsTop = newPtr + newCap;
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL TAG CACHE
// ═══════════════════════════════════════════════════════════════════════════

let _signalTags = new Uint8Array(4096);
let _tagCap = 4096;

function _ensureTagCap(id: number): void {
    if (id < _tagCap) return;
    let newCap = _tagCap;
    while (newCap <= id) newCap *= 2;
    const newTags = new Uint8Array(newCap);
    newTags.set(_signalTags.subarray(0, _tagCap));
    _signalTags = newTags;
    _tagCap = newCap;
}

// ═══════════════════════════════════════════════════════════════════════════
// JS-SIDE DIRTY BITMAP
// ═══════════════════════════════════════════════════════════════════════════

const _JS_BITMAP_WORDS = 2048;
let _jsDirtyBitmap = new Uint32Array(_JS_BITMAP_WORDS);
let _jsDirtyList = new Int32Array(8192);
let _jsDirtyCount = 0;
let _jsBatchDepth = 0;
let _jsMaxDirtyWord = 0;

function _jsMarkDirty(id: number): void {
    const word = id >>> 5;
    if (word >= _jsDirtyBitmap.length) {
        let newLen = _jsDirtyBitmap.length;
        while (newLen <= word) newLen *= 2;
        const nb = new Uint32Array(newLen);
        nb.set(_jsDirtyBitmap);
        _jsDirtyBitmap = nb;
    }
    if (_jsDirtyCount >= _jsDirtyList.length) {
        const nl = new Int32Array(_jsDirtyList.length * 2);
        nl.set(_jsDirtyList);
        _jsDirtyList = nl;
    }
    const mask = 1 << (id & 31);
    const wasClean = (_jsDirtyBitmap[word] & mask) === 0;
    _jsDirtyBitmap[word] |= mask;
    if (word > _jsMaxDirtyWord) _jsMaxDirtyWord = word;
    if (wasClean) {
        _jsDirtyList[_jsDirtyCount++] = id;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// BATCH DEDUP
// ═══════════════════════════════════════════════════════════════════════════

let _batchGen = 0;
let _batchSeenGen = new Uint32Array(8192);

// ═══════════════════════════════════════════════════════════════════════════
// EFFECT STATE
// ═══════════════════════════════════════════════════════════════════════════

let _effectFns: (() => void)[] = new Array(4096);
let _effectDisposed = new Uint8Array(4096);
let _effectCount = 0;
let _activeEffect = -1;
let _jsEffectCounter = 0;

let _manualSubOffsets: Int32Array = new Int32Array(4096);
let _manualSubLens: Uint8Array = new Uint8Array(4096);
let _manualSubFns: Subscriber[] = new Array(16384);
let _manualSubDataLen = 0;
let _manualSubCap = 4096;

// ═══════════════════════════════════════════════════════════════════════════
// LIMITS
// ═══════════════════════════════════════════════════════════════════════════

const MAX_EFFECTS_WARN = 100_000;
const MAX_SIGNALS_WARN = 1_000_000;
let _effectWarned = false;
let _signalWarned = false;
let _signalCount = 0;

function _ensureEffects(id: number): void {
    if (id < _effectFns.length) return;
    const oldLen = _effectFns.length;
    const newSize = oldLen < 65536 ? oldLen * 2 : oldLen + 16384;
    const capped = Math.max(newSize, id + 256);
    _effectFns.length = capped;
    const newDisposed = new Uint8Array(capped);
    newDisposed.set(_effectDisposed.subarray(0, oldLen));
    _effectDisposed = newDisposed;

    if (capped > _batchSeenGen.length) {
        const ns = new Uint32Array(capped);
        ns.set(_batchSeenGen.subarray(0, _batchSeenGen.length));
        _batchSeenGen = ns;
    }
    if (capped > _dirtyEffBuf.length) {
        _dirtyEffBuf = new Int32Array(capped);
    }
}

function _ensureManualSubSlots(id: number): void {
    if (id < _manualSubCap) return;
    let newCap = _manualSubCap;
    while (newCap <= id) newCap *= 2;
    const newOffsets = new Int32Array(newCap);
    const newLens = new Uint8Array(newCap);
    newOffsets.set(_manualSubOffsets.subarray(0, _manualSubCap));
    newLens.set(_manualSubLens.subarray(0, _manualSubCap));
    _manualSubOffsets = newOffsets;
    _manualSubLens = newLens;
    _manualSubCap = newCap;
}

function _ensureManualSubFns(needed: number): void {
    if (needed <= _manualSubFns.length) return;
    _manualSubFns.length = Math.max(needed, _manualSubFns.length * 2);
}

// ═══════════════════════════════════════════════════════════════════════════
// GENERATION-BASED TRACKING (v6)
//
// _trackSignal(signalId):
//   1. if _lastTrackGen[signalId] === _subGen → ALREADY SUBBED (O(1) fast path)
//   2. Scan flat subscriber array for effId → if found, update gen, return
//   3. Not found → _addSub + _addDep, set _lastTrackGen[signalId] = _subGen
//
// _jsClearDeps(effId):
//   1. Iterate flat dep array, for each dep call _removeSub
//   2. Reset _effDepsLen[effId] = 0
// ═══════════════════════════════════════════════════════════════════════════

function _trackSignal(signalId: number): void {
    const effId = _activeEffect;
    if (effId < 0) return;

    // Fast path: already tracked this generation — O(1), no scan
    if (_lastTrackGen[signalId] === _subGen) return;

    _ensureSubs(signalId);

    // Linear scan of flat subscriber array (cache-friendly)
    const ptr = _subsPtr[signalId];
    const len = _subsLen[signalId];
    const data = _subsData;
    if (ptr >= 0) {
        for (let i = 0; i < len; i++) {
            if (data[ptr + i] === effId) {
                _lastTrackGen[signalId] = _subGen;
                return;
            }
        }
    }

    // New subscription
    _addSub(signalId, effId);
    _addDep(effId, signalId);
    _lastTrackGen[signalId] = _subGen;
}

function _jsClearDeps(effId: number): void {
    const ptr = _effDepsPtr[effId];
    const len = _effDepsLen[effId];
    if (len === 0) return;
    _effDepsLen[effId] = 0;

    const data = _effDepsData;
    for (let i = 0; i < len; i++) {
        _removeSub(data[ptr + i], effId);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// EFFECT EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

function _runEffect(id: number): void {
    if (_effectDisposed[id]) return;
    _subGen++;
    _jsClearDeps(id);
    _activeEffect = id;
    _effectFns[id]();
    _activeEffect = -1;
}

function _runEffectList(ids: number[], count: number): void {
    if (count <= 0) return;
    _batchGen++;
    const gen = _batchGen;
    const seen = _batchSeenGen;

    for (let i = 0; i < count; i++) {
        const eid = ids[i];
        if (seen[eid] !== gen) {
            seen[eid] = gen;
            _runEffect(eid);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DIRTY PROPAGATION
// ═══════════════════════════════════════════════════════════════════════════

let _dirtyEffBuf = new Int32Array(2048);

function _syncDirty(): void {
    const count = _jsDirtyCount;
    if (count === 0) return;
    const list = _jsDirtyList;
    _jsDirtyCount = 0;
    _jsDirtyBitmap.fill(0, 0, _jsMaxDirtyWord + 1);
    _jsMaxDirtyWord = 0;

    _batchGen++;
    const gen = _batchGen;
    const seen = _batchSeenGen;
    let effCount = 0;
    const effBuf = _dirtyEffBuf;

    for (let i = 0; i < count; i++) {
        const sigId = list[i];
        if (sigId >= _subsPtr.length) continue;

        // Check direct effect first — _subsPtr is -1 for direct-effect signals
        const dirFn = _directEff[sigId];
        if (dirFn !== undefined) {
            const effId = _directEffFirst[sigId];
            if (effId >= 0 && seen[effId] !== gen) {
                seen[effId] = gen;
                effBuf[effCount++] = effId;
            }
            continue;
        }

        const ptr = _subsPtr[sigId];
        const len = _subsLen[sigId];
        if (ptr < 0 || len === 0) continue;
        const data = _subsData;
        for (let j = 0; j < len; j++) {
            const effId = data[ptr + j];
            if (seen[effId] !== gen) {
                seen[effId] = gen;
                effBuf[effCount++] = effId;
            }
        }
    }

    for (let i = 0; i < effCount; i++) {
        _runEffect(effBuf[i]);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL API
// ═══════════════════════════════════════════════════════════════════════════

export interface Signal<T> {
    (): T;
    get(): T;
    set(value: T): void;
    update(fn: (prev: T) => T): void;
    subscribe(fn: Subscriber): () => void;
    readonly _id: number;
}

export const signal = <T>(initialValue: T): Signal<T> => {
    _ensureCore();
    const id = _signalCount++;

    if (id >= MAX_SIGNALS_WARN && !_signalWarned && typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        _signalWarned = true;
        console.warn(`[dominator] Signal count exceeded ${MAX_SIGNALS_WARN}. Consider cleanup.`);
    }

    const tag = typeof initialValue === 'number' ? TAG_NUMBER
        : typeof initialValue === 'string' ? TAG_STRING
            : TAG_OBJECT;

    _ensureTagCap(id);
    _signalTags[id] = tag;

    if (tag === TAG_NUMBER) {
        arenaAllocNum(initialValue as number);
    } else if (tag === TAG_STRING) {
        arenaAllocStr(initialValue as string);
    } else {
        arenaAllocObj(initialValue);
    }

    _core.subs_init(id);
    _ensureSubs(id);
    _subsPtr[id] = -1;
    _ensureManualSubSlots(id);

    let getter: () => T;
    let getterTracked: () => T;

    if (tag === TAG_NUMBER) {
        const fid = id;
        getter = () => _f64[fid] as T;
        getterTracked = () => { _trackSignal(fid); return _f64[fid] as T; };
    } else {
        const nid = id;
        const ntag = tag;
        getter = () => _readNonNumber(nid, ntag) as T;
        getterTracked = () => { _trackSignal(nid); return _readNonNumber(nid, ntag) as T; };
    }

    const s = (() => {
        if (_activeEffect >= 0) {
            return getterTracked();
        }
        return getter();
    }) as Signal<T>;

    (s as { _id: number })._id = id;
    s.get = getter;

    // ── BARE METAL SIGNAL SETTER (v8) ──
    //
    // Direct-effect path: for 90% of signals with 1 subscriber,
    //   _directEff[fid]() bypasses subscriber arrays AND effect dispatch.
    //   Total: 3 array ops + 1 function call (was 7+ ops + 3 calls in v7)
    //
    if (tag === TAG_NUMBER) {
        const fid = id;
        s.set = (newValue: T) => {
            const val = newValue as number;
            const old = _f64[fid];
            if (old === val) return;
            _f64[fid] = val;

            if (_jsBatchDepth === 0) {
                // DIRECT EFFECT PATH: run through _runEffect to preserve dep tracking
                const firstEff = _directEffFirst[fid];
                if (firstEff >= 0) {
                    _runEffect(firstEff);
                } else {
                    // Fallback: flat subscriber array
                    const first = _subFirst[fid];
                    if (first >= 0) {
                        const len = _subsLen[fid];
                        if (len === 1) {
                            _runEffect(first);
                        } else if (len === 2) {
                            // 2-subscriber fast path: no batch gen, no dedup array, just 2 calls
                            const ptr = _subsPtr[fid];
                            const data = _subsData;
                            _runEffect(data[ptr]);
                            _runEffect(data[ptr + 1]);
                        } else {
                            const ptr = _subsPtr[fid];
                            const data = _subsData;
                            _batchGen++;
                            const gen = _batchGen;
                            const seen = _batchSeenGen;
                            for (let i = 0; i < len; i++) {
                                const effId = data[ptr + i];
                                if (seen[effId] !== gen) {
                                    seen[effId] = gen;
                                    _runEffect(effId);
                                }
                            }
                        }
                    }
                }
            } else {
                _jsMarkDirty(fid);
            }

            const mLen = _manualSubLens[fid];
            if (mLen > 0) {
                const mOffset = _manualSubOffsets[fid];
                for (let i = 0; i < mLen; i++) {
                    _manualSubFns[mOffset + i]();
                }
            }
        };
    } else {
        s.set = (newValue: T) => {
            let changed = false;

            if (tag === TAG_STRING) {
                changed = arenaWriteStr(id, newValue as string);
            } else if (tag === TAG_OBJECT) {
                changed = arenaWriteObj(id, newValue);
            } else {
                changed = arenaWriteBool(id, newValue as boolean);
            }

            if (!changed) return;

            if (_jsBatchDepth === 0) {
                const firstEff = _directEffFirst[id];
                if (firstEff >= 0) {
                    _runEffect(firstEff);
                } else {
                    const first = _subFirst[id];
                    if (first >= 0) {
                        const len = _subsLen[id];
                        if (len === 1) {
                            _runEffect(first);
                        } else if (len === 2) {
                            const ptr = _subsPtr[id];
                            const data = _subsData;
                            _runEffect(data[ptr]);
                            _runEffect(data[ptr + 1]);
                        } else {
                            const ptr = _subsPtr[id];
                            const data = _subsData;
                            _batchGen++;
                            const gen = _batchGen;
                            const seen = _batchSeenGen;
                            for (let i = 0; i < len; i++) {
                                const effId = data[ptr + i];
                                if (seen[effId] !== gen) {
                                    seen[effId] = gen;
                                    _runEffect(effId);
                                }
                            }
                        }
                    }
                }
            } else {
                _jsMarkDirty(id);
            }

            const mLen = _manualSubLens[id];
            if (mLen > 0) {
                const mOffset = _manualSubOffsets[id];
                for (let i = 0; i < mLen; i++) {
                    _manualSubFns[mOffset + i]();
                }
            }
        };
    }

    s.update = (fn: (prev: T) => T) => {
        s.set(fn(s.get()));
    };

    s.subscribe = (fn: Subscriber) => {
        _ensureManualSubSlots(id);
        const len = _manualSubLens[id];
        const offset = _manualSubOffsets[id];

        if (len === 0) {
            const newOffset = _manualSubDataLen;
            _manualSubOffsets[id] = newOffset;
            _manualSubDataLen += 4;
            _ensureManualSubFns(_manualSubDataLen);
            _manualSubFns[newOffset] = fn;
            _manualSubLens[id] = 1;
        } else {
            const totalSlots = offset + len;
            if (totalSlots >= _manualSubDataLen) {
                const newOffset = _manualSubDataLen;
                for (let i = 0; i < len; i++) {
                    _manualSubFns[newOffset + i] = _manualSubFns[offset + i];
                }
                _manualSubOffsets[id] = newOffset;
                _manualSubDataLen = newOffset + len + 4;
                _ensureManualSubFns(_manualSubDataLen);
                _manualSubFns[newOffset + len] = fn;
                _manualSubLens[id] = len + 1;
            } else {
                _manualSubFns[totalSlots] = fn;
                _manualSubLens[id] = len + 1;
            }
        }

        return () => {
            const curLen = _manualSubLens[id];
            const curOffset = _manualSubOffsets[id];
            for (let i = 0; i < curLen; i++) {
                if (_manualSubFns[curOffset + i] === fn) {
                    _manualSubFns[curOffset + i] = _manualSubFns[curOffset + curLen - 1];
                    _manualSubFns[curOffset + curLen - 1] = undefined as any;
                    _manualSubLens[id] = curLen - 1;
                    return;
                }
            }
        };
    };

    return s;
};

function _readNonNumber(id: number, tag: number): unknown {
    if (tag === TAG_STRING) return arenaReadStr(id);
    if (tag === TAG_OBJECT) return arenaReadObj(id);
    return arenaReadBool(id);
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

export interface EffectScope {
    dispose(): void;
}

export const effect = (fn: Subscriber): EffectScope => {
    _ensureCore();

    // ═══════════════════════════════════════════════════════════════════
    // EFFECT: direct subscriber dispatch, zero graph overhead
    // ═══════════════════════════════════════════════════════════════════
    const id = _jsEffectCounter++;
    _effectCount = Math.max(_effectCount, id + 1);
    _ensureEffects(id);
    _ensureEff(id);
    _effDepsPtr[id] = -1;

    if (id >= MAX_EFFECTS_WARN && !_effectWarned && typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        _effectWarned = true;
        console.warn(`[dominator] Effect count exceeded ${MAX_EFFECTS_WARN}. Consider cleanup.`);
    }

    _effectFns[id] = fn;
    _runEffect(id);

    return {
        dispose() {
            _jsClearDeps(id);
            _effectDisposed[id] = 1;
        },
    };
};

export const computed = <T>(fn: () => T): (() => T) => {
    const s = signal<T>(undefined as unknown as T);
    effect(() => { batch(() => { s.set(fn()); }); });
    return s;
};

export const batch = (fn: () => void): void => {
    _ensureCore();
    _jsBatchDepth++;
    fn();
    _jsBatchDepth--;

    if (_jsBatchDepth === 0 && _jsDirtyCount > 0) {
        _syncDirty();
    }

    if (cmdBufferPending()) {
        drainCmdBuffer();
    }
};

export const flushSync = (): void => {
    _ensureCore();
    if (_jsDirtyCount > 0) {
        _syncDirty();
    }
    if (cmdBufferPending()) {
        drainCmdBuffer();
    }
};

export const _resetSignals = (): void => {
    getCore().full_reset();
    _initialized = false;
    _ensureCore();
    _effectFns = new Array(4096);
    _effectDisposed = new Uint8Array(4096);
    _effectCount = 0;
    _activeEffect = -1;
    _manualSubOffsets = new Int32Array(4096);
    _manualSubLens = new Uint8Array(4096);
    _manualSubFns = new Array(16384);
    _manualSubDataLen = 0;
    _manualSubCap = 4096;
    _signalCount = 0;
    _effectWarned = false;
    _signalWarned = false;
    _batchGen = 0;
    _subGen = 0;
    _batchSeenGen = new Uint32Array(8192);
    _jsDirtyBitmap = new Uint32Array(_JS_BITMAP_WORDS);
    _jsDirtyList = new Int32Array(8192);
    _jsDirtyCount = 0;
    _jsBatchDepth = 0;
    _jsMaxDirtyWord = 0;
    _dirtyEffBuf = new Int32Array(2048);
    // Direct-effect storage (v8)
    _directEff = new Array(2048);
    _directEffFirst = new Int32Array(2048);
    _directEffFirst.fill(-1);
    // Flat subscriber storage
    _subFirst = new Int32Array(2048);
    _subFirst.fill(-1);
    _subsPtr = new Int32Array(2048);
    _subsPtr.fill(-1);
    _subsLen = new Uint8Array(2048);
    _subsCap = new Uint8Array(2048);
    _subsData = new Int32Array(4096);
    _subsDataTop = 0;
    _subsDataCap = 4096;
    _lastTrackGen = new Uint32Array(2048);
    // Flat effect dep storage
    _effDepsPtr = new Int32Array(4096);
    _effDepsPtr.fill(-1);
    _effDepsLen = new Uint8Array(4096);
    _effDepsCap = new Uint8Array(4096);
    _effDepsData = new Int32Array(4096);
    _effDepsTop = 0;
    _effDepsDataCap = 4096;
    _resetCmdBuffer();
};

export const getSignalCount = (): number => _signalCount;
export const getEffectCount = (): number => _effectCount;

// ═══════════════════════════════════════════════════════════════════════════
// TYPED SIGNAL ARRAYS
// ═══════════════════════════════════════════════════════════════════════════

export interface SignalArray {
    get(i: number): number;
    set(i: number, value: number): void;
    getValues(): Float64Array;
    setValues(values: Float32Array | Float64Array | number[]): void;
    readonly length: number;
    readonly baseId: number;
}

export function signalArray(count: number, initialValue: number = 0): SignalArray {
    _ensureCore();
    const baseId = _signalCount;

    for (let i = 0; i < count; i++) {
        const id = _signalCount++;
        _ensureTagCap(id);
        _signalTags[id] = TAG_NUMBER;
        arenaAllocNum(initialValue);
        _core.subs_init(id);
        _ensureSubs(id);
        _subsPtr[id] = -1;
        _ensureManualSubSlots(id);
    }

    return {
        get length() { return count; },
        baseId,

        get(i: number): number {
            return _f64[baseId + i];
        },

        set(i: number, value: number): void {
            const id = baseId + i;
            const old = _f64[id];
            if (old === value) return;
            _f64[id] = value;

            if (_jsBatchDepth === 0) {
                const firstEff = _directEffFirst[id];
                if (firstEff >= 0) {
                    _runEffect(firstEff);
                } else {
                    const first = _subFirst[id];
                    if (first >= 0) {
                        const len = _subsLen[id];
                        if (len === 1) {
                            _runEffect(first);
                        } else if (len === 2) {
                            const ptr = _subsPtr[id];
                            const data = _subsData;
                            _runEffect(data[ptr]);
                            _runEffect(data[ptr + 1]);
                        } else {
                            const ptr = _subsPtr[id];
                            const data = _subsData;
                            _batchGen++;
                            const gen = _batchGen;
                            const seen = _batchSeenGen;
                            for (let j = 0; j < len; j++) {
                                const effId = data[ptr + j];
                                if (seen[effId] !== gen) {
                                    seen[effId] = gen;
                                    _runEffect(effId);
                                }
                            }
                        }
                    }
                }
            } else {
                _jsMarkDirty(id);
            }

            const mLen = _manualSubLens[id];
            if (mLen > 0) {
                const mOffset = _manualSubOffsets[id];
                for (let j = 0; j < mLen; j++) {
                    _manualSubFns[mOffset + j]();
                }
            }
        },

        getValues(): Float64Array {
            return _f64.subarray(baseId, baseId + count);
        },

        setValues(values: Float32Array | Float64Array | number[]): void {
            const len = values.length < count ? values.length : count;

            _jsBatchDepth++;
            for (let i = 0; i < len; i++) {
                const id = baseId + i;
                const val = values[i];
                if (_f64[id] !== val) {
                    _f64[id] = val;
                    _jsMarkDirty(id);
                }
            }
            _jsBatchDepth--;

            if (_jsDirtyCount > 0) {
                _syncDirty();
            }
        },
    };
}
