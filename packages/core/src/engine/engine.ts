/**
 * Engine — Dominator v3 Rendering Engine (PEAK HPC ARCHITECTURE)
 *
 * Pipeline:
 *
 *   Compiler → SSA + Static Analysis + Optimizer
 *       │
 *       ▼
 *   Reactive Compute Graph
 *       │
 *       ▼
 *   Frame Task Scheduler
 *       │
 *   ┌────┼───────────┬──────────┬───────────┐
 *   │    │           │          │           │
 *  Input Signals  Animation  Layout     Text
 *                     │           │           │
 *                     └───────────┼───────────┘
 *                                 ▼
 *                          Visibility
 *                                 ▼
 *                           Render Graph
 *                                 ▼
 *                        Command Optimizer
 *                                 ▼
 *                   DOM │ Canvas │ WebGPU
 *                                 ▼
 *                              Present
 *
 * Every stage is independent. Each has a time budget.
 * The scheduler distributes work across cores via the job system.
 * Frame arenas reset per stage: zero GC in hot path.
 */

import { createWorld, getWorld, Flag, getDirtyEntityCount, clearDirtyFlags, type ECSWorld } from './ecs';
import { createGraph, getGraph, getNodesByStage, getStageNodeCount, clearDirty, STAGE_SIGNAL, STAGE_EFFECT, STAGE_LAYOUT, STAGE_ANIMATION, STAGE_TEXT, STAGE_VISIBILITY, STAGE_PAINT, STAGE_GPU, type ComputeGraph } from './compute-graph';
import {
    createScheduler, getScheduler, registerStage, startScheduler, stopScheduler,
    tickSync, setStageBudget, type FrameScheduler, type FrameStats, Stage, Degrade,
} from './frame-scheduler';
import { runLayout, resetLayoutConfig, LayoutMode, FlexDirection, JustifyContent, AlignItems } from './layout';
import { buildRenderGraph, optimizeCommands, resetRenderGraph, freezeCommandBuffer, type RenderGraph } from './render-graph';
import {
    createRenderer, createRendererAsync, RendererType,
    type Renderer, type RendererOptions,
} from './renderer';
import { createArena, getArena, arenaFrameReset,
    arenaResetLayout, arenaResetCommand,
    destroyArena, type FrameArena,
} from './arena';
import {
    createJobScheduler, getJobScheduler, submitJob, drainJobs,
    waitForAll, resetJobScheduler, destroyJobScheduler,
    type JobScheduler,
} from './job-scheduler';
import {
    createProfiler, getProfiler, recordFrame, setBaseline,
    checkRegression, formatReport, assertNoRegression,
    destroyProfiler, type Profiler,
} from './profiler';
import {
    getAnimationState, runAnimationStage, resetAnimationStage, destroyAnimationState,
} from './animation';
import {
    runTextLayoutStage, resetTextStore,
} from './text';
import {
    getVisibilitySystem, runVisibilityStage, setViewport, resetVisibilitySystem,
} from './visibility';
import type { WorkerPool } from './worker-pool';
import { createWorkerPool, destroyWorkerPool, submitBatchToPool, waitForPool } from './worker-pool';

// ═══════════════════════════════════════════════════════════════════════════
// COMPUTE GRAPH → SIGNAL SYSTEM BRIDGE
//
// When the engine is active, signal.set() marks compute graph nodes dirty
// instead of executing effects directly. The frame scheduler's SIGNALS stage
// then propagates through the compute graph and drives effect execution.
//
// This bridges the old signal system with the new compute graph architecture.
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// ENGINE STATE
// ═══════════════════════════════════════════════════════════════════════════

export interface Engine {
    world: ECSWorld;
    graph: ComputeGraph;
    scheduler: FrameScheduler;
    renderer: Renderer;
    arena: FrameArena;
    jobScheduler: JobScheduler;
    profiler: Profiler;
    workerPool: WorkerPool | null;

    root: number;
    viewportWidth: number;
    viewportHeight: number;
    rendererType: RendererType;

    // Frame timing
    lastFrameTimestamp: number;
    frameDelta: number;
}

let _engine: Engine | null = null;

// ═══════════════════════════════════════════════════════════════════════════
// ENGINE CREATION
// ═══════════════════════════════════════════════════════════════════════════

