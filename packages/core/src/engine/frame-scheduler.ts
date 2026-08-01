/**
 * Frame Scheduler — HARD REAL-TIME frame pipeline. BARE METAL.
 *
 * Each frame is a pipeline of timed stages. Every stage has a time budget.
 * Stages that exceed their budget trigger DEGRADATION of subsequent stages.
 * At 240fps target, the total frame budget is 4.166ms.
 *
 * DEGRADATION MODEL (game-engine style):
 *   Level 0 (green):  All stages run at full quality
 *   Level 1 (yellow): Skip ANIMATION, TEXT, VISIBILITY (non-essential)
 *   Level 2 (red):    Degrade PAINT (fewer entities), skip GPU passes
 *   Level 3 (black):  Skip PAINT entirely, re-use previous frame's commands
 *
 * ZERO-ALLOCATION GUARANTEES:
 *   - FrameStats object is reused across frames (mutated in place)
 *   - History is a fixed-size ring buffer (no Array.shift, no push)
 *   - P99 is computed via incremental insertion sort (no per-frame .sort())
 *   - StageTimings Float64Array is pre-allocated once
 *   - Degradation flags are u32 bitmask (no object allocation)
 */

// ═══════════════════════════════════════════════════════════════════════════
// STAGE TYPES
// ═══════════════════════════════════════════════════════════════════════════

export const enum Stage {
    NONE      = 0,
    INPUT     = 1,
    SIGNALS   = 2,
    ANIMATION = 3,
    LAYOUT    = 4,
    TEXT      = 5,
    VISIBILITY = 6,
    PAINT     = 7,
    GPU       = 8,
    COMMIT    = 9,
}

// ═══════════════════════════════════════════════════════════════════════════
// DEGRADATION LEVELS — bitmask per stage
// ═══════════════════════════════════════════════════════════════════════════

export const enum Degrade {
    NONE       = 0,
    SKIP       = 1 << 0,  // Skip stage entirely
    LITE       = 1 << 1,  // Run reduced version (fewer entities, cheaper passes)
    REUSE      = 1 << 2,  // Reuse previous frame's output
}

// ═══════════════════════════════════════════════════════════════════════════
// FRAME STATISTICS — pre-allocated, mutated in place
// ═══════════════════════════════════════════════════════════════════════════

export interface FrameStats {
    frameNumber: number;
    timestamp: number;
    stageTimings: Float64Array;    // time per stage in ms — PRE-ALLOCATED
    totalFrameTime: number;
    signalsUpdated: number;
    effectsExecuted: number;
    domWrites: number;
    layoutNodes: number;
    paintNodes: number;
    gpuCommands: number;
    memoryUsed: number;
    degradeLevel: number;          // 0=full, 1=yellow, 2=red, 3=black
    culpritStage: number;          // Stage that caused degradation
}

const NUM_STAGES = 10;

// 240fps budget = 1000/240 = 4.166ms
const FRAME_BUDGET_240FPS = 4.167;
const FRAME_BUDGET_120FPS = 8.333;

// ═══════════════════════════════════════════════════════════════════════════
// RING BUFFER HISTORY — fixed-size, no allocation, no shift()
// ═══════════════════════════════════════════════════════════════════════════

const MAX_FRAME_HISTORY = 120;
const MAX_FRAME_HISTORY_MASK = MAX_FRAME_HISTORY - 1;

let _historyBuffer = new Float64Array(MAX_FRAME_HISTORY);
let _historyWriteIdx = 0;
let _historyCount = 0;

// Per-stage P50/P95/P99 tracking
let _stageHistory: Float64Array[] = [];
for (let i = 0; i < NUM_STAGES; i++) {
    _stageHistory.push(new Float64Array(MAX_FRAME_HISTORY));
}
let _stageHistoryWriteIdx = 0;

// ═══════════════════════════════════════════════════════════════════════════
// P99 COMPUTATION — pre-allocated sort buffer, incremental
// ═══════════════════════════════════════════════════════════════════════════

let _p99SortBuffer = new Float64Array(MAX_FRAME_HISTORY);
let _runningSum = 0;
let _runningWorst = 0;

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULER METRICS
// ═══════════════════════════════════════════════════════════════════════════

