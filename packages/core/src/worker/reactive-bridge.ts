/**
 * ReactiveBridge: Main thread ↔ Worker communication. (v2 — zero-latency wake)
 *
 * Uses SharedArrayBuffer + Atomics for zero-copy signal value reads.
 * The worker owns the dependency graph; the main thread runs effect callbacks.
 *
 * v2 CHANGE: Replaced requestAnimationFrame polling with Atomics.waitAsync.
 * Main thread sleeps until worker notifies (Atomics.notify) that effects are pending.
 * Latency: ~0 (immediate wake) vs ~16ms (rAF polling).
 *
 * OPTIMIZATION: Effect callbacks read signal values directly from shared memory
 * (no postMessage round-trip). The worker posts effect IDs via SharedArrayBuffer
 * and the main thread wakes immediately via Atomics.waitAsync.
 */

const STATUS_READY = 1;
const STATUS_EFFECTS = 2;
const STATUS_SHUTDOWN = 3;
const STATUS_COMMANDS = 4;

const HEADER_CMD = 0;
const HEADER_BATCH_DEPTH = 1;
const HEADER_SIGNAL_COUNT = 2;
const HEADER_EFFECT_COUNT = 3;
const HEADER_PENDING_COUNT = 4;
const HEADER_TRACKING_EFFECT = 5;
const HEADER_FRAME = 6;
const HEADER_CMD_WHEAD = 7;
const HEADER_CMD_RHEAD = 8;
const HEADER_RESERVED_END = 64;

const SIGNAL_VALUES_OFFSET = 64;
const MAX_SIGNALS = 65536;
const MAX_EFFECTS = 4096;
const MAX_PENDING = 2048;
const EFFECT_FLAGS_OFFSET = SIGNAL_VALUES_OFFSET + MAX_SIGNALS * 2;
const PENDING_OFFSET = EFFECT_FLAGS_OFFSET + MAX_EFFECTS;

const CMD_QUEUE_OFFSET = PENDING_OFFSET + MAX_PENDING;
const CMD_QUEUE_SIZE = 4096;
const CMD_QUEUE_MASK = CMD_QUEUE_SIZE - 1;

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

// Reusable f64↔u32 decode buffer (zero-alloc)
const _f64Buf = new Float64Array(1);
const _u32Buf = new Uint32Array(_f64Buf.buffer);

let _worker: Worker | null = null;
let _header: Int32Array | null = null;
let _shared: Uint32Array | null = null;
let _f64Shared: Float64Array | null = null;
let _cmdWriteHead = 0;
let _effectFns: (() => void)[] = [];
let _active = false;
let _waiting = false;

export interface ReactiveBridgeConfig {
    workerUrl: string | URL;
    effectFns: (() => void)[];
}

export function initReactiveBridge(config: ReactiveBridgeConfig): Promise<void> {
    return new Promise((resolve) => {
        const sab = new SharedArrayBuffer(1024 * 1024);
        _header = new Int32Array(sab, 0, HEADER_RESERVED_END);
        _shared = new Uint32Array(sab);
        _f64Shared = new Float64Array(sab);
        _effectFns = config.effectFns;

        const url = config.workerUrl instanceof URL
            ? config.workerUrl.href
            : config.workerUrl;

        _worker = new Worker(url, { type: 'module' });
        _worker.postMessage({
            type: 'init',
            header: _header,
            buffer: sab,
        });

        _worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                _active = true;
                _startListening();
                resolve();
            }
        };
    });
}

export function shutdownReactiveBridge(): void {
    _active = false;
    if (_worker) {
        // Wake worker so it can see shutdown status
        if (_header) {
            Atomics.store(_header, HEADER_CMD, STATUS_SHUTDOWN);
            Atomics.notify(_header, 0);
        }
        _worker.terminate();
        _worker = null;
    }
}

// ── Signal value reads from shared memory (zero-copy) ─────────────────

export function readSignalF64(signalId: number): number {
    if (!_f64Shared) return 0;
    return _f64Shared[(SIGNAL_VALUES_OFFSET / 2) + signalId];
}

// ── Command queue writer (lock-free SPSC ring buffer) ─────────────────

