# DOMINATOR — Full Stack Deep Audit Report

Date: 2026-08-03
Scope: End-to-end audit of all source files, tests, build config, CI, and app packages

---

## CRITICAL BUGS (10)

### C1. WASM Memory Growth — Views Not Rebound After Growth
**File:** `packages/core/src/wasm-glue.ts`
**Impact:** Silent memory corruption — typed views become stale after WASM heap grows.
**Root Cause:** `initCore()` creates `WebAssembly.Memory` and binds typed views. When WASM grows memory via `heap_grow`, the JS typed views (`_f64View`, `_u32View`, etc.) still point to the old buffer. `refreshViews()` exists but is only called from `onViewRefresh` subscribers — nobody calls it after `heap_grow` in the hot path.
**Fix:** Call `refreshViews()` after every `heap_grow` call, or have the WASM module export a callback that JS registers.

### C2. Direct Effect Cache — No Bounds Check on `_directEffFirst` Access
**File:** `packages/core/src/signal.ts`
**Impact:** TypeError or silent failure when accessing disposed effects.
**Root Cause:** In `_dispatchSignalSubs`, `_directEffFirst[sigId]` is used to call `_runEffect(firstEff)` without checking if `firstEff` is a valid effect ID. If the effect was disposed but the direct cache wasn't cleared, `_effectFns[effId]` is `undefined`.
**Fix:** Add validity check before calling `_runEffect`.

### C3. `_clearDirectEffForDeps` — No Null Check on `_u32`
**File:** `packages/core/src/signal.ts`
**Impact:** Crash when WASM is not yet initialized.
**Root Cause:** `_clearDirectEffForDeps` accesses `_u32[...]` without checking if `_u32` is null. The `_ensureCore()` guard at the top of `signal()` doesn't protect this path.
**Fix:** Add `if (!_u32) return` at the start of `_clearDirectEffForDeps`.

### C4. `_runEffectList` — Missing `_activeEffect` Management
**File:** `packages/core/src/signal.ts`
**Impact:** Broken dependency tracking during batch dispatch.
**Root Cause:** `_runEffectList` calls `_runEffect` in a loop but doesn't set `_activeEffect` itself. If `_runEffect` throws, `_activeEffect` is left in an inconsistent state. More critically, `_trackSignal` checks `_activeEffect` to decide whether to track dependencies — if `_activeEffect` is -1 during batch dispatch, signals won't be tracked.
**Fix:** Set `_activeEffect` in `_runEffectList` around the loop.

### C5. `signalArray.setValues` — Batch Depth Not Decremented on Exception
**File:** `packages/core/src/signal.ts`
**Impact:** Permanent signal dispatch failure after exception.
**Root Cause:** `_jsBatchDepth++` is called before the loop, but if an exception occurs, `_jsBatchDepth--` is never reached. Subsequent `signal.set()` calls go through the wrong path (marking dirty instead of dispatching), causing missed updates.
**Fix:** Use try/finally to ensure `_jsBatchDepth--` always executes.

### C6. `_flushDirty` — Stale Direct Effect Cache After Disposal
**File:** `packages/core/src/signal.ts`
**Impact:** Wasted cycles calling disposed effects, potential crashes.
**Root Cause:** In `_flushDirty`, the JS-only fallback checks `_directEff` first, but if `_directEff` is set for a disposed effect, it calls `_runEffect` which checks `_effectDisposed` and returns early — this is safe but wasteful. The direct cache should be cleared on effect disposal.
**Fix:** Clear direct effect cache on `effect.dispose()`.

### C7. `_computePercentile` — Incorrect P99 for Small Samples
**File:** `packages/core/src/engine/frame-scheduler.ts`
**Impact:** P99 reported as minimum instead of 99th percentile for small sample sizes.
**Root Cause:** `const idx = (len * pct / 100) | 0` gives index 0 for `len < 100`, meaning P99 = min.
**Fix:** Use `const idx = Math.min(len - 1, (len * pct / 100) | 0)`.

### C8. Degradation Level Not Cleared Between Frames
**File:** `packages/core/src/engine/frame-scheduler.ts`
**Impact:** Frames that recover from budget overrun stay in degraded mode unnecessarily.
**Root Cause:** `degradeLevel` local variable is set when a frame exceeds budget but is never reset to 0 at the start of the next frame's stage group processing. The `stats.degradeLevel` is set but the local variable persists.
**Fix:** Reset `degradeLevel = 0` at the start of each frame iteration.