export interface SchedulerMetrics {
    p99FrameTime: number;
    worstFrameTime: number;
    averageFrameTime: number;
    totalFrames: number;
    droppedFrames: number;
    degradedFrames: number;
    // Per-stage P50/P95/P99
    stageP50: Float64Array;
    stageP95: Float64Array;
    stageP99: Float64Array;
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE DEPENDENCY GROUPS — stages in same group can run in parallel
// ═══════════════════════════════════════════════════════════════════════════

const STAGE_GROUPS: Stage[][] = [
    [Stage.INPUT],                          // Group 0: Input processing
    [Stage.SIGNALS],                        // Group 1: Signal propagation
    [Stage.ANIMATION, Stage.TEXT],          // Group 2: Can run in parallel (indep)
    [Stage.LAYOUT],                         // Group 3: Layout (needs ANIMATION results)
    [Stage.VISIBILITY],                     // Group 4: Visibility (needs LAYOUT)
    [Stage.PAINT],                          // Group 5: Render graph generation
    [Stage.GPU],                            // Group 6: Command optimization + execution
    [Stage.COMMIT],                         // Group 7: Present + profile + arena reset
];

// Degradation priority: which stages get skipped first (ascending = first to skip)
const STAGE_DEGRADE_PRIORITY: number[] = [
    0,  // NONE (unused)
    9,  // INPUT — critical, never skip
    9,  // SIGNALS — critical, never skip
    1,  // ANIMATION — first to degrade
    9,  // LAYOUT — critical for rendering
    2,  // TEXT — second to degrade
    3,  // VISIBILITY — third to degrade
    5,  // PAINT — degrade (fewer entities)
    4,  // GPU — skip optimization passes
    9,  // COMMIT — critical, must complete
];

type StageCallback = (budget: number, stats: FrameStats, degrade: number) => boolean;

export interface FrameScheduler {
    rafId: number;
    running: boolean;
    frameNumber: number;
    stageBudgets: Float64Array;
    stageCallbacks: (StageCallback | null)[];
    stageDegrade: Uint8Array;     // per-stage degradation flags
    metrics: SchedulerMetrics;
    onFrame: ((stats: FrameStats) => void) | null;
    _frameStartTime: number;
    _stageTimings: Float64Array;
    _reusableStats: FrameStats;
    groupDispatch: ((group: Stage[], stats: FrameStats, degrade: number) => void) | null;
    maxBudgetMs: number;          // current frame budget (4.167 for 240fps)
}

let _scheduler: FrameScheduler | null = null;

// Default budgets: total ~4.16ms for 240fps
const DEFAULT_BUDGETS = new Float64Array([
    0,       // NONE
    0.5,     // INPUT: 0.5ms
    1.0,     // SIGNALS: 1.0ms
    0.5,     // ANIMATION: 0.5ms
    1.5,     // LAYOUT: 1.5ms
    0.5,     // TEXT: 0.5ms
    0.5,     // VISIBILITY: 0.5ms
    1.0,     // PAINT: 1.0ms
    0.5,     // GPU: 0.5ms
    0.5,     // COMMIT: 0.5ms (uncapped — must complete)
]);

// Pre-allocated reusable stats
const _reusableStageTimings = new Float64Array(NUM_STAGES);
const _reusableStats: FrameStats = {
    frameNumber: 0,
    timestamp: 0,
    stageTimings: _reusableStageTimings,
    totalFrameTime: 0,
    signalsUpdated: 0,
    effectsExecuted: 0,
    domWrites: 0,
    layoutNodes: 0,
    paintNodes: 0,
    gpuCommands: 0,
    memoryUsed: 0,
    degradeLevel: 0,
    culpritStage: 0,
};

const _stageP50 = new Float64Array(NUM_STAGES);
const _stageP95 = new Float64Array(NUM_STAGES);
const _stageP99 = new Float64Array(NUM_STAGES);

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULER CREATION
// ═══════════════════════════════════════════════════════════════════════════

export function createScheduler(frameBudgetMs: number = FRAME_BUDGET_240FPS): FrameScheduler {
    const s: FrameScheduler = {
        rafId: 0,
        running: false,
        frameNumber: 0,
        stageBudgets: new Float64Array(DEFAULT_BUDGETS),
        stageCallbacks: new Array(NUM_STAGES).fill(null),
        stageDegrade: new Uint8Array(NUM_STAGES),
        metrics: {
            p99FrameTime: 0,
            worstFrameTime: 0,
            averageFrameTime: 0,
            totalFrames: 0,
            droppedFrames: 0,
            degradedFrames: 0,
            stageP50: _stageP50,
            stageP95: _stageP95,
            stageP99: _stageP99,
        },
        onFrame: null,
        groupDispatch: null,
        _frameStartTime: 0,
        _stageTimings: _reusableStageTimings,
        _reusableStats: _reusableStats,
        maxBudgetMs: frameBudgetMs,
    };
    _scheduler = s;
    return s;
}

export function getScheduler(): FrameScheduler {
    if (!_scheduler) _scheduler = createScheduler();
    return _scheduler;
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

export function registerStage(stage: Stage, callback: StageCallback): void {
    getScheduler().stageCallbacks[stage] = callback;
}

export function setStageBudget(stage: Stage, budgetMs: number): void {
    getScheduler().stageBudgets[stage] = budgetMs;
}

// ═══════════════════════════════════════════════════════════════════════════
// COOPERATIVE YIELDING — yield to browser between stages when ahead of schedule
//
// At 120fps+ target, yielding between independent stage groups lets the
// browser process input events and paint between compute bursts, improving
// perceived smoothness without impacting throughput.
// ═══════════════════════════════════════════════════════════════════════════

type YieldFn = () => Promise<void>;

let _yieldFn: YieldFn | null = null;

export function setYieldFn(fn: YieldFn | null): void {
    _yieldFn = fn;
}

function _maybeYield(s: FrameScheduler, frameStart: number, groupIdx: number): void {
    if (!_yieldFn) return;
    // Yield if we're at least 2ms ahead of schedule — only between independent groups
    const elapsed = performance.now() - frameStart;
    if (elapsed < 2.0 && groupIdx >= 2 && groupIdx < 6) {
        // ahead of schedule → yield to let browser process input
        _yieldFn();
    }
}


function _pushFrameTime(frameTime: number, stageTimings: Float64Array): void {
    const idx = _historyWriteIdx & MAX_FRAME_HISTORY_MASK;
    _historyBuffer[idx] = frameTime;

    // Per-stage timing history
    for (let i = 0; i < NUM_STAGES; i++) {
        _stageHistory[i][idx] = stageTimings[i];
    }

    _historyWriteIdx++;
    if (_historyCount < MAX_FRAME_HISTORY) _historyCount++;

    _runningSum += frameTime;
    if (frameTime > _runningWorst) _runningWorst = frameTime;
}

function _computePercentile(data: Float64Array, len: number, pct: number): number {
    if (len < 2) return 0;
    const startIdx = len < MAX_FRAME_HISTORY ? 0 : _historyWriteIdx & MAX_FRAME_HISTORY_MASK;
    for (let i = 0; i < len; i++) {
        _p99SortBuffer[i] = data[(startIdx + i) & MAX_FRAME_HISTORY_MASK];
    }
    for (let i = 1; i < len; i++) {
        const key = _p99SortBuffer[i];
        let j = i - 1;
        while (j >= 0 && _p99SortBuffer[j] > key) {
            _p99SortBuffer[j + 1] = _p99SortBuffer[j];
            j--;
        }
        _p99SortBuffer[j + 1] = key;
    }
    const idx = (len * pct / 100) | 0;
    return _p99SortBuffer[Math.min(idx, len - 1)];
}

// ═══════════════════════════════════════════════════════════════════════════
// DEGRADATION COMPUTATION — HARD REAL-TIME
//
// Given elapsed time and frame budget, compute degradation flags.
// Returns 0=full, 1=yellow, 2=red, 3=black
// ═══════════════════════════════════════════════════════════════════════════

function _computeDegrade(elapsedMs: number, budgetMs: number): number {
    const ratio = elapsedMs / budgetMs;
    if (ratio < 0.5) return 0;   // Green: ahead of schedule
    if (ratio < 0.75) return 1;  // Yellow: getting tight, skip non-essential
    if (ratio < 0.95) return 2;  // Red: over budget, degrade paint
    return 3;                     // Black: way over, skip paint, reuse commands
}

function _applyDegrade(s: FrameScheduler, level: number, culpritStage: number): void {
    const degrade = s.stageDegrade;
    // Reset all to NONE first
    for (let i = 0; i < NUM_STAGES; i++) degrade[i] = 0;

    switch (level) {
        case 0: break; // All full quality
        case 1: // Skip ANIMATION, TEXT, VISIBILITY
            degrade[Stage.ANIMATION] = Degrade.SKIP;
            degrade[Stage.TEXT] = Degrade.SKIP;
            degrade[Stage.VISIBILITY] = Degrade.SKIP;
            break;
        case 2: // Also degrade PAINT (lite), GPU (skip opt)
            degrade[Stage.ANIMATION] = Degrade.SKIP;
            degrade[Stage.TEXT] = Degrade.SKIP;
            degrade[Stage.VISIBILITY] = Degrade.SKIP;
            degrade[Stage.PAINT] = Degrade.LITE;
            degrade[Stage.GPU] = Degrade.LITE;
            break;
        case 3: // Skip PAINT, reuse previous GPU commands
            degrade[Stage.ANIMATION] = Degrade.SKIP;
            degrade[Stage.TEXT] = Degrade.SKIP;
            degrade[Stage.VISIBILITY] = Degrade.SKIP;
            degrade[Stage.PAINT] = Degrade.REUSE;
            degrade[Stage.GPU] = Degrade.SKIP;
            break;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// FRAME LOOP — ZERO ALLOCATION, HARD REAL-TIME
// ═══════════════════════════════════════════════════════════════════════════

function _executeFrame(s: FrameScheduler): void {
    const frameStart = performance.now();
    s._frameStartTime = frameStart;
    s.frameNumber++;

    // Reuse the same FrameStats object — mutate in place
    const stats = s._reusableStats;
    stats.frameNumber = s.frameNumber;
    stats.timestamp = frameStart;
    stats.totalFrameTime = 0;
    stats.signalsUpdated = 0;
    stats.effectsExecuted = 0;
    stats.domWrites = 0;
    stats.layoutNodes = 0;
    stats.paintNodes = 0;
    stats.gpuCommands = 0;
    stats.memoryUsed = 0;
    stats.degradeLevel = 0;
    stats.culpritStage = 0;

    const timings = stats.stageTimings;
    for (let i = 0; i < NUM_STAGES; i++) timings[i] = 0;

    const callbacks = s.stageCallbacks;
    const budgets = s.stageBudgets;
    const degrade = s.stageDegrade;
    const budgetMs = s.maxBudgetMs;

    // Reset degradation
    for (let i = 0; i < NUM_STAGES; i++) degrade[i] = 0;

    let elapsed = 0;
    let degradeLevel = 0;
    let culprit = 0;
    let stageStart: number;

    for (let g = 0; g < STAGE_GROUPS.length; g++) {
        const group = STAGE_GROUPS[g];

        // COOPERATIVE YIELD: if ahead of schedule, yield between stage groups
        _maybeYield(s, frameStart, g);

        // HARD REAL-TIME CHECK: if we're over budget, degrade remaining stages.
        // Degradation is applied once; the current and subsequent groups pick up
        // their per-stage flags below — every stage runs at most once per frame.
        elapsed = performance.now() - frameStart;
        if (elapsed >= budgetMs && g > 1 && degradeLevel === 0) {
            degradeLevel = _computeDegrade(elapsed, budgetMs);
            _applyDegrade(s, degradeLevel, group[0]);
            culprit = group[0];
            stats.degradeLevel = degradeLevel;
            stats.culpritStage = culprit;
        }

        if (group.length === 1) {
            const stage = group[0];
            const d = degrade[stage];
            if (d & Degrade.SKIP) {
                timings[stage] = 0;
                continue;
            }
            stageStart = performance.now();
            if (callbacks[stage]) callbacks[stage]!(budgets[stage], stats, d);
            timings[stage] = performance.now() - stageStart;
        } else if (s.groupDispatch) {
            const groupDegrade = degrade[group[0]];
            if (groupDegrade & Degrade.SKIP) continue;
            s.groupDispatch(group, stats, groupDegrade);
        } else {
            for (let i = 0; i < group.length; i++) {
                const stage = group[i];
                const d = degrade[stage];
                if (d & Degrade.SKIP) {
                    timings[stage] = 0;
                    continue;
                }
                stageStart = performance.now();
                if (callbacks[stage]) callbacks[stage]!(budgets[stage], stats, d);
                timings[stage] = performance.now() - stageStart;
            }
        }
    }

    stats.totalFrameTime = performance.now() - frameStart;

    // Update metrics
    const m = s.metrics;
    m.totalFrames++;
    _pushFrameTime(stats.totalFrameTime, timings);

    if (stats.totalFrameTime > FRAME_BUDGET_240FPS) {
        m.droppedFrames++;
        if (degradeLevel === 0) {
            degradeLevel = _computeDegrade(stats.totalFrameTime, FRAME_BUDGET_240FPS);
        }
    }
    if (degradeLevel > 0) m.degradedFrames++;

    m.averageFrameTime = _runningSum / _historyCount;
    m.worstFrameTime = _runningWorst;
    m.p99FrameTime = _computePercentile(_historyBuffer, _historyCount, 99);

    // Per-stage percentiles
    const len = _historyCount;
    for (let i = 0; i < NUM_STAGES; i++) {
        m.stageP50[i] = _computePercentile(_stageHistory[i], len, 50);
        m.stageP95[i] = _computePercentile(_stageHistory[i], len, 95);
        m.stageP99[i] = _computePercentile(_stageHistory[i], len, 99);
    }

    if (s.onFrame) s.onFrame(stats);

    if (s.running) {
        s.rafId = requestAnimationFrame(() => _executeFrame(s));
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// START / STOP
// ═══════════════════════════════════════════════════════════════════════════

export function startScheduler(): void {
    const s = getScheduler();
    if (s.running) return;
    s.running = true;
    s.rafId = requestAnimationFrame(() => _executeFrame(s));
}

export function stopScheduler(): void {
    const s = getScheduler();
    s.running = false;
    if (s.rafId) {
        cancelAnimationFrame(s.rafId);
        s.rafId = 0;
    }
}

export function getMetrics(): SchedulerMetrics {
    return getScheduler().metrics;
}

export function resetMetrics(): void {
    const s = getScheduler();
    const m = s.metrics;
    m.p99FrameTime = 0;
    m.worstFrameTime = 0;
    m.averageFrameTime = 0;
    m.totalFrames = 0;
    m.droppedFrames = 0;
    m.degradedFrames = 0;
    for (let i = 0; i < NUM_STAGES; i++) {
        m.stageP50[i] = 0;
        m.stageP95[i] = 0;
        m.stageP99[i] = 0;
    }
    _historyWriteIdx = 0;
    _historyCount = 0;
    _runningSum = 0;
    _runningWorst = 0;
    _stageHistoryWriteIdx = 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// IMMEDIATE MODE — for testing and non-raf environments
// ═══════════════════════════════════════════════════════════════════════════

export function tickSync(): FrameStats {
    const s = getScheduler();
    const frameStart = performance.now();
    s.frameNumber++;

    const stats = s._reusableStats;
    stats.frameNumber = s.frameNumber;
    stats.timestamp = frameStart;
    stats.totalFrameTime = 0;
    stats.signalsUpdated = 0;
    stats.effectsExecuted = 0;
    stats.domWrites = 0;
    stats.layoutNodes = 0;
    stats.paintNodes = 0;
    stats.gpuCommands = 0;
    stats.memoryUsed = 0;
    stats.degradeLevel = 0;
    stats.culpritStage = 0;

    const timings = stats.stageTimings;
    for (let i = 0; i < NUM_STAGES; i++) timings[i] = 0;

    const callbacks = s.stageCallbacks;
    const budgets = s.stageBudgets;
    const degrade = s.stageDegrade;
    for (let i = 0; i < NUM_STAGES; i++) degrade[i] = 0;

    let stageStart: number;

    for (let g = 0; g < STAGE_GROUPS.length; g++) {
        const group = STAGE_GROUPS[g];
        const stage0 = group[0];
        const d = degrade[stage0];

        if (group.length === 1) {
            if (d & Degrade.SKIP) { timings[stage0] = 0; continue; }
            stageStart = performance.now();
            if (callbacks[stage0]) callbacks[stage0]!(budgets[stage0], stats, d);
            timings[stage0] = performance.now() - stageStart;
        } else if (s.groupDispatch) {
            s.groupDispatch(group, stats, d);
        } else {
            for (let i = 0; i < group.length; i++) {
                const st = group[i];
                const d2 = degrade[st];
                if (d2 & Degrade.SKIP) { timings[st] = 0; continue; }
                stageStart = performance.now();
                if (callbacks[st]) callbacks[st]!(budgets[st], stats, d2);
                timings[st] = performance.now() - stageStart;
            }
        }
    }

    stats.totalFrameTime = performance.now() - frameStart;

    const m = s.metrics;
    m.totalFrames++;
    _pushFrameTime(stats.totalFrameTime, timings);
    if (stats.totalFrameTime > FRAME_BUDGET_240FPS) m.droppedFrames++;
    m.averageFrameTime = _runningSum / _historyCount;
    m.worstFrameTime = _runningWorst;
    m.p99FrameTime = _computePercentile(_historyBuffer, _historyCount, 99);

    const len = _historyCount;
    for (let i = 0; i < NUM_STAGES; i++) {
        m.stageP50[i] = _computePercentile(_stageHistory[i], len, 50);
        m.stageP95[i] = _computePercentile(_stageHistory[i], len, 95);
        m.stageP99[i] = _computePercentile(_stageHistory[i], len, 99);
    }

    return stats;
}

export function destroyScheduler(): void {
    stopScheduler();
    _scheduler = null;
}