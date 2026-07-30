/**
 * ReactiveWorker — runs in Web Worker context. (v2 — zero-latency wake)
 *
 * Offloads signal reactivity from the main thread:
 * - Signal creation, reading, writing
 * - Dependency tracking (signal → effect graph)
 * - Dirty propagation + effect scheduling
 *
 * Main thread ONLY runs effect callbacks + DOM mutations.
 * Signal values live in SharedArrayBuffer — zero-copy reads.
 *
 * v2 CHANGE: Replaced requestAnimationFrame loop with Atomics.wait/notify.
 * Worker sleeps until main thread sends commands (Atomics.notify).
 * Worker notifies main thread when effects are pending (Atomics.notify).
 * Latency: ~0 (wakes immediately on notify) vs ~16ms (rAF polling).
 *
 * MEMORY LAYOUT (SharedArrayBuffer):
 *   [0]         status: 0=idle, 1=ready, 2=effects_pending, 3=shutdown, 4=commands_ready
 *   [1]         batch_depth
 *   [2]         signal_count
 *   [3]         effect_count
 *   [4]         pending_effect_count
 *   [5]         tracking_effect_id (-1 = not tracking)
 *   [6]         frame_number
 *   [7]         command_queue_write_head
 *   [8]         command_queue_read_head
 *   [16..64]    reserved
 *   [64..64+N]  signal_values (f64 = 2 u32 words each)
 *   [64+N..]    effect disposed flags (u8 packed in u32)
 *   [64+N+E..]  pending effect IDs (u32)
 *   [64+N+E+P..] command queue (ring buffer)
 */

const STATUS_IDLE = 0;
const STATUS_READY = 1;
const STATUS_EFFECTS = 2;
const STATUS_SHUTDOWN = 3;
const STATUS_COMMANDS = 4;

const MAX_SIGNALS = 65536;
const MAX_EFFECTS = 4096;
const MAX_PENDING = 2048;
const SIGNAL_VALUES_OFFSET = 64;
const EFFECT_FLAGS_OFFSET = SIGNAL_VALUES_OFFSET + MAX_SIGNALS * 2;
const PENDING_OFFSET = EFFECT_FLAGS_OFFSET + MAX_EFFECTS;
const CMD_QUEUE_OFFSET = PENDING_OFFSET + MAX_PENDING;
const CMD_QUEUE_SIZE = 4096;
const CMD_QUEUE_MASK = CMD_QUEUE_SIZE - 1;

// Command opcodes (main thread → worker)
const CMD_SIGNAL_CREATE = 1;
const CMD_SIGNAL_SET = 2;
const CMD_EFFECT_CREATE = 3;
const CMD_EFFECT_BEGIN = 4;
const CMD_EFFECT_END = 5;
const CMD_EFFECT_DISPOSE = 6;
const CMD_SIGNAL_TRACK = 7;
const CMD_BATCH_BEGIN = 8;
const CMD_BATCH_END = 9;
const CMD_FLUSH = 10;

let _header: Int32Array;
let _shared: Uint32Array;
let _f64: Float64Array;
let _signalCount = 0;
let _effectCount = 0;
let _batchDepth = 0;

// Dependency graph (worker-local, not shared)
const _signalDeps: Set<number>[] = new Array(MAX_SIGNALS);
const _effectDeps: Set<number>[] = new Array(MAX_EFFECTS);
let _activeEffect = -1;

// Pending effect buffer (deduped)
const _pendingBuf = new Uint32Array(MAX_PENDING);
let _pendingCount = 0;

// Dirty signal buffer (double-buffered)
const _dirtyBufA = new Uint32Array(4096);
const _dirtyBufB = new Uint32Array(4096);
let _dirtyBuf = _dirtyBufA;
let _dirtyCount = 0;
let _dirtyWriteBuf = _dirtyBufA;

function _initDeps(i: number): void {
    if (!_signalDeps[i]) _signalDeps[i] = new Set();
    if (!_effectDeps[i]) _effectDeps[i] = new Set();
}

export function reactiveWorkerInit(
    header: Int32Array,
    sharedBuffer: SharedArrayBuffer
): void {
    _header = header;
    _shared = new Uint32Array(sharedBuffer);
    _f64 = new Float64Array(sharedBuffer);

    _shared[0] = STATUS_READY;
    Atomics.notify(_header, 0);

    // Enter event loop — sleep until commands arrive
    _sleepLoop();
}

function _sleepLoop(): void {
    while (true) {
        // Sleep until main thread notifies us (status changes to STATUS_COMMANDS)
        Atomics.wait(_header, 0, STATUS_READY);

        const status = _shared[0];
        if (status === STATUS_SHUTDOWN) return;

        // Process commands
        _processCommands();

        // Flush dirty signals → collect pending effects
        _flushDirty();

        // If effects are pending, wake main thread
        if (_pendingCount > 0) {
            _shared[4] = _pendingCount;
            _shared[0] = STATUS_EFFECTS;
            Atomics.notify(_header, 0);

            // Wait for main thread to consume effects (status changes back)
            Atomics.wait(_header, 0, STATUS_EFFECTS);

            // Reset pending count
            _pendingCount = 0;
            _shared[4] = 0;
        }

        // Go back to idle
        _shared[0] = STATUS_READY;
    }
}

