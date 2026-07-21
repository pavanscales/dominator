type Subscriber = () => void;

// ── Core flat arrays (SoA layout for cache-line friendliness) ───────────
let _values: unknown[] = [];
let _subs: number[][] = [];
let _manualSubs: Subscriber[][] = [];
let _effectFns: (() => void)[] = [];
let _effectDeps: number[][] = [];
let _effectGen: Int32Array = new Int32Array(256);
let _effectRunning: Uint8Array = new Uint8Array(256);
let _effectDisposed: Uint8Array = new Uint8Array(256);
let _activeEffect = -1;

// ── Batching ───────────────────────────────────────────────────────────
let _batchDepth = 0;
let _flushGen = 0;

// ── Dirty tracking: 64K bitmap covers virtually all apps ───────────────
const BITMAP_SIZE = 65536;
let _dirtyBitmap: Uint8Array = new Uint8Array(BITMAP_SIZE);
let _dirtyBufA: Int32Array = new Int32Array(1024);
let _dirtyBufB: Int32Array = new Int32Array(1024);
let _dirtyBuf = _dirtyBufA;
let _dirtyCount = 0;

// ── Fallback dirty set for IDs >= 64K (extremely rare) ─────────────────
let _overflowDirty: number[] | null = null;

// ── Snapshot buffer (avoids .slice() allocation on every flush) ─────────
let _snapBuf: number[] = new Array(256);
let _snapLen = 0;

// ── Dep array pool (reuses arrays to avoid GC) ────────────────────────
const _depPool: number[][] = [];
const _DEP_POOL_MAX = 4096;

// ── Limits ─────────────────────────────────────────────────────────────
const MAX_EFFECTS_WARN = 100_000;
const MAX_SIGNALS_WARN = 1_000_000;
let _effectWarned = false;
let _signalWarned = false;

export interface Signal<T> {
    (): T;
    get(): T;
    set(value: T): void;
    update(fn: (prev: T) => T): void;
    subscribe(fn: Subscriber): () => void;
    readonly _id: number;
}

export const signal = <T>(initialValue: T): Signal<T> => {
    const id = _values.length;
    if (id >= MAX_SIGNALS_WARN && !_signalWarned && typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        _signalWarned = true;
        console.warn(`[dominator] Signal count exceeded ${MAX_SIGNALS_WARN}. Consider cleanup.`);
    }
    _values.push(initialValue);
    _subs.push([]);
    _manualSubs.push([]);

    const s = (() => {
        if (_activeEffect >= 0) {
            _subs[id].push(_activeEffect);
            _effectDeps[_activeEffect].push(id);
        }
        return _values[id] as T;
    }) as Signal<T>;

    (s as { _id: number })._id = id;

    s.get = () => _values[id] as T;

    s.set = (newValue: T) => {
        if (_values[id] !== newValue) {
            _values[id] = newValue;
            if (_batchDepth > 0) {
                _markDirty(id);
            } else {
                _flushSignalNonBatched(id);
            }
        }
    };

    s.update = (fn: (prev: T) => T) => {
        s.set(fn(_values[id] as T));
    };

    s.subscribe = (fn: Subscriber) => {
        _manualSubs[id].push(fn);
        return () => {
            const arr = _manualSubs[id];
            const idx = arr.indexOf(fn);
            if (idx >= 0) {
                arr[idx] = arr[arr.length - 1]!;
                arr.length--;
            }
        };
    };

    return s;
};

// ── Dirty marking: bitmap for 0-64K, overflow array for >= 64K ─────────
function _markDirty(id: number): void {
    if (id < BITMAP_SIZE) {
        if (!_dirtyBitmap[id]) {
            _dirtyBitmap[id] = 1;
            if (_dirtyCount < _dirtyBuf.length) {
                _dirtyBuf[_dirtyCount++] = id;
            } else {
                const newBuf = new Int32Array(_dirtyBuf.length * 2);
                newBuf.set(_dirtyBuf.subarray(0, _dirtyCount));
                _dirtyBuf = newBuf;
                _dirtyBuf[_dirtyCount++] = id;
            }
        }
    } else {
        if (!_overflowDirty) _overflowDirty = [];
        if (_overflowDirty.indexOf(id) === -1) {
            _overflowDirty.push(id);
        }
    }
}

