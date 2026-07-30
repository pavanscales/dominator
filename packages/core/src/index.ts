// ═══════════════════════════════════════════════════════════════════════════
// DOMINATOR — PEAK HPC RENDERING ENGINE
//
// Architecture (exact):
//
//                     Compiler
//                         │
//         SSA + Static Analysis + Optimizer
//                         │
//              Reactive Compute Graph
//                         │
//              Frame Task Scheduler
//                         │
//        ┌───────────┬────────────┬──────────┐
//        │           │            │          │
//      Layout     Text        Animation  Visibility
//        │           │            │          │
//        └───────────┴────────────┴──────────┘
//                         │
//                  Render Graph
//                         │
//               Command Optimizer
//                         │
//          DOM │ Canvas │ WebGPU
//                         │
//                      Present
//
// Every stage is independent. Each has a time budget.
// Frame arenas reset per stage: zero GC in hot path.
// No VDOM, no reconciliation, no tree diff, no patch walk.
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 1. COMPILER — SSA + Static Analysis + Optimizer
// ═══════════════════════════════════════════════════════════════════════════
export { reorderInstructions } from './compiler/reorder';
export { hoistEffects, isHoisted } from './compiler/hoist';
export { flattenEffects } from './compiler/flatten';

// ═══════════════════════════════════════════════════════════════════════════
// 2. REACTIVE COMPUTE GRAPH — signal → computed → effect → layout → paint → GPU
// ═══════════════════════════════════════════════════════════════════════════
export {
    createGraph as createDepGraph, getGraph as getDepGraph,
    addNode, addEdge as addEdgeToGraph,
    markSignalDirty, markEntityDirty, propagateDirty,
    getDirtyNodes, getNodesByStage, clearDirty, resetGraph,
} from './engine/compute-graph';
export {
    GraphNodeType as NodeType,
    STAGE_SIGNAL, STAGE_EFFECT, STAGE_LAYOUT,
    STAGE_ANIMATION, STAGE_TEXT, STAGE_VISIBILITY,
    STAGE_PAINT, STAGE_GPU,
} from './engine/compute-graph';

// ═══════════════════════════════════════════════════════════════════════════
// 3. FRAME TASK SCHEDULER — 10-stage pipeline with time budgets
// ═══════════════════════════════════════════════════════════════════════════
export {
    createScheduler, getScheduler, registerStage, setStageBudget,
    startScheduler, stopScheduler, tickSync,
    getMetrics, resetMetrics,
} from './engine/frame-scheduler';
export type { FrameScheduler, FrameStats, SchedulerMetrics } from './engine/frame-scheduler';
export { Stage } from './engine/frame-scheduler';

// ═══════════════════════════════════════════════════════════════════════════
// 4. LAYOUT ENGINE — incremental flexbox layout (dirty subtrees only)
// ═══════════════════════════════════════════════════════════════════════════
export {
    runLayout, resetLayoutConfig,
    setLayoutMode, setFlexDirection, setJustifyContent, setAlignItems,
} from './engine/layout';
export { LayoutMode, FlexDirection, JustifyContent, AlignItems } from './engine/layout';

// ═══════════════════════════════════════════════════════════════════════════
// 5. TEXT — layout & measurement
// ═══════════════════════════════════════════════════════════════════════════
export {
    setText, setFont, setTextColor,
    runTextLayoutStage, resetTextStore,
} from './engine/text';

// ═══════════════════════════════════════════════════════════════════════════
// 6. ANIMATION — tween/spring interpolation
// ═══════════════════════════════════════════════════════════════════════════
export {
    addTween, addSpring, getAnimationState,
    runAnimationStage, resetAnimationStage,
    TimingFn, AnimType,
} from './engine/animation';

// ═══════════════════════════════════════════════════════════════════════════
// 7. VISIBILITY — viewport culling system
// ═══════════════════════════════════════════════════════════════════════════
export {
    getVisibilitySystem, runVisibilityStage,
    setViewport, resetVisibilitySystem,
} from './engine/visibility';

// ═══════════════════════════════════════════════════════════════════════════
// 8. RENDER GRAPH — command generation + 5-pass optimizer
// ═══════════════════════════════════════════════════════════════════════════
export { buildRenderGraph, optimizeCommands, resetRenderGraph } from './engine/render-graph';
export type { RenderGraph } from './engine/render-graph';
export { CmdType } from './engine/render-graph';

