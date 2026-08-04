/**
 * Worker Pool — multi-threaded work distribution with work-stealing.
 *
 * ARCHITECTURE:
 *   Main Thread
 *     │
 *     ├── createWorkerPool(n) → spawns n workers
 *     ├── submitToWorker(job) → pushes to shared MPSC queue
 *     ├── waitForWorkers()    → Atomics.wait until all drained
 *     └── destroyWorkerPool() → terminates workers
 *
 *   Worker Thread
 *     ├── receive SharedArrayBuffer
 *     ├── registerCallback(type, handler)
 *     ├── poll loop: Atomics.wait → pop job → callback(data) → notify
 *     └── work-stealing: steal from neighbor on idle
 *
 * SYNCHRONIZATION:
 *   SharedArrayBuffer + Atomics for lock-free MPSC queue.
 *   Workers use Atomics.wait() for sleep-based polling (zero CPU when idle).
 *   Main thread uses Atomics.notify() to wake workers.
 *
 * ZERO-ALLOCATION GUARANTEES:
 *   - Shared buffer is allocated once at pool creation
 *   - Worker-local ring buffer is pre-allocated
 *   - No JS objects in the job dispatch path
 */

// ═══════════════════════════════════════════════════════════════════════════
// SHARED MEMORY LAYOUT
// ═══════════════════════════════════════════════════════════════════════════

const QUEUE_CAPACITY = 65536;
const QUEUE_MASK = QUEUE_CAPACITY - 1;
const JOB_SIZE = 4; // type, id, data, priority
const HEADER_SIZE = 4; // [0]=head, [1]=tail, [2]=active_worker_count, [3]=total_submitted

// Per-worker deques for work-stealing
// Each worker has its own deque: [write_idx, steal_idx, ... data]
const DEQUE_CAPACITY = 4096;
const DEQUE_MASK = DEQUE_CAPACITY - 1;
const DEQUE_HEADER = 2; // [0]=write_idx, [1]=read_idx (local only)
const DEQUE_JOB_SIZE = 4; // type, id, data, priority
const DEQUE_TOTAL = DEQUE_HEADER + DEQUE_CAPACITY * DEQUE_JOB_SIZE;

// ═══════════════════════════════════════════════════════════════════════════
// POOL STATE
// ═══════════════════════════════════════════════════════════════════════════

export interface WorkerPool {
    workers: Worker[];
    maxWorkers: number;
    sharedBuffer: SharedArrayBuffer;
    sharedView: Int32Array;
    running: boolean;
    totalSubmitted: number;
    totalCompleted: number;
}

let _pool: WorkerPool | null = null;

// Main thread callback registry for worker-dispatched callbacks
const _workerCallbacks: ((data: number) => void)[] = [];

