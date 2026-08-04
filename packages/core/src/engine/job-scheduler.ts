/**
 * Job Scheduler — multi-threaded work distribution.
 *
 * Jobs are categorized by type:
 *   Layout Job, Paint Job, Animation Job, Text Job, GPU Job
 *
 * Workers pull jobs from a lock-free work-stealing queue.
 * The main thread coordinates job submission and synchronization.
 *
 * ARCHITECTURE:
 *   Main Thread
 *     │
 *     ├── Submit Layout Jobs → Worker Pool
 *     ├── Submit Paint Jobs  → Worker Pool
 *     ├── Submit Animation Jobs → Worker Pool
 *     ├── Submit Text Jobs   → Worker Pool
 *     ├── Submit GPU Jobs    → Worker Pool
 *     │
 *     └── Wait for completion → Commit
 *
 * WORK QUEUE:
 *   SharedArrayBuffer + Atomics for lock-free MPSC queue.
 */

// ═══════════════════════════════════════════════════════════════════════════
// JOB TYPES
// ═══════════════════════════════════════════════════════════════════════════

export const enum JobType {
    NONE       = 0,
    LAYOUT     = 1,
    PAINT      = 2,
    ANIMATION  = 3,
    TEXT       = 4,
    GPU        = 5,
    CUSTOM     = 6,
}

const JOB_TYPE_NAMES: Record<number, string> = {
    [JobType.NONE]: 'none',
    [JobType.LAYOUT]: 'layout',
    [JobType.PAINT]: 'paint',
    [JobType.ANIMATION]: 'animation',
    [JobType.TEXT]: 'text',
    [JobType.GPU]: 'gpu',
    [JobType.CUSTOM]: 'custom',
};

// ═══════════════════════════════════════════════════════════════════════════
// JOB INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

export interface Job {
    type: JobType;
    id: number;
    data: number;       // generic data pointer/index
    priority: number;   // 0 = highest
    callback: ((data: number) => void) | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// WORK STEALING QUEUE — lock-free MPSC
// ═══════════════════════════════════════════════════════════════════════════

const QUEUE_CAPACITY = 65536;
const QUEUE_MASK = QUEUE_CAPACITY - 1;

// Shared memory layout:
// [0] head (read index, consumers steal from here)
// [1] tail (write index, producer pushes here)
// [2..2+QUEUE_CAPACITY*4] job data (4 u32 per job: type, id, data, priority)

const HEADER_SIZE = 2;
const JOB_SIZE = 4;
const TOTAL_SHARED_SIZE = HEADER_SIZE + QUEUE_CAPACITY * JOB_SIZE;

let _sharedBuffer: SharedArrayBuffer | null = null;
let _sharedView: Int32Array | null = null;

// Pre-allocated local ring buffer (non-worker environments, zero allocation)
const _localBuf = new Int32Array(QUEUE_CAPACITY * JOB_SIZE);
let _localHead = 0;
let _localTail = 0;

function _ensureShared(): Int32Array {
    if (_sharedView) return _sharedView;
    _sharedBuffer = new SharedArrayBuffer(TOTAL_SHARED_SIZE * 4);
    _sharedView = new Int32Array(_sharedBuffer);
    return _sharedView;
}

function _pushJob(job: Job): boolean {
    // Try shared buffer first
    if (_sharedView) {
        const tail = Atomics.load(_sharedView, 1);
        const head = Atomics.load(_sharedView, 0);
        const nextTail = (tail + 1) & QUEUE_MASK;

        if (nextTail === head) return false; // Queue full

        const base = HEADER_SIZE + tail * JOB_SIZE;
        _sharedView[base] = job.type;
        _sharedView[base + 1] = job.id;
        _sharedView[base + 2] = job.data;
        _sharedView[base + 3] = job.priority;

        Atomics.store(_sharedView, 1, nextTail);
        return true;
    }

    // Local ring buffer fallback — zero allocation, typed array
    const nextTail = (_localTail + 1) & QUEUE_MASK;
    if (nextTail === _localHead) return false; // Queue full

    const base = _localTail * JOB_SIZE;
    _localBuf[base] = job.type;
    _localBuf[base + 1] = job.id;
    _localBuf[base + 2] = job.data;
    _localBuf[base + 3] = job.priority;

    _localTail = nextTail;
    return true;
}

function _popJob(): Job | null {
    // Try shared buffer first
    if (_sharedView) {
        const head = Atomics.load(_sharedView, 0);
        const tail = Atomics.load(_sharedView, 1);

        if (head === tail) return null;

        const base = HEADER_SIZE + head * JOB_SIZE;
        const jobId = _sharedView[base + 1];
        const job: Job = {
            type: _sharedView[base],
            id: jobId,
            data: _sharedView[base + 2],
            priority: _sharedView[base + 3],
            callback: _jobCallbacks[jobId] || null,
        };

        Atomics.store(_sharedView, 0, (head + 1) & QUEUE_MASK);
        return job;
    }

    // Local ring buffer fallback
    if (_localHead === _localTail) return null;

    const base = _localHead * JOB_SIZE;
    const jobId = _localBuf[base + 1];
    const job: Job = {
        type: _localBuf[base],
        id: jobId,
        data: _localBuf[base + 2],
        priority: _localBuf[base + 3],
        callback: _jobCallbacks[jobId] || null,
    };

    _localHead = (_localHead + 1) & QUEUE_MASK;
    return job;
}

// ═══════════════════════════════════════════════════════════════════════════
// JOB SCHEDULER
// ═══════════════════════════════════════════════════════════════════════════

export interface JobScheduler {
    workers: Worker[];
    maxWorkers: number;
    running: boolean;
    jobIdCounter: number;

