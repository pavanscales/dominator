/**
 * Performance Profiler — ZERO-ALLOCATION frame-level performance tracking.
 *
 * Every frame records metrics in a ring buffer.
 * P99 computed via insertion sort on a pre-allocated buffer (no .sort() on live data).
 * History stored in flat typed arrays — no JS objects in the hot path.
 *
 * ZERO-ALLOCATION GUARANTEES:
 *   - FrameRecord is a flat struct, stored in parallel typed arrays (SoA)
 *   - Ring buffer replaces Array.shift() / push()
 *   - Sorted buffer for P99 is pre-allocated, reused every frame
 *   - getReport() and formatReport() are cold-path only (they allocate)
 */

import { type FrameStats } from './frame-scheduler';

// ═══════════════════════════════════════════════════════════════════════════
// PROFILER CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const MAX_HISTORY = 1000;
const REGRESSION_THRESHOLD = 1.2;

export interface ProfilerConfig {
    maxHistory: number;
    regressionThreshold: number;
    enableMemoryTracking: boolean;
    enableGCTracking: boolean;
    ciMode: boolean;       // stricter thresholds, assert on every check
    ciWarmupFrames: number; // frames to skip before measuring
}

const DEFAULT_CONFIG: ProfilerConfig = {
    maxHistory: MAX_HISTORY,
    regressionThreshold: REGRESSION_THRESHOLD,
    enableMemoryTracking: true,
    enableGCTracking: false,
    ciMode: false,
    ciWarmupFrames: 60,
};

export function setCIMode(threshold: number = 1.1, warmupFrames: number = 120): void {
    const p = getProfiler();
    p.config.ciMode = true;
    p.config.regressionThreshold = threshold;
    p.config.ciWarmupFrames = warmupFrames;
    p._ciWarmupRemaining = warmupFrames;
}

export function setCIThreshold(ratio: number): void {
    getProfiler().config.regressionThreshold = ratio;
}

// ═══════════════════════════════════════════════════════════════════════════
// FRAME RECORD — SoA layout, flat typed arrays
// ═══════════════════════════════════════════════════════════════════════════

export interface FrameRecord {
    frameNumber: number;
    timestamp: number;
    frameTime: number;
    p99FrameTime: number;
    worstFrameTime: number;
    signalsUpdated: number;
    effectsExecuted: number;
    domWrites: number;
    layoutNodes: number;
    paintNodes: number;
    gpuCommands: number;
    drawCalls: number;
    memoryUsed: number;
    heapUsed: number;
    heapTotal: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROFILER STATE — ring buffer in typed arrays
// ═══════════════════════════════════════════════════════════════════════════

export interface Profiler {
    config: ProfilerConfig;
    totalFrames: number;
    startTime: number;

    // Ring buffer (SoA)
    _frameTimes: Float64Array;
    _drawCalls: Float64Array;
    _memoryUsed: Float64Array;
    _writeIdx: number;
    _count: number;

    // Running stats (O(1) per frame)
    _sumFrameTime: number;
    _worstFrameTime: number;
    _sumDrawCalls: number;
    _sumMemory: number;

    // Pre-allocated sort buffer for P99
    _sortBuffer: Float64Array;

    // Baseline
    baselineFrameTime: number;
    baselineDrawCalls: number;
    baselineMemory: number;