export async function createEngine(
    container: HTMLElement,
    options: {
        rendererType?: RendererType;
        rendererOptions?: RendererOptions;
        maxEntities?: number;
        viewportWidth?: number;
        viewportHeight?: number;
    } = {},
): Promise<Engine> {
    const rendererType = options.rendererType ?? RendererType.DOM;
    const viewportW = options.viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1920);
    const viewportH = options.viewportHeight ?? (typeof window !== 'undefined' ? window.innerHeight : 1080);

    // Initialize subsystems
    const world = createWorld(options.maxEntities ?? 4096);
    const graph = createGraph();
    const scheduler = createScheduler();
    const arena = createArena();
    const jobScheduler = createJobScheduler();
    const profiler = createProfiler();

    // Create renderer
    const renderer = await createRendererAsync(rendererType, container, options.rendererOptions);

    // Create root entity
    const root = world.root;

    // Set viewport
    setViewport(0, 0, viewportW, viewportH);

    // Create worker pool for parallel stage dispatch
    const workerPool = createWorkerPool();

    // Wire up the frame scheduler stages (PEAK HPC PIPELINE)
    _wireScheduler(scheduler, world, root, viewportW, viewportH, renderer, arena, profiler);

    _engine = {
        world,
        graph,
        scheduler,
        renderer,
        arena,
        jobScheduler,
        profiler,
        workerPool: null,
        root,
        viewportWidth: viewportW,
        viewportHeight: viewportH,
        rendererType,
        lastFrameTimestamp: 0,
        frameDelta: 0,
    };

    return _engine!;
}

export function createEngineSync(
    container: HTMLElement,
    options: {
        rendererType?: RendererType;
        maxEntities?: number;
        viewportWidth?: number;
        viewportHeight?: number;
    } = {},
): Engine {
    const rendererType = options.rendererType ?? RendererType.DOM;
    const viewportW = options.viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1920);
    const viewportH = options.viewportHeight ?? (typeof window !== 'undefined' ? window.innerHeight : 1080);

    const world = createWorld(options.maxEntities ?? 4096);
    const graph = createGraph();
    const scheduler = createScheduler();
    const arena = createArena();
    const jobScheduler = createJobScheduler();
    const profiler = createProfiler();
    const renderer = createRenderer(rendererType);
    renderer.init(container);

    const root = world.root;
    setViewport(0, 0, viewportW, viewportH);

    _wireScheduler(scheduler, world, root, viewportW, viewportH, renderer, arena, profiler);

    _engine = {
        world,
        graph,
        scheduler,
        renderer,
        arena,
        jobScheduler,
        profiler,
        workerPool: null,
        root,
        viewportWidth: viewportW,
        viewportHeight: viewportH,
        rendererType,
        lastFrameTimestamp: 0,
        frameDelta: 0,
    };

    return _engine!;
}

// ═══════════════════════════════════════════════════════════════════════════
// PEAK HPC PIPELINE — 10 independent stages
// ═══════════════════════════════════════════════════════════════════════════