    // Pending jobs per type
    pendingJobs: number[];     // [type] = count
    completedJobs: number[];   // [type] = count

    // Stats
    totalJobsSubmitted: number;
    totalJobsCompleted: number;
    totalWorkTime: number;
}

let _scheduler: JobScheduler | null = null;

export function createJobScheduler(maxWorkers?: number): JobScheduler {
    const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    const numWorkers = maxWorkers ?? Math.max(1, hw - 1); // Reserve 1 core for main thread

    const s: JobScheduler = {
        workers: [],
        maxWorkers: numWorkers,
        running: false,
        jobIdCounter: 0,
        pendingJobs: new Array(8).fill(0),
        completedJobs: new Array(8).fill(0),
        totalJobsSubmitted: 0,
        totalJobsCompleted: 0,
        totalWorkTime: 0,
    };

    _scheduler = s;
    return s;
}

export function getJobScheduler(): JobScheduler {
    if (!_scheduler) _scheduler = createJobScheduler();
    return _scheduler;
}

// ═══════════════════════════════════════════════════════════════════════════
// JOB SUBMISSION
// ═══════════════════════════════════════════════════════════════════════════

let _jobCallbacks: ((data: number) => void)[] = new Array(256);
let _jobCallbackCount = 0;

export function registerJobCallback(callback: (data: number) => void): number {
    const id = _jobCallbackCount++;
    if (id >= _jobCallbacks.length) {
        _jobCallbacks.length = _jobCallbacks.length * 2;
    }
    _jobCallbacks[id] = callback;
    return id;
}

export function submitJob(type: JobType, data: number, priority: number = 0): number {
    const s = getJobScheduler();
    const id = s.jobIdCounter++;

    const job: Job = {
        type,
        id,
        data,
        priority,
        callback: null,
    };

    const pushed = _pushJob(job);
    if (pushed) {
        s.pendingJobs[type]++;
        s.totalJobsSubmitted++;
    }

    return id;
}

export function submitJobBatch(type: JobType, dataArray: Int32Array, count: number, priority: number = 0): void {
    for (let i = 0; i < count; i++) {
        submitJob(type, dataArray[i], priority);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// JOB EXECUTION — main thread fallback
// ═══════════════════════════════════════════════════════════════════════════

export function drainJobs(): number {
    let executed = 0;
    const pending = getJobScheduler().pendingJobs;
    const completed = getJobScheduler().completedJobs;

    let job = _popJob();
    while (job) {
        if (job.callback) {
            const start = performance.now();
            job.callback(job.data);
            getJobScheduler().totalWorkTime += performance.now() - start;
        }
        completed[job.type]++;
        pending[job.type]--;
        getJobScheduler().totalJobsCompleted++;
        executed++;
        job = _popJob();
    }

    return executed;
}

export function drainJobsByType(type: JobType, maxJobs: number = Infinity): number {
    let executed = 0;
    let job = _popJob();
    const pending = getJobScheduler().pendingJobs;
    const completed = getJobScheduler().completedJobs;
    const totalCompleted = getJobScheduler().totalJobsCompleted;
    const buffer = new Array(QUEUE_CAPACITY * JOB_SIZE);
    let bufIdx = 0;

    // Collect jobs of target type to execute, buffer others for re-queue
    while (job) {
        if (job.type === type) {
            if (job.callback) {
                job.callback(job.data);
            }
            completed[type]++;
            executed++;
        } else {
            // Non-matching job: buffer for re-queue after current type's drain
            buffer[bufIdx++] = job.type;
            buffer[bufIdx++] = job.id;
            buffer[bufIdx++] = job.data;
            buffer[bufIdx++] = job.priority;
        }
        job = _popJob();
    }

    // Re-queue buffered non-matching jobs
    for (let i = 0; i < bufIdx; i += 4) {
        const qJob: Job = {
            type: buffer[i],
            id: buffer[i + 1],
            data: buffer[i + 2],
            priority: buffer[i + 3],
            callback: null,
        };
        if (_pushJob(qJob)) {
            pending[qJob.type]++;
        }
    }

    return executed;
}

// ═══════════════════════════════════════════════════════════════════════════
// SYNCHRONIZATION — wait for all jobs of a type to complete
// ═══════════════════════════════════════════════════════════════════════════

export function waitForType(type: JobType, timeoutMs: number = 100): boolean {
    const start = performance.now();
    const s = getJobScheduler();
    const targetCount = s.pendingJobs[type];
    let lastCount = targetCount;

    while (s.completedJobs[type] < targetCount) {
        const before = s.completedJobs[type];
        drainJobsByType(type, Infinity);
        const after = s.completedJobs[type];

        if (before === after) {
            // No progress, check timeout
            if (performance.now() - start > timeoutMs) {
                return false;
            }
            // Yield to avoid spinning
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        } else {
            // Progress made, continue
            lastCount = targetCount - after;
        }
    }
    return true;
}

export function waitForAll(timeoutMs: number = 100): boolean {
    const start = performance.now();
    let total = 0;
    const s = getJobScheduler();
    for (let i = 1; i < s.pendingJobs.length; i++) {
        total += s.pendingJobs[i];
    }

    while (s.totalJobsCompleted < total) {
        drainJobs();
        if (performance.now() - start > timeoutMs) {
            return false;
        }
    }
    return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════════════════════════════════════

export function resetJobScheduler(): void {
    const s = getJobScheduler();
    s.pendingJobs.fill(0);
    s.completedJobs.fill(0);
    s.totalJobsSubmitted = 0;
    s.totalJobsCompleted = 0;
    s.totalWorkTime = 0;
    s.jobIdCounter = 0;
    if (_sharedView) {
        Atomics.store(_sharedView, 0, 0);
        Atomics.store(_sharedView, 1, 0);
    }
    _localHead = 0;
    _localTail = 0;
}

export function destroyJobScheduler(): void {
    resetJobScheduler();
    _scheduler = null;
    _sharedBuffer = null;
    _sharedView = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED BUFFER ACCESS — for workers
// ═══════════════════════════════════════════════════════════════════════════

export function getSharedBuffer(): SharedArrayBuffer | null {
    _ensureShared();
    return _sharedBuffer;
}

export function getJobTypeName(type: JobType): string {
    return JOB_TYPE_NAMES[type] || 'unknown';
}