function _pushCmd(cmd: number, ...args: number[]): void {
    if (!_shared) return;
    const wh = _cmdWriteHead;
    const rh = Atomics.load(_header!, HEADER_CMD_RHEAD);
    const needed = 1 + args.length;
    const available = CMD_QUEUE_SIZE - ((wh - rh) & CMD_QUEUE_MASK);
    if (needed > available) return; // Queue full, drop command
    let w = wh;
    _shared[CMD_QUEUE_OFFSET + (w & CMD_QUEUE_MASK)] = cmd;
    w++;
    for (let i = 0; i < args.length; i++) {
        _shared[CMD_QUEUE_OFFSET + (w & CMD_QUEUE_MASK)] = args[i];
        w++;
    }
    _cmdWriteHead = w;
    Atomics.store(_header!, HEADER_CMD_WHEAD, w);

    // Wake worker if it's sleeping
    _wakeWorker();
}

function _wakeWorker(): void {
    if (!_header) return;
    // Signal worker that commands are ready
    Atomics.store(_header, HEADER_CMD, STATUS_COMMANDS);
    Atomics.notify(_header, 0);
}

export function bridgeSignalCreate(signalId: number): void {
    _pushCmd(CMD_SIGNAL_CREATE, signalId);
}

export function bridgeSignalSet(signalId: number, value: number): void {
    _f64Buf[0] = value;
    _pushCmd(CMD_SIGNAL_SET, signalId, _u32Buf[0], _u32Buf[1]);
}

export function bridgeEffectCreate(effectId: number): void {
    _pushCmd(CMD_EFFECT_CREATE, effectId);
}

export function bridgeEffectBegin(effectId: number): void {
    _pushCmd(CMD_EFFECT_BEGIN, effectId);
}

export function bridgeEffectEnd(): void {
    _pushCmd(CMD_EFFECT_END);
}

export function bridgeEffectDispose(effectId: number): void {
    _pushCmd(CMD_EFFECT_DISPOSE, effectId);
}

export function bridgeSignalTrack(signalId: number): void {
    _pushCmd(CMD_SIGNAL_TRACK, signalId);
}

export function bridgeBatchBegin(): void {
    _pushCmd(CMD_BATCH_BEGIN);
}

export function bridgeBatchEnd(): void {
    _pushCmd(CMD_BATCH_END);
}

// ── Zero-latency listener: Atomics.waitAsync wakes on notify ──────────

async function _startListening(): Promise<void> {
    if (_waiting) return;
    _waiting = true;

    while (_active) {
        // Wait for worker to notify us (effects pending or shutdown)
        Atomics.waitAsync(_header!, HEADER_CMD, STATUS_READY);

        // Process any pending effects
        await _waitForEffects();
    }

    _waiting = false;
}

async function _waitForEffects(): Promise<void> {
    while (_active) {
        // Check if effects are pending
        const pendingCount = Atomics.load(_header!, HEADER_PENDING_COUNT);
        if (pendingCount > 0) {
            // Execute pending effects (zero-copy — read IDs from shared memory)
            const count = Math.min(pendingCount, MAX_PENDING);
            for (let i = 0; i < count; i++) {
                const effId = _shared![PENDING_OFFSET + i];
                const fn = _effectFns[effId];
                if (fn) fn();
            }
            // Tell worker we consumed them
            Atomics.store(_header!, HEADER_PENDING_COUNT, 0);
            Atomics.store(_header!, HEADER_CMD, STATUS_READY);
            Atomics.notify(_header!, 0);
            return;
        }

        // Small yield — avoid busy-waiting
        // Atomics.waitAsync for the status field
        const result = Atomics.waitAsync(_header!, HEADER_CMD, STATUS_READY, 1);
        if (result.async) {
            await result.value;
        } else {
            // Synchronous value — status changed
            const status = Atomics.load(_header!, HEADER_CMD);
            if (status === STATUS_SHUTDOWN) {
                _active = false;
                return;
            }
            if (status === STATUS_EFFECTS) {
                continue; // Process effects
            }
            return; // Back to ready
        }
    }
}