### C9. `_applyDegrade` — Degrade Flags Not Reset Between Frames
**File:** `packages/core/src/engine/frame-scheduler.ts`
**Impact:** Stale degradation flags persist across frames.
**Root Cause:** `_applyDegrade` resets all flags to 0 at the start, but this is called only when degradation is first detected. If a frame is fast enough to clear degradation, the flags from the previous degraded frame are not explicitly reset.
**Fix:** Ensure degradation flags are reset at the top of each frame (already done in `_executeFrame`).

### C10. `_getDirtyList` Returns Mutable Subarray
**File:** `packages/core/src/engine/ecs.ts`
**Impact:** Callers that store the dirty list and iterate it later see corrupted data.
**Root Cause:** `_getDirtyList()` returns `_dirtyList.subarray(0, _dirtyCount)` which is a view into the same buffer. If `clearDirtyFlags()` modifies `_dirtyList`, the stored subarray's contents change.
**Fix:** Return a copy (`_dirtyList.slice(0, _dirtyCount)`) or document the lifetime constraint.

---

## HIGH-SEVERITY ISSUES (23)

### H1. Entity ID -1 Used as Valid Entity After Shared Buffer Full
**File:** `packages/core/src/engine/ecs.ts`
**Impact:** Out-of-bounds array access, silent data corruption.
**Root Cause:** `_allocEntity` returns -1 when shared buffer is full, but callers (`spawn`, `setParent`, etc.) don't check for -1.

### H2. `_pushJob` — No Memory Barrier After Writing Job Data
**File:** `packages/core/src/engine/job-scheduler.ts`
**Impact:** Jobs may be read with partially written data on weakly-ordered architectures.
**Root Cause:** Regular stores to job data are not followed by a memory barrier before `Atomics.store` for the tail pointer.

### H3. `_popJob` — Race Condition on Shared Queue Head
**File:** `packages/core/src/engine/job-scheduler.ts`
**Impact:** Jobs can be "lost" for one poll cycle.
**Root Cause:** `head` and `tail` are loaded separately; between loads, another thread can push a job making `tail > head`, but the code returns null.

### H4. `_computeP99` — O(n²) Insertion Sort on Live Data
**File:** `packages/core/src/engine/profiler.ts`
**Impact:** P99 computation consumes significant CPU at 240fps.
**Root Cause:** Insertion sort is O(n²) for n=1000 samples, called every frame.

### H5. `_zWorld` — Cached Reference Stale After World Reset
**File:** `packages/core/src/engine/render-graph.ts`
**Impact:** Incorrect z-index values or crashes after world is destroyed and recreated.
**Root Cause:** `_zWorld` is cached and never invalidated when `destroyWorld()` is called.

### H6. `_typeIndex` — Only Supports 5 Event Types
**File:** `packages/core/src/events.ts`
**Impact:** Most DOM events (mouseenter, focus, blur, scroll, touchstart, etc.) are silently dropped.
**Root Cause:** CharCode-based dispatch only handles click, input, change, submit, keydown.

### H7. `_bubblePath` — Fixed Size Array, No Real Resize
**File:** `packages/core/src/events.ts`
**Impact:** Deep DOM trees (>128 levels) cause writes beyond array bounds.
**Root Cause:** `_bubblePath` is created with `new Array(128)` but `_bubblePathLen` is grown up to 2048. The array itself is never resized.

### H8. `_nodeHandlersFlat` — No Cleanup When DOM Node Removed
**File:** `packages/core/src/events.ts`
**Impact:** Memory leak for long-running applications with dynamic DOM.
**Root Cause:** When a DOM node is removed, its `__did` property and handler entries are never cleaned up.

### H9. String Intern Table Eviction Removes Strings Still Referenced in Command Buffer
**File:** `packages/core/src/dom-cmd.ts`
**Impact:** Command buffer operates on empty strings for evicted entries.
**Root Cause:** `_evictStrings` removes strings from `_strTable` but command buffer entries still reference the integer IDs.

### H10. `_elemIds` — Node References Not Cleaned on `_resetCmdBuffer`
**File:** `packages/core/src/dom-cmd.ts`
**Impact:** After reset, `_getElemId` returns r
