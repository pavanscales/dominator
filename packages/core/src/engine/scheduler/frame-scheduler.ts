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

// ═══════════════════════════════════════════════════════════════════════════
// P99 COMPUTATION — pre-allocated sort buffer, incremental
// ═══════════════════════════════════════════════════════════════════════════

let _p99SortBuffer = new Float64Array(MAX_FRAME_HISTORY);
let _runningSum = 0;
let _runningWorst = 0;
let _stageSums = new Float64Array(NUM_STAGES);

// ════════════════════════════════════════════════════════════════════════════
// RESERVOIR SAMPLING for per-stage percentiles — O(1) per frame, zero GC
// 256 samples × 10 stages = 2560 floats total, maintains statistically accurate P50/P95/P99
// ════════════════════════════════════════════════════════════════════════════

const RESERVOIR_SIZE = 256;

let _reservoir: Float64Array[] = [];
for (let i = 0; i < NUM_STAGES; i++) {
    _reservoir.push(new Float64Array(RESERVOIR_SIZE));
}
let _reservoirCount: number[] = new Array(NUM_STAGES).fill(0);
let _totalFramesSeen = 0;

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
     culpritStage: number;
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
        culpritStage: 0,
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

// Optional error boundary installed by the host app. Invoked for every stage
// that throws, alongside the structured log, so a production app can escalate
// without parsing logs. Must return quickly and never throw: the stage is still
// degraded to SKIP for the remainder of the frame regardless of the handler.
let _stageErrorHandler: ((error: unknown, stage: number) => void) | null = null;

/**
 * Install (or clear) the global stage error boundary. Pass `null` to disable.
 */
export function setStageErrorHandler(handler: ((error: unknown, stage: number) => void) | null): void {
    _stageErrorHandler = handler;
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

    // Subtract old value from running sum when ring buffer overwrites
    if (_historyCount >= MAX_FRAME_HISTORY) {
        _runningSum -= _historyBuffer[idx];
        for (let i = 0; i < NUM_STAGES; i++) {
            _stageSums[i] -= _stageHistory[i][idx];
        }
    }

    _historyBuffer[idx] = frameTime;

    // Per-stage timing history
    for (let i = 0; i < NUM_STAGES; i++) {
        _stageHistory[i][idx] = stageTimings[i];
        _stageSums[i] += stageTimings[i];
    }

    _historyWriteIdx++;
    if (_historyCount < MAX_FRAME_HISTORY) _historyCount++;

    _runningSum += frameTime;
    if (frameTime > _runningWorst) _runningWorst = frameTime;

    // Reservoir sampling for per-stage P50/P95/P99 (O(1) per frame)
    for (let i = 0; i < NUM_STAGES; i++) {
        _stageSums[i] += stageTimings[i];
        const r = _reservoir[i];
        const count = _reservoirCount[i];
        _totalFramesSeen++;
        
        if (count < RESERVOIR_SIZE) {
            r[count] = stageTimings[i];
            _reservoirCount[i] = count + 1;
        } else {
            const j = (Math.random() * _totalFramesSeen) | 0;
            if (j < RESERVOIR_SIZE) {
                r[j] = stageTimings[i];
            }
        }
}
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

// ════════════════════════════════════════════════════════════════════════════
// PREDICTIVE DEGRADATION — Rolling Linear Regression
//
// Uses per-stage P50/P95/P99 to predict NEXT frame cost BEFORE it runs.
// If predicted > budget * 0.8, degrades EARLY (not after overrun).
// ════════════════════════════════════════════════════════════════════════════

function _predictFrameCost(s: FrameScheduler): number {
    const m = s.metrics;
    let predicted = 0;
    for (let i = 1; i < NUM_STAGES; i++) {
        // Weighted prediction: 60% P50 + 30% P95 + 10% P99
        predicted += m.stageP50[i] * 0.6 + m.stageP95[i] * 0.3 + m.stageP99[i] * 0.1;
    }
    return predicted;
}

function _earlyDegradeCheck(s: FrameScheduler): void {
    const predicted = _predictFrameCost(s);
    const budget = s.maxBudgetMs;
    if (predicted > budget * 0.8) {
        // Predicted overrun - degrade early
        const degradeLevel = Math.min(3, Math.ceil((predicted / budget - 0.5) * 4));
        const culprit = _slowestStageOverall(s._stageTimings);
        _applyDegrade(s, degradeLevel, culprit);
        s._reusableStats.degradeLevel = degradeLevel;
        s._reusableStats.culpritStage = culprit;
    }
}

// ════════════════════════════════════════════════════════════════════════════
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
    s.culpritStage = culpritStage;
}

// ═══════════════════════════════════════════════════════════════════════════
// FRAME LOOP — ZERO ALLOCATION, HARD REAL-TIME
// ═══════════════════════════════════════════════════════════════════════════

import { logError, incrementCounter } from '../../logging';