// ── Non-batched flush (single signal, no batch context) ────────────────
function _flushSignalNonBatched(id: number): void {
    const subs = _subs[id];
    const len = subs.length;
    for (let i = 0; i < len; i++) {
        _runEffectNonBatched(subs[i]);
    }
    const manual = _manualSubs[id];
    const mLen = manual.length;
    for (let i = 0; i < mLen; i++) {
        manual[i]();
    }
}

function _runEffectNonBatched(id: number): void {
    if (_effectRunning[id]) return;
    if (id >= _effectDisposed.length || _effectDisposed[id]) return;

    // Clean up old deps
    const oldDeps = _effectDeps[id];
    const oldLen = oldDeps.length;
    for (let i = 0; i < oldLen; i++) {
        const depId = oldDeps[i];
        if (depId < _subs.length) {
            _removeSub(_subs[depId], id);
        }
    }
    _effectDeps[id] = _acquireDepArray();

    _effectRunning[id] = 1;
    const prev = _activeEffect;
    _activeEffect = id;
    _effectFns[id]();
    _activeEffect = prev;
    _effectRunning[id] = 0;
}

// ── Batched flush (shared gen counter, no re-entrancy bitmap needed) ───
function _runEffect(id: number): void {
    if (_effectGen[id] === _flushGen) return;
    if (id >= _effectDisposed.length || _effectDisposed[id]) return;
    _effectGen[id] = _flushGen;

    const oldDeps = _effectDeps[id];
    const oldLen = oldDeps.length;
    for (let i = 0; i < oldLen; i++) {
        const depId = oldDeps[i];
        if (depId < _subs.length) {
            _removeSub(_subs[depId], id);
        }
    }
    _effectDeps[id] = _acquireDepArray();

    const prev = _activeEffect;
    _activeEffect = id;
    _effectFns[id]();
    _activeEffect = prev;
}

function _removeSub(signalSubs: number[], effectId: number): void {
    const len = signalSubs.length;
    if (len === 1) {
        if (signalSubs[0] === effectId) signalSubs.length = 0;
        return;
    }
    if (len === 2) {
        if (signalSubs[0] === effectId) { signalSubs[0] = signalSubs[1]; signalSubs.length = 1; return; }
        if (signalSubs[1] === effectId) { signalSubs.length = 1; return; }
        return;
    }
    const idx = signalSubs.indexOf(effectId);
    if (idx >= 0) {
        signalSubs[idx] = signalSubs[len - 1]!;
        signalSubs.length--;
    }
}

// ── Dep array pooling ──────────────────────────────────────────────────
function _acquireDepArray(): number[] {
    return _depPool.length > 0 ? _depPool.pop()! : [];
}

function _releaseDepArray(arr: number[]): void {
    if (arr.length > 0 && _depPool.length < _DEP_POOL_MAX) {
        arr.length = 0;
        _depPool.push(arr);
    }
}

// ── Effect creation ────────────────────────────────────────────────────
export interface EffectScope {
    dispose(): void;
}

export const effect = (fn: Subscriber): EffectScope => {
    const id = _effectFns.length;

    // Grow disposed bitmap
    if (id >= _effectDisposed.length) {
        const newSize = Math.max(_effectDisposed.length * 2, 512);
        _effectDisposed = _growUint8(_effectDisposed, newSize);
    }
    // Grow running bitmap
    if (id >= _effectRunning.length) {
        _effectRunning = _growUint8(_effectRunning, Math.max(_effectRunning.length * 2, 512));
    }
    // Grow gen array
    if (id >= _effectGen.length) {
        _effectGen = _growInt32(_effectGen, Math.max(_effectGen.length * 2, 512));
    }

    if (id >= MAX_EFFECTS_WARN && !_effectWarned && typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        _effectWarned = true;
        console.warn(`[dominator] Effect count exceeded ${MAX_EFFECTS_WARN}. Consider cleanup.`);
    }

    _effectFns.push(fn);
    _effectDeps.push([]);
    _effectGen[id] = -1;
    _runEffect(id);

    return {
        dispose() {
            _effectDisposed[id] = 1;
            const deps = _effectDeps[id];
            const len = deps.length;
            for (let i = 0; i < len; i++) {
                const depId = deps[i];
                if (depId < _subs.length) {
                    _removeSub(_subs[depId], id);
                }
            }
            _releaseDepArray(_effectDeps[id]);
            _effectDeps[id] = [];
        },
    };
};