// ═══════════════════════════════════════════════════════════════════════════
// 9. RENDERER BACKENDS — DOM │ Canvas │ WebGPU
// ═══════════════════════════════════════════════════════════════════════════
export {
    createRenderer, createRendererAsync, RendererType,
    DOMRenderer, CanvasRenderer, WebGPURenderer,
} from './engine/renderer';
export type { Renderer, RendererOptions } from './engine/renderer';

// ═══════════════════════════════════════════════════════════════════════════
// ENGINE — pipeline coordinator (creates all subsystems)
// ═══════════════════════════════════════════════════════════════════════════
export {
    createEngine, createEngineSync, getEngine,
    startEngine, stopEngine, tickEngine, destroyEngine,
    createEntity, destroyEntity, setEntityStyle,
} from './engine/engine';
export type { Engine } from './engine/engine';

// ═══════════════════════════════════════════════════════════════════════════
// ECS — Entity Component System (SoA storage, zero object overhead)
// ═══════════════════════════════════════════════════════════════════════════
export {
    createWorld as createECSWorld, getWorld as getECSWorld,
    spawn, despawn, setParent as setEntityParent,
    forEachChild as forEachEntityChild, forEachDescendant,
    getDirtyEntities, clearDirtyFlags,
    setStyleFloat, getStyleFloat, setStyleColor, getStyleColor,
    setLayoutRect, getLayoutRect, markLayoutDirty, markPaintDirty,
} from './engine/ecs';
export type { ECSWorld, StyleStore, LayoutStore, RenderStore, EventStore } from './engine/ecs';
export {
    Flag,
    STYLE_X, STYLE_Y, STYLE_W, STYLE_H,
    STYLE_PL, STYLE_PR, STYLE_PT, STYLE_PB,
    STYLE_ML, STYLE_MR, STYLE_MT, STYLE_MB,
    STYLE_OPACITY, STYLE_BORDER_RADIUS, STYLE_BORDER_WIDTH,
    STYLE_FLOATS_PER_ENTITY,
    LAYOUT_X, LAYOUT_Y, LAYOUT_W, LAYOUT_H,
    LAYOUT_FLOATS_PER_ENTITY,
} from './engine/ecs';

// ═══════════════════════════════════════════════════════════════════════════
// JOB SCHEDULER — multi-threaded job system (SharedArrayBuffer)
// ═══════════════════════════════════════════════════════════════════════════
export {
    createJobScheduler, getJobScheduler, submitJob, drainJobs,
    waitForAll, resetJobScheduler, destroyJobScheduler,
    registerJobCallback, submitJobBatch, drainJobsByType, waitForType,
    getSharedBuffer, getJobTypeName,
} from './engine/job-scheduler';
export { JobType } from './engine/job-scheduler';
export type { JobScheduler, Job } from './engine/job-scheduler';

// ═══════════════════════════════════════════════════════════════════════════
// FRAME ARENA — zero-allocation per-frame memory
// ═══════════════════════════════════════════════════════════════════════════
export {
    createArena as createFrameArena, getArena as getFrameArena,
    arenaFrameReset, arenaFullReset, arenaStats,
    arenaAllocEntity, arenaAllocFloat, arenaAllocString, arenaAllocTemp,
    arenaGetEntity, arenaGetFloat, arenaGetString, arenaGetTemp,
    arenaGetEntityView, arenaGetFloatView,
} from './engine/arena';
export type { FrameArena } from './engine/arena';

// ═══════════════════════════════════════════════════════════════════════════
// PROFILER — zero-allocation performance dashboard
// ═══════════════════════════════════════════════════════════════════════════
export {
    createProfiler, getProfiler, recordFrame, setBaseline,
    checkRegression, formatReport, assertNoRegression,
} from './engine/profiler';
export type { Profiler, FrameRecord, RegressionReport } from './engine/profiler';

// ═══════════════════════════════════════════════════════════════════════════
// WORKER POOL — parallel stage dispatch
// ═══════════════════════════════════════════════════════════════════════════
export {
    createWorkerPool, submitToPool, submitBatchToPool,
    waitForPool, isPoolIdle, registerPoolCallback,
    destroyWorkerPool, getWorkerPool, getPoolStats,
} from './engine/worker-pool';
export type { WorkerPool } from './engine/worker-pool';