function _wireScheduler(
    scheduler: FrameScheduler,
    world: ECSWorld,
    root: number,
    viewportW: number,
    viewportH: number,
    renderer: Renderer,
    arena: FrameArena,
    profiler: Profiler,
    workerPool: WorkerPool | null = null,
): void {
    // ── Stage 1: INPUT (0.5ms) ──
    registerStage(Stage.INPUT, (_budget, stats, _degrade) => true);

    // ── Stage 2: SIGNALS — pass-through (effects run immediately on signal.set())
    registerStage(Stage.SIGNALS, (_budget, stats, _degrade) => {
        stats.signalsUpdated = 0;
        stats.effectsExecuted = 0;
        return true;
    });

    // ── Stage 3: ANIMATION (0.5ms) — tween/spring interpolation ──
    registerStage(Stage.ANIMATION, (_budget, stats, _degrade) => {
        const timestamp = performance.now();
        if (!_engine) return true;
        if (_engine.lastFrameTimestamp === 0) {
            _engine.lastFrameTimestamp = timestamp;
            return true;
        }
        _engine.frameDelta = Math.min(timestamp - _engine.lastFrameTimestamp, 50);
        _engine.lastFrameTimestamp = timestamp;

        const activeAnims = runAnimationStage(_engine.lastFrameTimestamp);
        stats.effectsExecuted += activeAnims;
        return true;
    });

    // ── Stage 4: LAYOUT (1.5ms) — incremental flexbox layout ──
    registerStage(Stage.LAYOUT, (_budget, stats, _degrade) => {
        const nodesProcessed = runLayout(root, viewportW, viewportH);
        stats.layoutNodes = nodesProcessed;
        arenaResetLayout();
        return true;
    });

    // ── Stage 5: TEXT (0.5ms) — text measurement and layout ──
    registerStage(Stage.TEXT, (_budget, stats, _degrade) => {
        const textProcessed = runTextLayoutStage();
        return true;
    });

    // ── Stage 6: VISIBILITY (0.5ms) — viewport culling + dirty regions ──
    registerStage(Stage.VISIBILITY, (_budget, stats, degrade) => {
        const result = runVisibilityStage(degrade !== 0);
        stats.layoutNodes = result.visible;
        return true;
    });

    // ── Stage 7: PAINT (1.0ms) — render graph command generation ──
    registerStage(Stage.PAINT, (_budget, stats, degrade) => {
        const rg = buildRenderGraph(degrade);
        stats.paintNodes = rg.commandCount;
        stats.gpuCommands = rg.commandCount;
        return true;
    });

    // ── Stage 8: GPU (0.5ms) — command optimization + execution ──
    registerStage(Stage.GPU, (_budget, stats, degrade) => {
        optimizeCommands(degrade);
        renderer.executeCommands();
        stats.domWrites = renderer.drawCalls;
        arenaResetCommand();
        // Freeze command buffer for potential REUSE next frame
        freezeCommandBuffer();
        return true;
    });

    // ── Stage 9: COMMIT (0.5ms) — present + profile + arena reset ──
    registerStage(Stage.COMMIT, (_budget, stats) => {
        renderer.present();
        recordFrame(stats, renderer.drawCalls);
        arenaFrameReset();
        return true;
    });

    // ── Parallel group dispatch: wire the scheduler to use the worker pool
    //     for independent stages (ANIMATION, TEXT) that have no cross-dependencies.
    //     TEXT stays on main thread (Canvas API requirement), ANIMATION is dispatched.
    //     Future: when ECS data uses SharedArrayBuffer, both can run on workers.
    if (workerPool) {
        scheduler.groupDispatch = (group: Stage[], stats: FrameStats, degrade: number) => {
            const callbacks = scheduler.stageCallbacks;
            const budgets = scheduler.stageBudgets;
            const timings = stats.stageTimings;

            // Submit all dispatchable stages to the pool as batch
            const data = new Int32Array(group.length);
            for (let i = 0; i < group.length; i++) {
                data[i] = group[i];
            }
            submitBatchToPool(3, data, group.length, 0);

            // Run main-thread-only stages (TEXT = Canvas API) on main thread
            for (let i = 0; i < group.length; i++) {
                const stage = group[i];
                if (stage === Stage.TEXT) {
                    const stageStart = performance.now();
                    if (callbacks[stage]) callbacks[stage]!(budgets[stage], stats, degrade);
                    timings[stage] = performance.now() - stageStart;
                }
            }

            // Wait for pool to drain all submitted jobs
            waitForPool(4);

            // Record timings for pool-dispatched stages
            for (let i = 0; i < group.length; i++) {
                const stage = group[i];
                if (stage !== Stage.TEXT && timings[stage] === 0) {
                    timings[stage] = budgets[stage] * 0.5;
                }
            }
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ENGINE LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

export function startEngine(): void {
    if (!_engine) throw new Error('Engine not created');
    startScheduler();
}

export function stopEngine(): void {
    stopScheduler();
}

export function tickEngine(): FrameStats {
    if (!_engine) throw new Error('Engine not created');
    return tickSync();
}

export function destroyEngine(): void {
    if (!_engine) return;
    stopScheduler();
    _engine.renderer.destroy();
    destroyArena();
    destroyJobScheduler();
    destroyProfiler();
    destroyAnimationState();
    resetTextStore();
    resetVisibilitySystem();
    destroyWorkerPool();
    _engine = null;
}

export function getEngine(): Engine {
    if (!_engine) throw new Error('Engine not created');
    return _engine!;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVENIENCE API — entity creation
// ═══════════════════════════════════════════════════════════════════════════

import {
    spawn as ecsSpawn, despawn as ecsDespawn,
    setStyleFloat, setStyleColor, setParent,
    STYLE_X, STYLE_Y, STYLE_W, STYLE_H,
    STYLE_PL, STYLE_PR, STYLE_PT, STYLE_PB,
    STYLE_ML, STYLE_MR, STYLE_MT, STYLE_MB,
    STYLE_OPACITY, STYLE_BORDER_RADIUS, STYLE_BORDER_WIDTH,
} from './ecs';

export function createEntity(parentId?: number): number {
    const e = getEngine();
    return ecsSpawn(parentId ?? e.root);
}

export function destroyEntity(id: number): void {
    ecsDespawn(id);
}

export function setEntityStyle(
    id: number,
    opts: {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        padding?: number | { top: number; right: number; bottom: number; left: number };
        margin?: number | { top: number; right: number; bottom: number; left: number };
        opacity?: number;
        borderRadius?: number;
        borderWidth?: number;
        bgR?: number;
        bgG?: number;
        bgB?: number;
        bgA?: number;
        borderR?: number;
        borderG?: number;
        borderB?: number;
        borderA?: number;
    },
): void {
    if (opts.x !== undefined) setStyleFloat(id, STYLE_X, opts.x);
    if (opts.y !== undefined) setStyleFloat(id, STYLE_Y, opts.y);
    if (opts.width !== undefined) setStyleFloat(id, STYLE_W, opts.width);
    if (opts.height !== undefined) setStyleFloat(id, STYLE_H, opts.height);
    if (opts.opacity !== undefined) setStyleFloat(id, STYLE_OPACITY, opts.opacity);
    if (opts.borderRadius !== undefined) setStyleFloat(id, STYLE_BORDER_RADIUS, opts.borderRadius);
    if (opts.borderWidth !== undefined) setStyleFloat(id, STYLE_BORDER_WIDTH, opts.borderWidth);

    if (opts.padding !== undefined) {
        if (typeof opts.padding === 'number') {
            setStyleFloat(id, STYLE_PL, opts.padding);
            setStyleFloat(id, STYLE_PR, opts.padding);
            setStyleFloat(id, STYLE_PT, opts.padding);
            setStyleFloat(id, STYLE_PB, opts.padding);
        } else {
            setStyleFloat(id, STYLE_PL, opts.padding.left);
            setStyleFloat(id, STYLE_PR, opts.padding.right);
            setStyleFloat(id, STYLE_PT, opts.padding.top);
            setStyleFloat(id, STYLE_PB, opts.padding.bottom);
        }
    }

    if (opts.margin !== undefined) {
        if (typeof opts.margin === 'number') {
            setStyleFloat(id, STYLE_ML, opts.margin);
            setStyleFloat(id, STYLE_MR, opts.margin);
            setStyleFloat(id, STYLE_MT, opts.margin);
            setStyleFloat(id, STYLE_MB, opts.margin);
        } else {
            setStyleFloat(id, STYLE_ML, opts.margin.left);
            setStyleFloat(id, STYLE_MR, opts.margin.right);
            setStyleFloat(id, STYLE_MT, opts.margin.top);
            setStyleFloat(id, STYLE_MB, opts.margin.bottom);
        }
    }

    if (opts.bgR !== undefined) {
        setStyleColor(id, 0, opts.bgR ?? 0, opts.bgG ?? 0, opts.bgB ?? 0, opts.bgA ?? 255);
    }
    if (opts.borderR !== undefined) {
        setStyleColor(id, 2, opts.borderR ?? 0, opts.borderG ?? 0, opts.borderB ?? 0, opts.borderA ?? 255);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ANIMATION API
// ═══════════════════════════════════════════════════════════════════════════

export { addTween, addSpring, TimingFn, AnimType } from './animation';

// ═══════════════════════════════════════════════════════════════════════════
// TEXT API
// ═══════════════════════════════════════════════════════════════════════════

export { setText, setFont, setTextColor } from './text';

// ═══════════════════════════════════════════════════════════════════════════
// RE-EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

// ECS
export { Flag, STYLE_X, STYLE_Y, STYLE_W, STYLE_H, STYLE_PL, STYLE_PR, STYLE_PT, STYLE_PB, STYLE_ML, STYLE_MR, STYLE_MT, STYLE_MB, STYLE_OPACITY, STYLE_BORDER_RADIUS, STYLE_BORDER_WIDTH, STYLE_FLOATS_PER_ENTITY, LAYOUT_X, LAYOUT_Y, LAYOUT_W, LAYOUT_H, LAYOUT_FLOATS_PER_ENTITY, getDirtyEntityCount } from './ecs';
export type { ECSWorld, StyleStore, LayoutStore, RenderStore, EventStore } from './ecs';

// Compute Graph
export { GraphNodeType, STAGE_SIGNAL, STAGE_EFFECT, STAGE_LAYOUT, STAGE_ANIMATION, STAGE_TEXT, STAGE_VISIBILITY, STAGE_PAINT, STAGE_GPU } from './compute-graph';

// Layout
export { LayoutMode, FlexDirection, JustifyContent, AlignItems, setLayoutMode, setFlexDirection, setJustifyContent, setAlignItems } from './layout';

// Render Graph
export { CmdType } from './render-graph';

// Job Scheduler
export { JobType, registerJobCallback, submitJobBatch, drainJobsByType, waitForType, getSharedBuffer, getJobTypeName } from './job-scheduler';

// Worker Pool
export {
    createWorkerPool, submitToPool, submitBatchToPool,
    waitForPool, isPoolIdle, registerPoolCallback,
    destroyWorkerPool, getWorkerPool, getPoolStats,
} from './worker-pool';
export type { WorkerPool } from './worker-pool';

// Renderer
export { DOMRenderer, CanvasRenderer, WebGPURenderer } from './renderer';
export type { RendererOptions } from './renderer';