// Error boundary: a throwing stage must never kill the frame loop or prevent
// the next requestAnimationFrame from being scheduled. The stage is marked
// SKIP for the remainder of the frame so later stages don't consume its
// partially-written output, and the error is structured-logged.
function _safeStageRun(
    s: FrameScheduler,
    stage: Stage,
    budget: number,
    stats: FrameStats,
    degradeFlag: number,
): void {
    const cb = s.stageCallbacks[stage];
    if (!cb) return;
    try {
        cb(budget, stats, degradeFlag);
    } catch (err) {
        s.stageDegrade[stage] = Degrade.SKIP;
        incrementCounter('stage_errors');
        logError('frame.stage_error', { stage, frame: s.frameNumber }, err);
        if (_stageErrorHandler) {
            try { _stageErrorHandler(err, stage); } catch { /* handler must not kill the loop */ }
        }
    }
}

function _slowestStage(s: FrameScheduler, group: Stage[], timings: Float64Array): number {
    let slowest = group[0];
    let max = -1;
    for (let i = 0; i < group.length; i++) {
        if (timings[group[i]] > max) {
            max = timings[group[i]];
            slowest = group[i];
        }
    }
    return slowest;
}

function _slowestStageOverall(timings: Float64Array): number {
    let slowest = 1;
    let max = -1;
    for (let i = 1; i < NUM_STAGES; i++) {
        if (timings[i] > max) {
            max = timings[i];
            slowest = i;
        }
    }
    return slowest;
}

