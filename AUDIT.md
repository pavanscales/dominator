# Dominator Deep Audit — Ship-Ready Hunt

Date: 2026-08-05 · Scope: `packages/core/src` + Zig WASM core · Method: peak-failure invariant hunting, test-first, subtractive-by-default.

## 0. The Invariant (the contract everything is measured against)

> **For any signal write that changes value, every effect whose current dependency set includes that signal runs exactly once per dispatch, no effect whose set excludes it runs, and a throw in any one effect neither stops others nor corrupts tracking — regardless of batching, reentrancy, disposal, subscriber count, or signal/effect identity range.**

Second supporting invariant: **string/object values must round-trip through the value store without panic, leak, or alias.**

## 1. Baseline (fresh run, `vitest run packages/core/src/__tests__/`)

| Result | Count |
|---|---|
| Passed | 222 |
| Failed | 2 (same root cause) |

Both failures are the **same P0**: `arena_alloc_str` → Zig debug `memcpyAlias` panic → `RuntimeError: unreachable`.
- `arena.test.ts:22` — first string arena allocation
- `signal.test.ts:125` — `signal('hello')` in nested-effects test

## 2. Confirmed P0s (with evidence)

### P0-1 — Any string signal panics the WASM module
- Path: `arenaAllocStr` (arena.ts:56) → `writeStringToWasm` (wasm-glue.ts:287) → `arena_alloc_str` (dominator_core.zig:173).
- Root cause: the string **staging scratch** and the **arena string region** share the same base. `writeStringToWasm` writes at byte `DYNAMIC_START*4 + _strWriteOffset` (wasm-glue.ts:309). `arena_alloc_str` writes at word `DYNAMIC_START + _string_bytes_used/4` (zig:177). With both cursors starting at 0, the first allocation is a **self-copy**; Zig's `@memcpy` alias safety check traps → `unreachable`.
- Impact: `signal<string>` is unusable. Also the staging region, subscriber slots (`subAllocSlot` uses `DYNAMIC_START + slot`, zig:74-83), and string arena all share `DYNAMIC_START` → mutual overwrite is structurally guaranteed.
- Fix direction: stop storing strings in WASM; route string/object values through the JS value cache (already exists for id ≥ 4096). WASM keeps numbers only.

### P0-2 — A throwing effect wedges `_activeEffect` and aborts the whole drain
- `_runEffect` (signal.ts:586-610): `_activeEffect = id; _effectFns[id](); _activeEffect = -1;` — **no `try/finally`** (Zig path line 597-599, JS path line 606-608).
- If the effect body throws: (a) `_activeEffect` stays = id forever → every later tracked read is attributed to a dead effect → silent dep corruption; (b) the WASM `_active_effect` (set by `effect_begin`, zig:677) is also never reset; (c) the exception walks out of `_dispatchSet`/`_dispatchSignal`/`_flushDirty`/`batch`, aborting the drain so **other dirty effects never run** and `drainCmdBuffer()` never runs.
- Impact: one bad `effect()` bricks reactivity and rendering globally. No isolation at the dispatch layer (contrast: frame-scheduler `_safeStageRun` DOES isolate stages, frame-scheduler.ts:384).

### P0-3 — Reentrant `set()` during dispatch corrupts shared scratch buffers
- `_dispatchSignal` iterates subscribers via shared `_dispatchScratch` (signal.ts:724, written at 674/714). `_dispatchSnapshot` iterates shared `_snapCopy` (signal.ts:429, written at 634/700).
- If a subscriber calls `set()` during dispatch, the nested dispatch **overwrites the scratch/snapshot the outer loop is mid-way through** → outer loop reads wrong effect IDs → runs the wrong effects and/or skips real ones.
- Also `_flushDirty` resets `_jsDirtyCount = 0` and the bitmap **before** running effects (signal.ts:761-763); a reentrant set during dispatch appends to `_jsDirtyList` from index 0, overwriting unconsumed entries → dirty signals silently lost or double-run.
- No test covers this.

### P0-4 — WASM silently caps subscribers at 255
- `MAX_SUBS_PER_SIGNAL = 255` (dominator_core.zig:22); `subs_add` returns silently when full (zig:296-297).
- For a signal < 4096 with >255 subscribers, the **256th+ effect never receives the signal → permanently stale UI, no error**. The JS flat-array path has no cap. This is the invariant violated by construction.
- Fix: single JS dispatch authority (unbounded), remove the WASM subscriber path.

