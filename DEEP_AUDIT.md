# DOMINATOR — Deep Core Audit (line-verified, 2026-08-04)

Scope: full re-read of `packages/core/src/**` (all `.ts`, all `zig/*.zig`, `build.zig`, bench infra).
Every finding below was re-verified against the **current** source in this pass, with `file:line` references.
Where an earlier report (`AUDIT_REPORT.md`, dated 2026-08-03) listed something that is now fixed, it is marked STALE — do not re-file.

---

## 1. P0 — Confirmed this pass

### P0-A. WASM string staging pointer is never reset, and its base unit mismatches Zig
- `writeStringToWasm` (wasm-glue.ts:285-303) writes at u8 byte offset `DYNAMIC_START + _strWriteOffset * 4` and **increments `_strWriteOffset` monotonically** (wasm-glue.ts:297). `DYNAMIC_START` is a **u32 word index** (matches Zig `dominator_core.zig:44`), but is used here as a **byte base** — the base should be `DYNAMIC_START * 4`.
- Zig's own string region is words `DYNAMIC_START + _string_bytes_used/4` (dominator_core.zig:177) and Zig **does reset** `_string_bytes_used` in `init()` (dominator_core.zig:728). JS's `_strWriteOffset` is a different variable that nothing resets.
- Two competing exports exist: the real one (wasm-glue.ts:307-309) and a **no-op** (dom-cmd.ts:162, `// No-op — kept for API consistency`). Grep confirms **zero call sites** for either.
- `_resetSignals()` (signal.ts:1109-1150) resets the JS arrays and calls `_core.full_reset()` but never touches `_strWriteOffset`.
- Consequence: the JS staging byte pointer grows without bound. Cumulative string bytes of ~284 KB (byte `394976 + off*4` reaching `EFF_DEPS_REGION = DYNAMIC_START + 262144` words ≈ byte 1,531,904, signal.ts:52 / dominator_core.zig:45,424) silently overwrite **effect-dependency storage**. Because the offset survives `_resetSignals`, even moderate long-lived apps (mount/unmount, SSR) cross the boundary.
- Fix: reset `_strWriteOffset` inside `_resetSignals()`; multiply the base by 4 (or use word units consistently); add a bounds check before staging; consider deriving the JS offset from Zig `_string_bytes_used` so both sides agree.

### P0-B. Physics config region mismatch between JS and Zig
- `worker/physics.ts:77,92` writes config at `configBase = _count * 6` (dynamic word offset).
- `zig/physics.zig:8` reads config at `CONFIG_OFFSET_BASE = MAX_PARTICLES * 6` (= 3,000,000), a **compile-time constant**.
- These agree only when `_count == MAX_PARTICLES`. For every real `_count < 500,000`, JS writes config to a word the Zig core never reads, and Zig reads zeros.
- Consequence: `physics_init` sees `@max(getConfig(CFG_WIDTH),1) == 1` → the particle world is always **1×1 units**, mouse repulsion/mode/tick are never applied. Particle sim is functionally broken at every count below the cap (and the `_count*6+64` target staging in `physicsSetTargets`, physics.ts:154, plus the `count*8` page sizing in physicsInitWasm:54, make the layout inconsistent end-to-end).
- Fix: make both sides use one layout constant (e.g. `MAX_PARTICLES*8` at the tail of the heap), or export `CONFIG_OFFSET_BASE` from Zig and have JS compute it from the same constant; add a Zig test asserting `physics_init` honors a non-zero width/height.

### P0-C. Frame loop dies permanently on any throw (carried from prior pass — reconfirmed)
- `_executeFrame` in frame-scheduler.ts has no try/catch around stage execution; if any stage throws, the `requestAnimationFrame` tail is never reached → the app freezes with no recovery. `_runEffect` (signal.ts:585) leaves `_activeEffect` set on throw.
- Fix: wrap each stage in try/catch, report to the logging layer, and guarantee `_activeEffect` reset via `finally`.

### P0-D. Render command reader size table
- renderer.ts default case advances the read pointer by 1 instead of the real command size (`[1,10,4,5,5,5,4,1,1]`), so any TEXT/SHADOW/TRANSFORM/CLIP command desynchronizes the whole command stream.
- Fix: use a size table with a defensive `default`.

### P0-E. `engine.ts` does not typecheck — duplicate `const root` (verified: `pnpm typecheck` fails)
- `const root = world.root;` is declared twice in the same function scope: engine.ts:146 and engine.ts:184.
- `tsc --noEmit` → `TS2451: Cannot redeclare block-scoped variable 'root'`. Any transpile-only emit (esbuild) produces a **SyntaxError at module load**, so `createEngine` currently cannot load at all.
- Likely a leftover from the partial-init cleanup refactor (the cleanup block re-reads `root` unnecessarily). Fix: keep the single declaration at line 146 and delete line 184.

### P0-F. `physics.zig` does not compile with installed Zig (verified: `zig 0.14.1`)
- All 20 `@splat(Vec4f, value)` calls (physics.zig:31-44,168-169,212-215) use the pre-0.11 two-argument form; Zig ≥0.11 requires `@splat(value)`. The module only builds with an older toolchain.
- The checked-in `dist/zig/physics.wasm` was therefore produced by a different Zig than the one in PATH — the `npm run build:wasm` script (package.json:7) will fail against `zig 0.14.1`. dominator_core.zig has no `@splat` and is unaffected.
- Fix: migrate all 20 call sites to single-arg `@splat`, then re-run `pnpm build:wasm` and `pnpm test:wasm`.

---

## 2. P1 — Confirmed