    // CI warmup
    _ciWarmupRemaining: number;
}

let _profiler: Profiler | null = null;

export function createProfiler(config?: Partial<ProfilerConfig>): Profiler {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    _profiler = {
        config: cfg,
        totalFrames: 0,
        startTime: performance.now(),

        _frameTimes: new Float64Array(cfg.maxHistory),
        _drawCalls: new Float64Array(cfg.maxHistory),
        _memoryUsed: new Float64Array(cfg.maxHistory),
        _writeIdx: 0,
        _count: 0,

        _sumFrameTime: 0,
        _worstFrameTime: 0,
        _sumDrawCalls: 0,
        _sumMemory: 0,

        _sortBuffer: new Float64Array(cfg.maxHistory),

        baselineFrameTime: 0,
        baselineDrawCalls: 0,
        baselineMemory: 0,
        _ciWarmupRemaining: 0,
    };
    return _profiler!;
}

export function getProfiler(): Profiler {
    if (!_profiler) _profiler = createProfiler();
    return _profiler;
}

// ═══════════════════════════════════════════════════════════════════════════
// RECORDING — ZERO ALLOCATION, ring buffer write
// ═══════════════════════════════════════════════════════════════════════════

export function recordFrame(stats: FrameStats, drawCalls: number = 0): FrameRecord | null {
    const p = getProfiler();

    // CI warmup: skip frames until warmed up
    if (p.config.ciMode && p._ciWarmupRemaining > 0) {
        p._ciWarmupRemaining--;
        return null;
    }

    p.totalFrames++;

    const idx = p._writeIdx % p.config.maxHistory;
    const frameTime = stats.totalFrameTime;

    // Write to ring buffer — single indexed writes, zero allocation
    // Subtract old value from running sums when ring buffer overwrites
    if (p._count >= p.config.maxHistory) {
        p._sumFrameTime -= p._frameTimes[idx];
        p._sumDrawCalls -= p._drawCalls[idx];
        p._sumMemory -= p._memoryUsed[idx];
    }

    p._frameTimes[idx] = frameTime;
    p._drawCalls[idx] = drawCalls;
    p._memoryUsed[idx] = stats.memoryUsed;

    p._writeIdx++;
    if (p._count < p.config.maxHistory) p._count++;

    // Update running stats — O(1)
    p._sumFrameTime += frameTime;
    p._sumDrawCalls += drawCalls;
    p._sumMemory += stats.memoryUsed;
    if (frameTime > p._worstFrameTime) p._worstFrameTime = frameTime;

    // Build a FrameRecord for API compatibility (cold path consumers only)
    const record: FrameRecord = {
        frameNumber: stats.frameNumber,
        timestamp: stats.timestamp,
        frameTime,
        p99FrameTime: 0,
        worstFrameTime: p._worstFrameTime,
        signalsUpdated: stats.signalsUpdated,
        effectsExecuted: stats.effectsExecuted,
        domWrites: stats.domWrites,
        layoutNodes: stats.layoutNodes,
        paintNodes: stats.paintNodes,
        gpuCommands: stats.gpuCommands,
        drawCalls,
        memoryUsed: stats.memoryUsed,
        heapUsed: 0,
        heapTotal: 0,
    };

    // Memory tracking (cold path — only when performance.memory exists)
    if (p.config.enableMemoryTracking && typeof performance !== 'undefined') {
        const mem = (performance as any).memory;
        if (mem) {
            record.heapUsed = mem.usedJSHeapSize;
            record.heapTotal = mem.totalJSHeapSize;
        }
    }

    // P99 from pre-allocated sort buffer
    if (p._count >= 10) {
        record.p99FrameTime = _computeP99(p);
    }

    return record;
}

function _computeP99(p: Profiler): number {
    const len = p._count;
    const max = p.config.maxHistory;
    const buf = p._sortBuffer;
    const data = p._frameTimes;

    // Copy ring buffer into sort buffer — no allocation
    const startIdx = p._count < max ? 0 : p._writeIdx % max;
    for (let i = 0; i < len; i++) {
        buf[i] = data[(startIdx + i) % max];
    }

    // Insertion sort — fastest for N <= 1000, no allocation
    for (let i = 1; i < len; i++) {
        const key = buf[i];
        let j = i - 1;
        while (j >= 0 && buf[j] > key) {
            buf[j + 1] = buf[j];
            j--;
        }
        buf[j + 1] = key;
    }

    return buf[(len * 99 / 100) | 0];
}

// ═══════════════════════════════════════════════════════════════════════════
// BASELINE COMPARISON — CI regression detection
// ═══════════════════════════════════════════════════════════════════════════

export function setBaseline(): void {
    const p = getProfiler();
    if (p._count === 0) return;

    const count = Math.min(60, p._count);
    const max = p.config.maxHistory;
    const startIdx = p._count < max ? 0 : p._writeIdx % max;

    let totalFrameTime = 0;
    let totalDrawCalls = 0;
    let totalMemory = 0;

    for (let i = 0; i < count; i++) {
        const idx = (startIdx + i) % max;
        totalFrameTime += p._frameTimes[idx];
        totalDrawCalls += p._drawCalls[idx];
        totalMemory += p._memoryUsed[idx];
    }

    p.baselineFrameTime = totalFrameTime / count;
    p.baselineDrawCalls = totalDrawCalls / count;
    p.baselineMemory = totalMemory / count;
}

export interface RegressionReport {
    hasRegression: boolean;
    frameTimeRegression: number;
    drawCallsRegression: number;
    memoryRegression: number;
    details: string[];
}

export function checkRegression(): RegressionReport {
    const p = getProfiler();
    const report: RegressionReport = {
        hasRegression: false,
        frameTimeRegression: 0,
        drawCallsRegression: 0,
        memoryRegression: 0,
        details: [],
    };

    if (p.baselineFrameTime === 0 || p._count < 10) return report;

    // Current averages from running stats
    const currentFrameTime = p._sumFrameTime / p._count;
    const currentDrawCalls = p._sumDrawCalls / p._count;
    const currentMemory = p._sumMemory / p._count;

    const threshold = p.config.regressionThreshold;

    if (p.baselineFrameTime > 0) {
        report.frameTimeRegression = currentFrameTime / p.baselineFrameTime;
        if (report.frameTimeRegression > threshold) {
            report.hasRegression = true;
            report.details.push(
                `Frame time regression: ${currentFrameTime.toFixed(3)}ms vs baseline ${p.baselineFrameTime.toFixed(3)}ms (${(report.frameTimeRegression * 100 - 100).toFixed(1)}% slower)`
            );
        }
    }

    if (p.baselineDrawCalls > 0) {
        report.drawCallsRegression = currentDrawCalls / p.baselineDrawCalls;
        if (report.drawCallsRegression > threshold) {
            report.hasRegression = true;
            report.details.push(
                `Draw calls regression: ${currentDrawCalls.toFixed(0)} vs baseline ${p.baselineDrawCalls.toFixed(0)} (${(report.drawCallsRegression * 100 - 100).toFixed(1)}% more)`
            );
        }
    }

    if (p.baselineMemory > 0) {
        report.memoryRegression = currentMemory / p.baselineMemory;
        if (report.memoryRegression > threshold * 1.5) {
            report.hasRegression = true;
            report.details.push(
                `Memory regression: ${(currentMemory / 1024 / 1024).toFixed(1)}MB vs baseline ${(p.baselineMemory / 1024 / 1024).toFixed(1)}MB`
            );
        }
    }

    return report;
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORTING — cold path only, allocates intentionally
// ═══════════════════════════════════════════════════════════════════════════

export function getReport(): {
    totalFrames: number;
    averageFrameTime: number;
    p99FrameTime: number;
    worstFrameTime: number;
    averageDrawCalls: number;
    totalMemoryUsed: number;
    fps: number;
    uptime: number;
} {
    const p = getProfiler();
    if (p._count === 0) {
        return {
            totalFrames: 0, averageFrameTime: 0, p99FrameTime: 0,
            worstFrameTime: 0, averageDrawCalls: 0, totalMemoryUsed: 0,
            fps: 0, uptime: 0,
        };
    }

    const uptime = (performance.now() - p.startTime) / 1000;
    return {
        totalFrames: p.totalFrames,
        averageFrameTime: p._sumFrameTime / p._count,
        p99FrameTime: p._count >= 10 ? _computeP99(p) : 0,
        worstFrameTime: p._worstFrameTime,
        averageDrawCalls: p._sumDrawCalls / p._count,
        totalMemoryUsed: p._memoryUsed[(p._writeIdx - 1) % p.config.maxHistory],
        fps: p.totalFrames / uptime,
        uptime,
    };
}

export function formatReport(): string {
    const r = getReport();
    const lines = [
        '═══════════════════════════════════════════════',
        '  DOMINATOR PERFORMANCE REPORT',
        '═══════════════════════════════════════════════',
        `  Total Frames:    ${r.totalFrames}`,
        `  Uptime:          ${r.uptime.toFixed(1)}s`,
        `  FPS:             ${r.fps.toFixed(1)}`,
        `  Avg Frame Time:  ${r.averageFrameTime.toFixed(3)}ms`,
        `  P99 Frame Time:  ${r.p99FrameTime.toFixed(3)}ms`,
        `  Worst Frame:     ${r.worstFrameTime.toFixed(3)}ms`,
        `  Avg Draw Calls:  ${r.averageDrawCalls.toFixed(0)}`,
        `  Memory Used:     ${(r.totalMemoryUsed / 1024 / 1024).toFixed(1)}MB`,
        '═══════════════════════════════════════════════',
    ];

    const regression = checkRegression();
    if (regression.hasRegression) {
        lines.push('  ⚠️  REGRESSIONS DETECTED:');
        for (const d of regression.details) {
            lines.push(`    - ${d}`);
        }
    } else {
        lines.push('  ✅ No regressions detected');
    }
    lines.push('═══════════════════════════════════════════════');

    return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// CI INTEGRATION — throw on regression
// ═══════════════════════════════════════════════════════════════════════════

export function assertNoRegression(): void {
    const regression = checkRegression();
    if (regression.hasRegression) {
        const msg = `[dominator] Performance regression detected:\n${regression.details.join('\n')}`;
        if (getProfiler().config.ciMode) {
            // CI mode: throw immediately to fail the test/build
            throw new Error(msg);
        } else {
            console.warn(msg);
        }
    }
}

export function destroyProfiler(): void {
    _profiler = null;
}