function _processCommands(): void {
    let rh = _shared[8]; // cmd_queue_read_head
    const wh = _shared[7]; // cmd_queue_write_head

    while (rh !== wh) {
        const cmd = _shared[CMD_QUEUE_OFFSET + (rh & CMD_QUEUE_MASK)];
        rh++;

        switch (cmd) {
            case CMD_SIGNAL_CREATE: {
                const id = _shared[CMD_QUEUE_OFFSET + (rh & CMD_QUEUE_MASK)];
                rh++;
                _initDeps(id);
                _signalCount = Math.max(_signalCount, id + 1);
                _shared[2] = _signalCount;
                break;
            }
            case CMD_SIGNAL_SET: {
                const id = _shared[CMD_QUEUE_OFFSET + (rh & CMD_QUEUE_MASK)];
                rh++;
                const lo = _shared[CMD_QUEUE_OFFSET + (rh & CMD_QUEUE_MASK)];
                rh++;
                const hi = _shared[CMD_QUEUE_OFFSET + (rh & CMD_QUEUE_MASK)];
                rh++;

                // Decode f64 from two u32s (zero-alloc)
                const buf = new ArrayBuffer(8);
                new Uint32Array(buf)[0] = lo;
                new Uint32Array(buf)[1] = hi;
                const newVal = new Float64Array(buf)[0];

                const idx = (SIGNAL_VALUES_OFFSET / 2) + id;
                const oldVal = _f64[idx];
                _f64[idx] = newVal;

                if (oldVal !== newVal) {
                    // Propagate dirty — mark dependent effects
                    const deps = _signalDeps[id];
                    if (deps) {
                        for (const effId of deps) {
                            _addPending(effId);
                        }
                    }
                }
                break;
            }
            case CMD_EFFECT_CREATE: {
                const id = _shared[CMD_QUEUE_OFFSET + (rh & CMD_QUEUE_MASK)];
                rh++;
                _initDeps(id);
                _effectCount = Math.max(_effectCount, id + 1);
                _shared[3] = _effectCount;
                break;
            }
            case CMD_EFFECT_BEGIN: {
                const id = _shared[CMD_QUEUE_OFFSET + (rh & CMD_QUEUE_MASK)];
                rh++;
                _clearEffectDeps(id);
                _activeEffect = id;
                _shared[5] = id;
                break;
            }
            case CMD_EFFECT_END: {
                _activeEffect = -1;
                _shared[5] = -1;
                break;
            }
            case CMD_EFFECT_DISPOSE: {
                const id = _shared[CMD_QUEUE_OFFSET + (rh & CMD_QUEUE_MASK)];
                rh++;
                _clearEffectDeps(id);
                break;
            }
            case CMD_SIGNAL_TRACK: {
                const sigId = _shared[CMD_QUEUE_OFFSET + (rh & CMD_QUEUE_MASK)];
                rh++;
                if (_activeEffect >= 0) {
                    if (!_signalDeps[sigId]) _signalDeps[sigId] = new Set();
                    if (!_effectDeps[_activeEffect]) _effectDeps[_activeEffect] = new Set();
                    _signalDeps[sigId].add(_activeEffect);
                    _effectDeps[_activeEffect].add(sigId);
                }
                break;
            }
            case CMD_BATCH_BEGIN: {
                _batchDepth++;
                _shared[1] = _batchDepth;
                break;
            }
            case CMD_BATCH_END: {
                if (_batchDepth > 0) _batchDepth--;
                _shared[1] = _batchDepth;
                break;
            }
            case CMD_FLUSH: {
                // Force flush — mark all tracked effects as pending
                for (let i = 0; i < _effectCount; i++) {
                    if (_effectDeps[i] && _effectDeps[i].size > 0) {
                        _addPending(i);
                    }
                }
                break;
            }
        }
    }

    _shared[8] = rh; // Update read head
}

function _clearEffectDeps(effId: number): void {
    const deps = _effectDeps[effId];
    if (!deps) return;
    for (const sigId of deps) {
        _signalDeps[sigId]?.delete(effId);
    }
    deps.clear();
}

function _addPending(effId: number): void {
    if (_pendingCount >= MAX_PENDING) return;

    // Dedup — linear scan (n is tiny, typically 1-8)
    for (let i = 0; i < _pendingCount; i++) {
        if (_pendingBuf[i] === effId) return;
    }

    _pendingBuf[_pendingCount++] = effId;
}

function _flushDirty(): void {
    if (_batchDepth > 0) return;

    // Process dirty signal buffer (double-buffer swap)
    const currentBuf = _dirtyBuf;
    const currentCount = _dirtyCount;
    _dirtyCount = 0;

    // Swap write buffer
    _dirtyWriteBuf = _dirtyWriteBuf === _dirtyBufA ? _dirtyBufB : _dirtyBufA;

    // Walk dirty signals and propagate
    for (let i = 0; i < currentCount; i++) {
        const sigId = currentBuf[i];
        const deps = _signalDeps[sigId];
        if (deps) {
            for (const effId of deps) {
                _addPending(effId);
            }
        }
    }
}