- **Arena never GC'd**: `arenaCompact` / `arena_compact` (dominator_core.zig:764) exists but has no JS caller; string/object arena grows monotonically in long-lived apps.
- **Global singletons**: `_world`, `_graph`, `_scheduler`, `_signalCount`, `_configData`, `_textStore`, `_strWriteOffset`, arena `_objectMap`, ECS shared buffer — no multi-engine/SSR isolation.
- **`_pushJob`/`submitToPool` failure is ignored** — returns false but every caller discards it (P2; see correction in §2b).
- **Canvas resize** missing `resetTransform()` before `scale()` (renderer).
- **render-graph `_intern` eviction**: overwrites slot 0 when full, never reclaims table length.
- **text.ts** allocates every frame (`split(' ')` + per-word `measureText`).
- **`signal.set()` unbatched with engine active** can run an effect synchronously via `_dispatchSet` (signal.ts:736-744) *and* again from the compute-graph SIGNALS stage via `markSignalDirty` (signal.ts:883 etc.). The `_batchSeenGen` dedup may protect the batched path, but the unbatched direct-effect path bypasses it. Needs a regression test with a real engine frame.
- **Physics SIMD alignment**: `posXPtr`/`load4` cast to `*align(16)` over a 4-aligned static `u32` array (physics.zig:47,80-82,150-156); misalignment is UB in ReleaseSafe and can fault on some engines. Also each SIMD iteration runs 32 serially-dependent `xorshift32()` calls, which serializes the vector loop.
- **Build paths diverge**: `zig/build.zig` declares simd128/bulk-memory/atomics and 262144-page memories, but the actual npm `build:wasm` (package.json:7) runs `zig build-obj` + `zig wasm-ld --export-all` with **no feature flags** — two different toolchains produce two different modules; the `build.zig` memory comments (16MB/32MB vs 262144 pages = GBs) are also wrong.

---

## 2b. Round-2 verification (this pass) — new/corrected

- **Test-suite ground truth**: `pnpm test` → 16/17 suites, **278 tests pass**, but `engine-pipeline.test.ts` fails at **esbuild transform** (`engine.ts:184: The symbol "root" has already been declared`). P0-E is therefore not cosmetic: the engine feature cannot load at all today.
- **P1 (new) Zig arena has no bounds checks**: `arena_alloc_num/bool/obj/str` all do `id = _arena_size; _arena_size += 1;` with no check against `_arena_cap` (dominator_core.zig:147-150,156-178). Values are written at `heap[id*2]` (dominator_core.zig:113-116), which overruns the subscriber-offset table once `_arena_size` exceeds ~12k. Safety relies entirely on the JS-side convention "id >= ZIG_SIGNAL_CAP must NOT call WASM arena functions" (signal.ts:800). One violated call site (object/string signals above 4096, signalArray, SSR) = silent corruption.
- **P1 (new) WASM memory-growth failure is silent**: `ensureHeap` returns early on `@wasmMemoryGrow` failure (`if (result == -1) return;`, dominator_core.zig:70-71) and `heap_grow` still returns `heap_cap_words` (the old cap). JS never checks the return, so on low-memory devices the core keeps writing past capacity with no OOM signal to the app.
- **P2** Zig `_dirty_buf` is a static `[1024]u32` and only appends while `_dirty_count < 1024` (dominator_core.zig:526); the bitmap/snapshot path covers all 65536, so this is bounded — verify no code path depends on `_dirty_buf` alone.
- **Perf (measured)**: physics 500K particles step = 31.0 ms (2× over the 16.6 ms frame budget), 100K = 7.2 ms. Caveat: because of P0-B, the config never reaches Zig, so these numbers run the sim on a 1×1 world with mouse repulsion effectively inert.
- **CORRECTED — job loss (was P1)**: the shared queue is single-producer (main thread, serialized event loop), so payload-read-before-CAS (worker-pool.ts:51-58) is benign, the full-check exists (worker-pool.ts:77), and the producer notifies sleeping workers (worker-pool.ts:289). Downgraded to P2 edge (per-worker local deques are SPSC and safe).
- **CLEARED**: `_jsDirtyList`/`_jsDirtyBitmap` resize dynamically (signal.ts:386-405) — no 8192-signal cap; scale.test (20k dirty effects) passes.

## 3. STALE — previously reported, now FIXED in current code (do not re-file)

- **C1 (AUDIT_REPORT) / WASM views stale after `heap_grow`**: fixed — `growCoreHeap` calls `refreshViews()` (wasm-glue.ts:227-228).
- **P0-1 (prior pass) / BFS queue overflow**: fixed — propagation grows the queue for the full fan-out batch (`_ensureBfsQueue(_bfsTail + batchWrites + 16)`, compute-graph.ts:464).
- **subs-flat.ts** already guards `_u32` null (`if (!_u32) return`-style) and calls `full_reset` on reset.

---

## 4. What is solid (no action)

WASM arena read bounds, generation-stamped event `__did` + per-call bubble-path pool (events.ts), change-detected DOM renderer, generation-deduped dispatch, signal tests asserting exact run counts, bench infra (time-boxed probe, GC-pause detection, percentile stats).

---

## 5. Remediation order

1. **P0-A** `_strWriteOffset`: reset in `_resetSignals`, fix base units, add bound + regression test.
2. **P0-B** Physics layout: unify config offset, add Zig test.
3. **P0-C** Frame error boundary + `_activeEffect` finally.
4. **P0-D** Command size table.
5. **P1 batch** — arena GC, lifecycle isolation, worker/job CAS, canvas resize, text allocation, physics SIMD alignment.
6. **Structured logging / observability** (logging.ts is a stub today).