export const computed = <T>(fn: () => T): (() => T) => {
    const s = signal<T>(undefined as unknown as T);
    effect(() => { s.set(fn()); });
    return s;
};

export const batch = (fn: () => void): void => {
    _batchDepth++;
    fn();
    _batchDepth--;
    if (_batchDepth === 0 && _dirtyCount > 0) {
        _drainDirty();
    }
};

// ── Drain: swap buffers instead of copy+clear ──────────────────────────
function _drainDirty(): void {
    _flushGen++;

    // Swap dirty buffers: iterate the current one, receive new dirties in the other
    const currentBuf = _dirtyBuf;
    const currentCount = _dirtyCount;
    _dirtyBuf = _dirtyBuf === _dirtyBufA ? _dirtyBufB : _dirtyBufA;
    _dirtyCount = 0;

    // Clear bitmap for current batch
    for (let i = 0; i < currentCount; i++) {
        const sid = currentBuf[i];
        if (sid < BITMAP_SIZE) _dirtyBitmap[sid] = 0;
    }

    // Flush all signals from the swapped buffer
    for (let i = 0; i < currentCount; i++) {
        _flushSignal(currentBuf[i]);
    }

    // Flush overflow dirty set
    if (_overflowDirty) {
        const ov = _overflowDirty;
        _overflowDirty = null;
        for (let i = 0; i < ov.length; i++) {
            _flushSignal(ov[i]);
        }
    }
}

function _flushSignal(id: number): void {
    if (id >= _subs.length) return;

    // Snapshot subs inline (avoid .slice() allocation)
    const subs = _subs[id];
    const len = subs.length;
    if (len > _snapBuf.length) {
        _snapBuf = new Array(len * 2);
    }
    for (let i = 0; i < len; i++) _snapBuf[i] = subs[i];
    _snapLen = len;

    for (let i = 0; i < _snapLen; i++) {
        _runEffect(_snapBuf[i]);
    }

    if (id < _manualSubs.length) {
        const manual = _manualSubs[id];
        const mLen = manual.length;
        for (let i = 0; i < mLen; i++) {
            manual[i]();
        }
    }
}

export const flushSync = (): void => {
    if (_batchDepth === 0 && _dirtyCount > 0) {
        _drainDirty();
    }
};

// ── Reset (test only) ─────────────────────────────────────────────────
export const _resetSignals = (): void => {
    _values = [];
    _subs = [];
    _manualSubs = [];
    _effectFns = [];
    _effectDeps = [];
    _effectGen = new Int32Array(256);
    _effectRunning = new Uint8Array(256);
    _effectDisposed = new Uint8Array(256);
    _activeEffect = -1;
    _batchDepth = 0;
    _flushGen = 0;
    _dirtyBitmap = new Uint8Array(BITMAP_SIZE);
    _dirtyBufA = new Int32Array(1024);
    _dirtyBufB = new Int32Array(1024);
    _dirtyBuf = _dirtyBufA;
    _dirtyCount = 0;
    _overflowDirty = null;
    _snapBuf = new Array(256);
    _snapLen = 0;
    _depPool.length = 0;
    _effectWarned = false;
    _signalWarned = false;
};

// ── Introspection ──────────────────────────────────────────────────────
export const getSignalCount = (): number => _values.length;
export const getEffectCount = (): number => _effectFns.length;

// ── Helpers ────────────────────────────────────────────────────────────
function _growUint8(arr: Uint8Array, newSize: number): Uint8Array {
    const next = new Uint8Array(newSize);
    next.set(arr);
    return next;
}

function _growInt32(arr: Int32Array, newSize: number): Int32Array {
    const next = new Int32Array(newSize);
    next.set(arr);
    return next;
}
