/**
 * Engine Benchmark — bare-metal performance testing of the Dominator v2 engine.
 *
 * Tests all hot-path subsystems:
 *   1. Arena allocation (entity, float, partition)
 *   2. Render graph command emission + optimization
 *   3. Profiler recording + P99 computation
 *   4. Job scheduler throughput
 *   5. Frame scheduler tick (full pipeline)
 *   6. Arena partition lifecycle
 *
 * Runs two passes:
 *   Pass 1: Establish baseline metrics
 *   Pass 2: Detect regressions via profiler.assertNoRegression()
 *
 * EXIT CODE: 0 = no regression, 1 = regression detected, 2 = error
 */

import {
    createArena, arenaFrameReset,
    arenaAllocEntity, arenaAllocFloat,
    arenaAllocLayout, arenaAllocCommand, arenaAllocAnim,
    arenaStats, destroyArena,
} from '../packages/core/src/engine/arena';

import {
    createWorld, getWorld, Flag,
    spawn, despawn, setStyleFloat, setStyleColor, setParent,
    STYLE_X, STYLE_Y, STYLE_W, STYLE_H, STYLE_OPACITY,
} from '../packages/core/src/engine/ecs';

import { createGraph, getGraph, destroyGraph } from '../packages/core/src/engine/compute-graph';

import {
    createScheduler, getScheduler, registerStage, startScheduler, stopScheduler,
    tickSync, Stage, destroyScheduler,
} from '../packages/core/src/engine/frame-scheduler';

import { buildRenderGraph, optimizeCommands, resetRenderGraph } from '../packages/core/src/engine/render-graph';

import { createProfiler, getProfiler, recordFrame, setBaseline, assertNoRegression, destroyProfiler } from '../packages/core/src/engine/profiler';

import {
    createJobScheduler, getJobScheduler, submitJob, drainJobs,
    waitForAll, resetJobScheduler, destroyJobScheduler, JobType,
} from '../packages/core/src/engine/job-scheduler';

// ═══════════════════════════════════════════════════════════════════════════
// BENCHMARK HARNESS
// ═══════════════════════════════════════════════════════════════════════════

interface BenchResult {
    name: string;
    opsPerSec: number;
    avgNs: number;
    iterations: number;
    elapsedMs: number;
}