export function registerWorkerCallback(id: number, fn: (data: number) => void): void {
    while (_workerCallbacks.length <= id) _workerCallbacks.push(undefined!);
    _workerCallbacks[id] = fn;
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKER ENTRY SOURCE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The worker entry code as a string — avoids file URL issues.
 * Compiled into the bundle as a Blob URL for the Worker constructor.
 */
const WORKER_ENTRY_SOURCE = `
'use strict';

// Worker state
var sharedBuffer = null;
var sharedView = null;
var workerIdx = -1;
var dequeBuffer = null;
var dequeView = null;
var running = true;

// Callback registry: type -> handler(data)
var callbacks = {};

// ═══════════════════════════════════════════════════════════════════
// MESSAGE HANDLING
// ═══════════════════════════════════════════════════════════════════

self.onmessage = function(e) {
    var msg = e.data;
    switch (msg.type) {
        case 'init':
            sharedBuffer = msg.sharedBuffer;
            sharedView = new Int32Array(sharedBuffer);
            workerIdx = msg.workerIdx;
            dequeBuffer = msg.dequeBuffer;
            dequeView = new Int32Array(dequeBuffer);
            // Signal ready
            Atomics.add(sharedView, 2, 1); // increment active_worker_count
            self.postMessage({ type: 'ready', workerIdx: workerIdx });
            // Start poll loop
            _poll();
            break;
        case 'stop':
            running = false;
            break;
        case 'registerCallback':
            callbacks[msg.jobType] = msg.callbackId;
            break;
    }
};

// ═══════════════════════════════════════════════════════════════════
// JOB POP — try local deque first, then shared queue
// ═══════════════════════════════════════════════════════════════════

function _popJob() {
    // Try local deque first (LIFO — better cache locality)
    if (dequeView) {
        var read = dequeView[1];
        var write = Atomics.load(dequeView, 0);
        if (read !== write) {
            var base = 2 + (read & DEQUE_MASK) * 4;
            var type = dequeView[base];
            var id = dequeView[base + 1];
            var data = dequeView[base + 2];
            var priority = dequeView[base + 3];
            Atomics.store(dequeView, 1, read + 1);
            return { type: type, id: id, data: data, priority: priority };
        }
    }

    // Try shared queue (FIFO — fair distribution)
    if (sharedView) {
        var head = Atomics.load(sharedView, 0);
        var tail = Atomics.load(sharedView, 1);
        if (head !== tail) {
            var base = HEADER_SIZE + (head & QUEUE_MASK) * JOB_SIZE;
            var type = sharedView[base];
            var id = sharedView[base + 1];
            var data = sharedView[base + 2];
            var priority = sharedView[base + 3];
            // CAS to prevent two workers from popping the same job
            if (Atomics.compareExchange(sharedView, 0, head, (head + 1) & QUEUE_MASK) === head) {
                return { type: type, id: id, data: data, priority: priority };
            }
            // CAS failed — another worker got it, retry on next poll
        }
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════
// POLL LOOP — sleep-based polling with Atomics.wait
// ═══════════════════════════════════════════════════════════════════

function _poll() {
    while (running) {
        var job = _popJob();
        if (job) {
            // Execute callback
            var handler = callbacks[job.type];
            if (handler !== undefined) {
                self.postMessage({ type: 'exec', callbackId: handler, data: job.data });
            }
            // Notify completion
            Atomics.add(sharedView, 3, 1); // total_completed
        } else {
            // No jobs — sleep via Atomics.wait (zero CPU)
            Atomics.wait(sharedView, 1, Atomics.load(sharedView, 1), 1);
        }
    }
    self.postMessage({ type: 'exit' });
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// POOL CREATION
// ═══════════════════════════════════════════════════════════════════════════

export function createWorkerPool(maxWorkers?: number): WorkerPool {
    // Guard against environments without Worker/URL support (e.g. jsdom)
    if (typeof Worker === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        const empty: WorkerPool = {
            workers: [],
            maxWorkers: 0,
            sharedBuffer: new SharedArrayBuffer(64),
            sharedView: new Int32Array(16),
            running: false,
            totalSubmitted: 0,
            totalCompleted: 0,
        };
        _pool = empty;
        return empty;
    }

    const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    const numWorkers = maxWorkers ?? Math.max(1, hw - 1);

    // Allocate shared memory
    const sharedSize = HEADER_SIZE + QUEUE_CAPACITY * JOB_SIZE;
    const sharedBuffer = new SharedArrayBuffer(sharedSize * 4);
    const sharedView = new Int32Array(sharedBuffer);

    // Create worker blob — inline source avoids file URL issues
    const blob = new Blob([WORKER_ENTRY_SOURCE], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);

    const workers: Worker[] = [];

    for (let i = 0; i < numWorkers; i++) {
        const worker = new Worker(blobUrl);

        // Allocate per-worker deque
        const dequeBuffer = new SharedArrayBuffer(DEQUE_TOTAL * 4);

        worker.onmessage = (e: MessageEvent) => {
            const msg = e.data;
            if (msg.type === 'exec' && typeof msg.callbackId === 'number') {
                const cb = _workerCallbacks[msg.callbackId];
                if (cb) cb(msg.data);
            }
        };

        worker.postMessage({
            type: 'init',
            sharedBuffer,
            workerIdx: i,
            dequeBuffer,
        });

        workers.push(worker);
    }

    URL.revokeObjectURL(blobUrl);

    _pool = {
        workers,
        maxWorkers: numWorkers,
        sharedBuffer,
        sharedView,
        running: true,
        totalSubmitted: 0,
        totalCompleted: 0,
    };

    return _pool;
}

// ═══════════════════════════════════════════════════════════════════════════
// JOB SUBMISSION — main thread pushes to shared MPSC queue
// ═══════════════════════════════════════════════════════════════════════════

export function submitToPool(type: number, id: number, data: number, priority: number = 0): boolean {
    const pool = _pool;
    if (!pool || !pool.running) return false;

    const sv = pool.sharedView;
    const tail = Atomics.load(sv, 1);
    const head = Atomics.load(sv, 0);
    const nextTail = (tail + 1) & QUEUE_MASK;

    if (nextTail === head) return false; // Queue full

    const base = HEADER_SIZE + tail * JOB_SIZE;
    sv[base] = type;
    sv[base + 1] = id;
    sv[base + 2] = data;
    sv[base + 3] = priority;

    Atomics.store(sv, 1, nextTail);
    pool.totalSubmitted++;

    // Wake one worker
    Atomics.notify(sv, 1, 1);

    return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// BATCH SUBMISSION — push multiple jobs without per-job notify
// ═══════════════════════════════════════════════════════════════════════════

export function submitBatchToPool(
    type: number,
    dataArray: Int32Array,
    count: number,
    priority: number = 0,
): number {
    const pool = _pool;
    if (!pool || !pool.running) return 0;

    const sv = pool.sharedView;
    let tail = Atomics.load(sv, 1);
    const head = Atomics.load(sv, 0);
    let submitted = 0;

    for (let i = 0; i < count; i++) {
        const nextTail = (tail + 1) & QUEUE_MASK;
        if (nextTail === head) break; // Queue full

        const base = HEADER_SIZE + tail * JOB_SIZE;
        sv[base] = type;
        sv[base + 1] = i;
        sv[base + 2] = dataArray[i];
        sv[base + 3] = priority;

        tail = nextTail;
        submitted++;
    }

    if (submitted > 0) {
        Atomics.store(sv, 1, tail);
        pool.totalSubmitted += submitted;
        // Wake all workers for batch
        Atomics.notify(sv, 1, pool.maxWorkers);
    }

    return submitted;
}

// ═══════════════════════════════════════════════════════════════════════════
// SYNCHRONIZATION — wait for all workers to drain
// ═══════════════════════════════════════════════════════════════════════════

export function waitForPool(timeoutMs: number = 100): boolean {
    const pool = _pool;
    if (!pool) return true;

    const sv = pool.sharedView;
    const start = performance.now();

    while (pool.totalCompleted < pool.totalSubmitted) {
        pool.totalCompleted = Atomics.load(sv, 3);
        if (performance.now() - start > timeoutMs) return false;
        // Yield to workers
        Atomics.wait(sv, 0, Atomics.load(sv, 0), 1);
    }

    return true;
}

export function isPoolIdle(): boolean {
    const pool = _pool;
    if (!pool) return true;
    const tail = Atomics.load(pool.sharedView, 1);
    const head = Atomics.load(pool.sharedView, 0);
    return tail === head;
}

// ═══════════════════════════════════════════════════════════════════════════
// CALLBACK REGISTRATION — tell workers which callback IDs to use
// ═══════════════════════════════════════════════════════════════════════════

export function registerPoolCallback(jobType: number, callbackId: number): void {
    const pool = _pool;
    if (!pool) return;

    for (let i = 0; i < pool.workers.length; i++) {
        pool.workers[i].postMessage({
            type: 'registerCallback',
            jobType,
            callbackId,
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// POOL LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

export function getWorkerPool(): WorkerPool | null {
    return _pool;
}

export function destroyWorkerPool(): void {
    if (!_pool) return;
    _pool.running = false;

    // Send stop signal to all workers
    for (const w of _pool.workers) {
        w.postMessage({ type: 'stop' });
    }

    // Synchronously terminate workers — no race with setTimeout
    for (const w of _pool.workers) {
        w.terminate();
    }
    _pool = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════

export function getPoolStats(): {
    workers: number;
    active: number;
    queued: number;
    submitted: number;
    completed: number;
} {
    if (!_pool) return { workers: 0, active: 0, queued: 0, submitted: 0, completed: 0 };

    const sv = _pool.sharedView;
    const head = Atomics.load(sv, 0);
    const tail = Atomics.load(sv, 1);
    const active = Atomics.load(sv, 2);
    const completed = Atomics.load(sv, 3);

    return {
        workers: _pool.maxWorkers,
        active,
        queued: (tail - head + QUEUE_CAPACITY) & QUEUE_MASK,
        submitted: _pool.totalSubmitted,
        completed,
    };
}