### P0-5 — Reactive bridge silently drops commands when the queue is full
- `_pushCmd` (reactive-bridge.ts:137): `if (needed > available) return; // Queue full, drop command`.
- A dropped `CMD_SIGNAL_SET` / `CMD_EFFECT_CREATE` means the worker never applies a value or never registers an effect → **stale state with zero signal**. No backpressure, no error path.

## 3. Confirmed P1s

### P1-1 — Element-ID collision → DOM mutations hit the wrong node
- `_getElemId` (dom-cmd.ts:113-147). When the 16384-slot table fills, the "first stale generation" fast path (line 123-132) reuses an id **without invalidating the previous occupant's `__domCmdId` or `_elemIds` entry**. Two live nodes then share an id; the drain resolves `_elemIds[id]` to whichever was written last → `setAttribute`/`textContent`/`style` applied to the wrong element.

### P1-2 — dom-cmd command buffer wraps and corrupts under load
- `_emit1/2/3` (dom-cmd.ts:70-94) write `_cmdBuf[w & CMD_BUF_MASK]` with **no bounds check**. Beyond 2^18 slots, writes wrap over unread commands → garbage commands applied, or the read head is overwritten. Buffer overflow is silent.

### P1-3 — render-graph command/GPU buffers silently drop commands on overflow
- `_emit8`/`_emit4` (render-graph.ts:229-252): `if (_cmdHead + N > CMD_BUF_SIZE) return;` — the command is dropped, no flag, no degradation. `_emitGPUVertex` (render-graph.ts:1004) same. Under >~262k rects/frame, the frame is silently incomplete.

### P1-4 — render-graph string interning can overwrite a live slot mid-frame
- `_intern` (render-graph.ts:150-223): when the table is full and nothing is evictable, slot 0 is overwritten (line 186-205). Commands emitted earlier in the **same frame** that reference slot 0 now resolve to a different string → wrong text/attr/style. Same defect class exists in dom-cmd `_intern` (dom-cmd.ts:42-73): eviction can invalidate a string id still referenced by an emitted-but-undrained command.

### P1-5 — Worker pool revokes the blob URL before workers finish loading
- `URL.createObjectURL(blob)` then `URL.revokeObjectURL(blobUrl)` immediately after spawning (worker-pool.ts:221/249). Per spec, revoking while a worker is still fetching can abort the load → a worker never starts → jobs never complete → `waitForPool` times out. Race, intermittent.

### P1-6 — `arena_compact` corrupts live signals
- `arenaCompact` (arena.ts:39) calls `arena_compact` (zig:764) which writes its remap table into `DYNAMIC_START` — the same region live subscriber slots occupy (`subAllocSlot`/`subFreeSlot`, zig:74-88) — and remaps signal ids without updating JS signal closures, `_subsPtr`, `_signalTags`, or the number value cache. Calling it on live signals = corruption. It is exported and callable but not wired into the scheduler.

### P1-7 — String writes leak WASM bytes unboundedly
- Every `arenaWriteStr` allocates a **new** string region (`arena_alloc_str` appends, `_string_bytes_used += byte_len`, zig:211) and replaces the slot id (arena.ts:127-136). Old bytes are never reclaimed (only `arena_reset`/`arena_compact` — and compact is broken per P1-6). A high-churn string signal grows WASM toward the 512 MB cap irreversibly. "Zero-GC" claim broken for strings.

### P1-8 — Event bubble-path pool is not exception/reentrancy safe
- `_acquireBubblePath`/`_resetBubblePaths` (events.ts:100-109). If a handler throws, `_resetBubblePaths()` (line 166) is skipped → pool index stays advanced and stale Node refs leak. If a handler synchronously re-dispatches an event, the nested dispatch can reuse the same pooled path array the outer loop is iterating → path corruption. No `try/finally`.

### P1-9 — The WASM batched-flush machinery is dead code (phantom "bulk flush")
- The WASM dirty bitmap is only written by `signal_mark_dirty` (zig:533), which is **never called in production** (grep: only `hpc-benchmarks.test.ts:289`). So `signal_flush_dirty()` (signal.ts:1076/1096/1295) always returns 0. Actual batching runs entirely on the JS dirty list.
- Meaning: "keeping the WASM bulk flush for batched perf" is impossible — there is nothing working to keep. This makes the single-JS-path de-duplication both required and lower-risk than feared.