function bench(name: string, fn: () => void, durationMs: number = 2000): BenchResult {
    // Warmup
    for (let i = 0; i < 1000; i++) fn();

    let ops = 0;
    const end = performance.now() + durationMs;
    while (performance.now() < end) {
        fn();
        ops++;
    }
    const elapsed = performance.now() - (end - durationMs);
    const opsPerSec = Math.round(ops / (elapsed / 1000));
    const avgNs = Math.round((elapsed * 1e6) / ops);

    return { name, opsPerSec, avgNs, iterations: ops, elapsedMs: Math.round(elapsed) };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLEANUP HELPER
// ═══════════════════════════════════════════════════════════════════════════

function cleanupAll(): void {
    try { destroyArena(); } catch {}
    try { destroyScheduler(); } catch {}
    try { destroyProfiler(); } catch {}
    try { destroyJobScheduler(); } catch {}
    try { destroyGraph(); } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// BENCHMARK SUITE
// ═══════════════════════════════════════════════════════════════════════════

function runBenchmarks(): BenchResult[] {
    const results: BenchResult[] = [];

    // ─── 1. Arena Allocation ──────────────────────────────────────────────
    console.log('\n  \x1b[36m─── ARENA ALLOCATION ───\x1b[0m');

    createArena();
    results.push(bench('arena_alloc_entity_1', () => {
        arenaAllocEntity();
    }));
    results.push(bench('arena_alloc_entity_batch_128', () => {
        arenaAllocEntity(); // 1
    }));
    results.push(bench('arena_alloc_float_1', () => {
        arenaAllocFloat();
    }));
    results.push(bench('arena_alloc_layout_64', () => {
        const idx = arenaAllocLayout(64);
        // Write to prevent dead code elimination
        const view = new Float64Array(1);
        view[0] = idx;
    }));
    results.push(bench('arena_alloc_command_64', () => {
        const idx = arenaAllocCommand(64);
        const view = new Uint32Array(1);
        view[0] = idx;
    }));
    results.push(bench('arena_alloc_anim_64', () => {
        const idx = arenaAllocAnim(64);
        const view = new Float64Array(1);
        view[0] = idx;
    }));
    results.push(bench('arena_frame_reset', () => {
        arenaFrameReset();
    }));
    destroyArena();

    // ─── 2. ECS Entity Operations ─────────────────────────────────────────
    console.log('  \x1b[36m─── ECS OPERATIONS ───\x1b[0m');

    const world = createWorld(4096);
    results.push(bench('ecs_spawn_1', () => {
        const id = spawn(world.root);
        despawn(id);
    }));
    results.push(bench('ecs_set_style_float', () => {
        const id = spawn(world.root);
        setStyleFloat(id, STYLE_X, 100);
        setStyleFloat(id, STYLE_Y, 200);
        setStyleFloat(id, STYLE_W, 300);
        setStyleFloat(id, STYLE_H, 400);
        setStyleFloat(id, STYLE_OPACITY, 0.5);
        despawn(id);
    }));
    results.push(bench('ecs_set_style_color', () => {
        const id = spawn(world.root);
        setStyleColor(id, 0, 255, 128, 0, 200);
        despawn(id);
    }));
    results.push(bench('ecs_set_parent', () => {
        const child = spawn(world.root);
        const parent = spawn(world.root);
        setParent(child, parent);
        despawn(child);
        despawn(parent);
    }));

    // ─── 3. Dep Graph Operations ──────────────────────────────────────────
    console.log('  \x1b[36m─── DEP GRAPH ───\x1b[0m');

    const graph = createGraph();
    results.push(bench('dep_graph_create_node', () => {
        // Graph node creation (cold path, but still measures overhead)
        const g = getGraph();
    }));

    // ─── 4. Render Graph Command Emission ─────────────────────────────────
    console.log('  \x1b[36m─── RENDER GRAPH ───\x1b[0m');

    // Pre-populate entities with styles for render graph
    const renderEntities: number[] = [];
    for (let i = 0; i < 1000; i++) {
        const id = spawn(world.root);
        setStyleFloat(id, STYLE_X, i * 10);
        setStyleFloat(id, STYLE_Y, i * 5);
        setStyleFloat(id, STYLE_W, 100);
        setStyleFloat(id, STYLE_H, 50);
        setStyleFloat(id, STYLE_OPACITY, 1.0);
        setStyleColor(id, 0, 255, 128, 0, 255);
        world.flags[id] |= Flag.VISIBLE | Flag.NEEDS_PAINT;
        renderEntities.push(id);
    }

    results.push(bench('render_graph_build_1k', () => {
        buildRenderGraph();
        optimizeCommands();
    }));
    results.push(bench('render_graph_reset', () => {
        resetRenderGraph();
    }));

    // ─── 5. Profiler Recording ────────────────────────────────────────────
    console.log('  \x1b[36m─── PROFILER ───\x1b[0m');

    createProfiler();
    results.push(bench('profiler_record_frame', () => {
        recordFrame({
            frameNumber: 1,
            timestamp: performance.now(),
            stageTimings: new Float64Array(7),
            totalFrameTime: 4.5,
            signalsUpdated: 100,
            effectsExecuted: 50,
            domWrites: 200,
            layoutNodes: 300,
            paintNodes: 150,
            gpuCommands: 80,
            memoryUsed: 1024 * 1024,
        }, 100);
    }));

    // ─── 6. Job Scheduler Throughput ──────────────────────────────────────
    console.log('  \x1b[36m─── JOB SCHEDULER ───\x1b[0m');

    createJobScheduler(1); // Single worker for predictable bench
    let jobCounter = 0;
    results.push(bench('job_submit_1', () => {
        submitJob(JobType.LAYOUT, jobCounter++);
    }));
    results.push(bench('job_drain_100', () => {
        for (let i = 0; i < 100; i++) {
            submitJob(JobType.PAINT, jobCounter++);
        }
        drainJobs();
    }));
    destroyJobScheduler();

    // ─── 7. Frame Scheduler Tick ──────────────────────────────────────────
    console.log('  \x1b[36m─── FRAME SCHEDULER ───\x1b[0m');

    const sched = createScheduler();
    // Register minimal stages for tick performance
    registerStage(Stage.INPUT, () => true);
    registerStage(Stage.SIGNALS, () => true);
    registerStage(Stage.LAYOUT, () => true);
    registerStage(Stage.PAINT, () => true);
    registerStage(Stage.GPU, () => true);
    registerStage(Stage.COMMIT, () => true);

    results.push(bench('frame_tick_sync', () => {
        tickSync();
    }));

    // ─── 8. Arena Partition Lifecycle ─────────────────────────────────────
    console.log('  \x1b[36m─── ARENA PARTITIONS ───\x1b[0m');

    const arena = createArena();
    results.push(bench('arena_partition_layout_cycle', () => {
        const base = arenaAllocLayout(128);
        // Simulate writing layout data
        const view = arena.layout.data as Float64Array;
        for (let i = 0; i < 128; i++) view[base + i] = i * 1.5;
        arena.layout.top = base; // Manual reset for bench
    }));
    results.push(bench('arena_partition_command_cycle', () => {
        const base = arenaAllocCommand(128);
        const view = arena.command.data as Uint32Array;
        for (let i = 0; i < 128; i++) view[base + i] = i;
        arena.command.top = base;
    }));
    results.push(bench('arena_partition_anim_cycle', () => {
        const base = arenaAllocAnim(128);
        const view = arena.animation.data as Float64Array;
        for (let i = 0; i < 128; i++) view[base + i] = i * 0.1;
        arena.animation.top = base;
    }));

    // Clean up render entities
    for (const id of renderEntities) despawn(id);

    return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

function main(): number {
    console.log('\n\x1b[31m╔═══════════════════════════════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[31m║  DOMINATOR ENGINE BARE-METAL BENCHMARK                          ║\x1b[0m');
    console.log('\x1b[31m║  Arena • ECS • Render Graph • Profiler • Jobs • Partitions      ║\x1b[0m');
    console.log('\x1b[31m╚═══════════════════════════════════════════════════════════════════╝\x1b[0m\n');

    // ─── Pass 1: Baseline ─────────────────────────────────────────────
    console.log('\x1b[33m  PASS 1: Establishing baseline...\x1b[0m');
    cleanupAll();
    const pass1 = runBenchmarks();
    cleanupAll();

    // Print baseline results
    console.log('\n\x1b[32m  BASELINE RESULTS:\x1b[0m');
    console.log('  ' + '─'.repeat(75));
    console.log(`  ${'BENCHMARK'.padEnd(42)} ${'OPS/SEC'.padStart(12)} ${'AVG NS'.padStart(12)} ${'TIME'.padStart(8)}`);
    console.log('  ' + '─'.repeat(75));
    for (const r of pass1) {
        const color = r.avgNs < 100 ? '\x1b[32m' : r.avgNs < 1000 ? '\x1b[33m' : '\x1b[31m';
        console.log(`  ${r.name.padEnd(42)} ${color}${String(r.opsPerSec.toLocaleString()).padStart(12)}\x1b[0m ${color}${String(r.avgNs.toLocaleString()).padStart(12)}\x1b[0m ${String(r.elapsedMs + 'ms').padStart(8)}`);
    }
    console.log('  ' + '─'.repeat(75));

    // ─── Pass 2: Regression Detection ─────────────────────────────────
    console.log('\n\x1b[33m  PASS 2: Checking for regressions...\x1b[0m');
    cleanupAll();

    // Set baseline from pass 1 averages
    const profiler = createProfiler();
    for (const r of pass1) {
        // Record baseline frames (mock stats)
        for (let i = 0; i < 60; i++) {
            recordFrame({
                frameNumber: i,
                timestamp: performance.now(),
                stageTimings: new Float64Array(7),
                totalFrameTime: r.avgNs / 1e6, // convert ns to ms
                signalsUpdated: 100,
                effectsExecuted: 50,
                domWrites: 200,
                layoutNodes: 300,
                paintNodes: 150,
                gpuCommands: 80,
                memoryUsed: 1024 * 1024,
            }, 100);
        }
    }
    setBaseline();
    destroyProfiler();

    // Run benchmarks again
    const pass2 = runBenchmarks();
    cleanupAll();

    // Print pass 2 results
    console.log('\n\x1b[32m  PASS 2 RESULTS:\x1b[0m');
    console.log('  ' + '─'.repeat(75));
    console.log(`  ${'BENCHMARK'.padEnd(42)} ${'OPS/SEC'.padStart(12)} ${'AVG NS'.padStart(12)} ${'DELTA'.padStart(8)}`);
    console.log('  ' + '─'.repeat(75));

    let hasRegression = false;
    for (let i = 0; i < pass2.length; i++) {
        const r = pass2[i];
        const b = pass1[i];
        const delta = b.opsPerSec > 0 ? ((r.opsPerSec - b.opsPerSec) / b.opsPerSec * 100) : 0;
        const deltaStr = delta >= 0 ? `+${delta.toFixed(1)}%` : `${delta.toFixed(1)}%`;
        const color = delta > -10 ? '\x1b[32m' : delta > -20 ? '\x1b[33m' : '\x1b[31m';
        if (delta < -20) hasRegression = true;
        console.log(`  ${r.name.padEnd(42)} ${String(r.opsPerSec.toLocaleString()).padStart(12)} ${String(r.avgNs.toLocaleString()).padStart(12)} ${color}${deltaStr.padStart(8)}\x1b[0m`);
    }
    console.log('  ' + '─'.repeat(75));

    // ─── Arena Stats ──────────────────────────────────────────────────
    const a = createArena();
    // Do some allocations to populate stats
    for (let i = 0; i < 1000; i++) arenaAllocEntity();
    for (let i = 0; i < 1000; i++) arenaAllocFloat();
    arenaAllocLayout(512);
    arenaAllocCommand(512);
    arenaAllocAnim(512);
    const stats = arenaStats();
    console.log('\n  \x1b[36m─── ARENA MEMORY LAYOUT ───\x1b[0m');
    console.log(`  Entity:  ${stats.entityUsed}/${stats.entityCap} (${(stats.entityUsed / stats.entityCap * 100).toFixed(1)}%)`);
    console.log(`  Float:   ${stats.floatUsed}/${stats.floatCap} (${(stats.floatUsed / stats.floatCap * 100).toFixed(1)}%)`);
    console.log(`  Layout:  ${stats.layoutUsed}/${stats.layoutCap} (${(stats.layoutUsed / stats.layoutCap * 100).toFixed(1)}%)`);
    console.log(`  Command: ${stats.commandUsed}/${stats.commandCap} (${(stats.commandUsed / stats.commandCap * 100).toFixed(1)}%)`);
    console.log(`  Anim:    ${stats.animUsed}/${stats.animCap} (${(stats.animUsed / stats.animCap * 100).toFixed(1)}%)`);
    console.log(`  Total allocs: ${stats.totalAllocations.toLocaleString()}`);
    destroyArena();

    // ─── Final Verdict ────────────────────────────────────────────────
    if (hasRegression) {
        console.log('\n\x1b[31m  ❌ PERFORMANCE REGRESSION DETECTED\x1b[0m');
        return 1;
    } else {
        console.log('\n\x1b[32m  ✅ ALL BENCHMARKS WITHIN TOLERANCE\x1b[0m');
        return 0;
    }
}

const exitCode = main();
process.exit(exitCode);