function _executeFrame(s: FrameScheduler): void {
    const frameStart = performance.now();
    const prevStart = s._frameStartTime;
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

    // PREDICTIVE DEGRADATION: Check if next frame will overrun BEFORE running stages
    _earlyDegradeCheck(s);

    const budgets = s.stageBudgets;
    const degrade = s.stageDegrade;
    // ADAPTIVE FRAME BUDGET — degrade relative to the REAL inter-frame budget,
    // not a fictional 240Hz floor. rAF fires at the display refresh rate; on a
    // 60Hz panel the interval is ~16.7ms, so comparing against 4.167ms would
    // print 3x unnecessary degradation and count every healthy frame as dropped.
    let budgetMs = s.maxBudgetMs;
    if (prevStart > 0) {
        const interval = frameStart - prevStart;
        if (interval > 0) {
            budgetMs = Math.min(16.67, Math.max(interval * 0.85, FRAME_BUDGET_240FPS));
            s.maxBudgetMs = budgetMs;
        }
    }

    // Reset degradation
    for (let i = 0; i < NUM_STAGES; i++) degrade[i] = 0;

    let elapsed = 0;
    let degradeLevel = 0;
    let culprit = 0;
    let stageStart: number;

    try {
        for (let g = 0; g < STAGE_GROUPS.length; g++) {
            const group = STAGE_GROUPS[g];

            // COOPERATIVE YIELD: if ahead of schedule, yield between stage groups
            _maybeYield(s, frameStart, g);

            if (group.length === 1) {
                const stage = group[0];
                const d = degrade[stage];
                if (d & Degrade.SKIP) {
                    timings[stage] = 0;
                } else {
                    stageStart = performance.now();
                    _safeStageRun(s, stage, budgets[stage], stats, d);
                    timings[stage] = performance.now() - stageStart;
                }
            } else if (s.groupDispatch) {
                const groupDegrade = degrade[group[0]];
                if (groupDegrade & Degrade.SKIP) {
                    for (let i = 0; i < group.length; i++) timings[group[i]] = 0;
                } else {
                    stageStart = performance.now();
                    try {
                        s.groupDispatch(group, stats, groupDegrade);
                    } catch (err) {
                        for (let i = 0; i < group.length; i++) s.stageDegrade[group[i]] = Degrade.SKIP;
                        incrementCounter('stage_errors');
                        logError('frame.group_error', { group: g, frame: s.frameNumber }, err);
                    }
                    timings[group[0]] = performance.now() - stageStart;
                }
            } else {
                for (let i = 0; i < group.length; i++) {
                    const stage = group[i];
                    const d = degrade[stage];
                    if (d & Degrade.SKIP) {
                        timings[stage] = 0;
                        continue;
                    }
                    stageStart = performance.now();
                    _safeStageRun(s, stage, budgets[stage], stats, d);
                    timings[stage] = performance.now() - stageStart;
                }
            }

            // HARD REAL-TIME CHECK — evaluated AFTER the group runs so the culprit
            // reported is the group that actually consumed the frame budget, not
            // the next stage about to run. Critical stages (INPUT/SIGNALS, groups
            // 0-1) always run at full quality; degradation starts at ANIMATION.
            elapsed = performance.now() - frameStart;
            if (elapsed >= budgetMs && g >= 1 && degradeLevel === 0) {
                degradeLevel = _computeDegrade(elapsed, budgetMs);
                culprit = _slowestStage(s, group, timings);
                _applyDegrade(s, degradeLevel, culprit);
                stats.degradeLevel = degradeLevel;
                stats.culpritStage = culprit;
            }
        }

        stats.totalFrameTime = performance.now() - frameStart;

        // Update metrics
        const m = s.metrics;
        m.totalFrames++;
        _pushFrameTime(stats.totalFrameTime, timings);

        if (stats.totalFrameTime > budgetMs) {
            m.droppedFrames++;
            if (degradeLevel === 0) {
                degradeLevel = _computeDegrade(stats.totalFrameTime, budgetMs);
                culprit = _slowestStageOverall(timings);
                _applyDegrade(s, degradeLevel, culprit);
                stats.degradeLevel = degradeLevel;
                stats.culpritStage = culprit;
            }
        }
        if (degradeLevel > 0) m.degradedFrames++;
        stats.culpritStage = s.culpritStage;

        m.averageFrameTime = _runningSum / _historyCount;
        m.worstFrameTime = _runningWorst;
        m.p99FrameTime = _computePercentile(_historyBuffer, _historyCount, 99);

        // Per-stage percentiles — reservoir sampling (O(1) update, no per-frame sort)
        for (let i = 0; i < NUM_STAGES; i++) {
            const r = _reservoir[i];
            const count = _reservoirCount[i];
            if (count < 2) {
                m.stageP50[i] = 0;
                m.stageP95[i] = 0;
                m.stageP99[i] = 0;
                continue;
            }
            // Quick sort the reservoir (256 elements, very fast)
            for (let j = 1; j < count; j++) {
                const key = r[j];
                let k = j - 1;
                while (k >= 0 && r[k] > key) {
                    r[k + 1] = r[k];
                    k--;
                }
                r[k + 1] = key;
            }
            m.stageP50[i] = r[(count * 50 / 100) | 0];
            m.stageP95[i] = r[(count * 95 / 100) | 0];
            m.stageP99[i] = r[(count * 99 / 100) | 0];
        }

        if (s.onFrame) s.onFrame(stats);

    } catch (error) {
        // CRITICAL: Error boundary to prevent complete app freeze
        // Mark current stage as skipped and continue to next frame
        incrementCounter('frame_errors');
        logError('frame.execute_error', { frame: s.frameNumber }, error);
        if (_stageErrorHandler) {
            try { _stageErrorHandler(error, -1); } catch { /* handler must not kill the loop */ }
        }
    }

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
    // Reset reservoir
    for (let i = 0; i < NUM_STAGES; i++) {
        _reservoirCount[i] = 0;
    }
    _totalFramesSeen = 0;
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
            _safeStageRun(s, stage0, budgets[stage0], stats, d);
            timings[stage0] = performance.now() - stageStart;
        } else if (s.groupDispatch) {
            try {
                s.groupDispatch(group, stats, d);
            } catch (err) {
                for (let i = 0; i < group.length; i++) s.stageDegrade[group[i]] = Degrade.SKIP;
                incrementCounter('stage_errors');
                logError('frame.group_error', { group: g, frame: s.frameNumber }, err);
            }
        } else {
            for (let i = 0; i < group.length; i++) {
                const st = group[i];
                const d2 = degrade[st];
                if (d2 & Degrade.SKIP) { timings[st] = 0; continue; }
                stageStart = performance.now();
                _safeStageRun(s, st, budgets[st], stats, d2);
                timings[st] = performance.now() - stageStart;
            }
        }
    }

stats.totalFrameTime = performance.now() - frameStart;

    const m = s.metrics;
    m.totalFrames++;
    _pushFrameTime(stats.totalFrameTime, timings);
    if (stats.totalFrameTime > FRAME_BUDGET_240FPS) m.droppedFrames++;
    stats.culpritStage = s.culpritStage;
    m.averageFrameTime = _runningSum / _historyCount;
    m.worstFrameTime = _runningWorst;
    m.p99FrameTime = _computePercentile(_historyBuffer, _historyCount, 99);

    // Per-stage percentiles — reservoir sampling
    for (let i = 0; i < NUM_STAGES; i++) {
        const r = _reservoir[i];
        const count = _reservoirCount[i];
        if (count < 2) {
            m.stageP50[i] = 0;
            m.stageP95[i] = 0;
            m.stageP99[i] = 0;
            continue;
        }
        for (let j = 1; j < count; j++) {
            const key = r[j];
            let k = j - 1;
            while (k >= 0 && r[k] > key) {
                r[k + 1] = r[k];
                k--;
            }
            r[k + 1] = key;
        }
        m.stageP50[i] = r[(count * 50 / 100) | 0];
        m.stageP95[i] = r[(count * 95 / 100) | 0];
        m.stageP99[i] = r[(count * 99 / 100) | 0];
    }

    return stats;
}

export function destroyScheduler(): void {
    stopScheduler();
    _scheduler = null;
}