### P1-10 — Compute-graph exposes a second, disconnected effect/dirty path
- `signal.set()` calls `markSignalDirty` (compute-graph.ts:361) in parallel with subscriber dispatch, and the engine has its own `registerEffectCallback`/`executeDirtyEffects` (compute-graph.ts:582) with a separate `_dirtyNodeList`. Two propagation authorities; the frame scheduler drains one, signal.ts the other. `executeDirtyEffects` has no per-effect try/catch (the frame stage wrapper catches, but effects run eagerly inside a stage callback still abort that stage).

## 4. Downgraded from earlier suspicion (honest corrections)

- **job-scheduler / worker-pool MPSC "data race"** — NOT a live race today: the shared queues have a single producer (the main thread). The write-slot-then-store-tail protocol is safe for SPSC/SP-multi-consumer (CAS on head arbitrates consumers; data is published before tail is visible). Correctness hazard only if arbitrary threads ever call `submitToPool`/`submitJob`; that is not possible from this codebase's threads. Keep the constraint documented, not fixed.

## 5. Structural root cause (multi-layer trace)

All of P0-2, P0-3, P0-4 and the fragile boundary logic trace to the same root: **the subscriber/dependency/dirty state has multiple authorities and multiple storage copies** —
1. WASM subscriber lists + WASM effect deps (`signal_track`, `subs_*`, `effect_*`)
2. direct-effect cache `_directEff`/`_directEffFirst` + migration code in `_addSub`
3. JS flat arrays `_subsFirst`/`_subsPtr`/`_subsLen`/`_subsData`
4. manual subs `_manualSubOffsets/_manualSubLens/_manualSubFns`
5. ID-threshold branching at 4096 (WASM vs JS) for values AND subscribers
6. cross-tier patch `_clearDirectEffForDeps` (signal.ts:565) whose sole purpose is reconciling WASM deps against the JS cache

The scratch/snapshot buffers and the try/finally gaps are **symptoms**. Model hygiene fix: collapse to the single JS flat-array subscriber/dirty authority (unbounded, already exercised by the fallback path); keep WASM for **number values only**; move strings/objects to the JS cache (also fixes P0-1 and P1-7).

## 6. Verified-good (no action, keep)

- Frame scheduler: per-stage try/catch, SKIP isolation, degrade model, ring-buffer percentiles, zero-allocation stats (frame-scheduler.ts).
- Bounded, generation-evicted intern tables (concept — the overwrite bugs above are in the fallback edges).
- JS dirty list + `_batchSeenGen` dedup design.
- ECS SoA layout and compute-graph growth paths (compute-graph.ts).

## 7. Fix plan (proof-gated, in order)

1. **P0-1 + P1-7**: route string/object values through the JS value cache; WASM numbers only. Kills the panic and the leak. (`arena.ts`, `signal.ts`, `wasm-glue.ts` — `writeStringToWasm`/staging becomes unused.)
2. **P0-2**: `try/finally` around the effect body; per-effect catch in the dispatch loop (isolate, log, continue) — mirroring `_safeStageRun`.
3. **P0-3**: dispatch iterates an immutable per-depth snapshot; effects enqueued during a run flush next round; don't reset `_jsDirtyCount` until the loop is done.
4. **P0-4**: delete WASM subscriber coupling (track/flush/subs) and the direct-effect cache → one JS authority, 255-cap gone.
5. **P1-1, P1-2**: fix `_getElemId` reuse to invalidate the prior occupant; add a headroom guard to dom-cmd emitters.
6. **P1-3, P1-4**: render-graph overflow → degradation flag instead of silent drop; guard intern-table slot-0 overwrite.
7. **P1-5**: don't revoke the blob URL until workers report ready.
8. **P1-6, P1-8**: disable `arena_compact` on live signals (document, gate); wrap event dispatch in try/finally.

Proof gates: adversarial tests (throw/reentrancy/>255 subs/boundary/string round-trip) written first and passing against the fixed code, then full suite + `pnpm typecheck`.