// ═══════════════════════════════════════════════════════════════════════════
// PRESENTATION — app model
// ═══════════════════════════════════════════════════════════════════════════
export interface DominatorApp<T> {
    state: T;
    render: (state: T) => void;
}

export const createApp = <T>(initialState: T, renderFn: (state: T) => void): DominatorApp<T> => ({
    state: initialState,
    render: renderFn,
});

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY — Reactive signal API (maintained for backward compatibility)
// Will be deprecated once compiler targets compute graph directly.
// New code should use Engine v2 ECS + Compute Graph API above.
// ═══════════════════════════════════════════════════════════════════════════

// Core reactive API
export { signal, effect, computed, batch, flushSync, _resetSignals, getSignalCount, getEffectCount, signalArray } from './signal';
export type { Signal, EffectScope, SignalArray } from './signal';

// DOM event delegation
export { setupDelegation, addEventListener, removeEventListener, removeAllEventListeners } from './events';

// Object pool
export { Pool } from './pool';

// Router
export { path, navigate, createRouter } from './router';
export type { Route } from './router';

// SSR
export { renderToString } from './ssr';
export type { SSRInstruction } from './ssr';

// DOM utilities
export { DomPool, batchCreate, batchSetAttrs } from './dom-pool';
export { buildTransform, buildTransformRotate, setTransformVars, applyCssText, buildCellStyle, applyTransformsFromBuffer, applyFullFromBuffer } from './css-batch';

// DOM Command Buffer
export {
    cmdSetAttr, cmdSetStyle, cmdSetText, cmdAddClass, cmdRemoveClass,
    cmdToggleClass, cmdSetProp, cmdRemoveAttr, drainCmdBuffer, cmdBufferPending,
    cmdBufferSize, _resetCmdBuffer,
    OP_SET_ATTR, OP_SET_STYLE, OP_SET_TEXT, OP_ADD_CLASS, OP_RM_CLASS,
    OP_TOGGLE, OP_SET_PROP, OP_REMOVE_ATTR,
} from './dom-cmd';

// WASM-backed arena
export {
    arenaAllocNum, arenaAllocStr, arenaAllocBool, arenaAllocObj,
    arenaReadNum, arenaReadStr, arenaReadBool, arenaReadObj, arenaReadRaw,
    arenaWriteNum, arenaWriteStr, arenaWriteBool, arenaWriteObj, arenaWriteRaw,
    arenaSize, arenaReset, arenaGetNumView, arenaGetTagView, arenaCompact,
    TAG_NUMBER, TAG_STRING, TAG_BOOLEAN, TAG_OBJECT,
} from './arena';

// WASM-backed subscribers
export {
    subsInit, subsAdd, subsRemove, subsGetLength, subsGetAt,
    subsForEach, subsSnapshotInto, subsReset,
} from './subs-flat';

// WASM initialization
export { initCore, initCoreSync, refreshViews } from './wasm-glue';
export type { CoreExports } from './wasm-glue';

// Worker scheduler
export {
    createSharedLayout, getParticlePos, getParticleColor,
    setHeaderCommand, getHeaderCommand, waitCommand, signalReady,
    setHeaderInt, getHeaderInt,
    CMD_IDLE, CMD_READY, CMD_SWAP, CMD_SHUTDOWN,
    HEADER_SIZE, FLOATS_PER_PARTICLE,
} from './worker/scheduler';

// Worker physics
export {
    physicsInitWasm,
    physicsStep,
    physicsExplode,
    physicsSetTargets,
    physicsSetViewport,
    physicsSetMouse,
    physicsSetMode,
    physicsGetPositionX,
    physicsGetPositionY,
    physicsGetPositionsView,
    physicsGetCount,
} from './worker/physics';

// Worker-thread reactivity bridge
export {
    initReactiveBridge, shutdownReactiveBridge,
    readSignalF64, bridgeSignalCreate, bridgeSignalSet,
    bridgeEffectCreate, bridgeEffectBegin, bridgeEffectEnd,
    bridgeEffectDispose, bridgeSignalTrack,
    bridgeBatchBegin, bridgeBatchEnd,
} from './worker/reactive-bridge';