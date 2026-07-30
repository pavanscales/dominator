# Dominator Architecture

High-performance UI engine built on **Data-Oriented Design**. Compiles `.dnr` templates into SSA instruction sets, targeting the DOM directly. Runtime uses flat typed arrays indexed by integer IDs — zero per-object heap allocations.

## Architecture

```
.dnr Template
    │
    ▼
┌─────────┐   ┌─────────┐   ┌───────────┐   ┌─────────┐
│ PARSER  │ → │  SSA IR │ → │ OPTIMIZER │ → │ CODEGEN │ → Generated TS
└─────────┘   └─────────┘   └───────────┘   └─────────┘
                                                              │
                                                              ▼
                                                    @dominator/core
                                                    (flat-array reactive runtime)
                                                              │
                                                              ▼
                                                           DOM
```

---

## Runtime Core (`packages/core/src/`)

### Signal (`signal.ts`) — BARE METAL v8

All state in flat typed arrays. Signal = integer ID into `Float64Array`. Effect = integer ID into `()=>void[]`.

```
_f64:        Float64Array      ← signal values (number fast path)
_directEff:  (()=>void)[]      ← DIRECT effect callback (90% case, 3 array ops)
_subsData:   Int32Array         ← flat subscriber array (cache-friendly)
_effDepsData: Int32Array        ← flat dependency array
_jsDirtyBitmap: Uint32Array     ← JS-side dirty tracking (zero WASM calls)
```

- **Read**: `_f64[id]` — single float64 array access
- **Write**: `_f64[id]=val` → `_directEff[id]()` — 3 array ops + 1 function call
- **Direct-effect**: 90% of signals with 1 subscriber skip subscriber arrays entirely
- **Batch**: Generation-based dedup, O(1) nesting
- **WASM bridge**: Only for arena allocation (strings, objects) — numbers stay in JS

### Events (`events.ts`)

Direct property access (`__did` stamp) instead of WeakMap. CharCode dispatch instead of Map lookup. Flat Int32Array handler table indexed by `nodeId * EVENT_COUNT + typeIndex`. Event bitmask per node for O(1) early-exit when no handler registered. Pre-allocated `Node[128]` bubble path.

### Pool (`pool.ts`)

Power-of-2 ring buffer with bitmask wrap. O(1) get/release, no `Array.shift()`.

### DomCmd (`dom-cmd.ts`)

Jump-table dispatch DOM command buffer. Bounded string table with LRU eviction. Element ID recycling with generation tags. Opcode-based batch — single drain pass per frame.

### Router (`router.ts`)

Trie-based route matching — O(pathLength) instead of O(n) linear scan.

### SSR (`ssr.ts`)

Iterative stack serialization with `parts[] + join()`. `Map` instead of Record.

### Compiler (`compiler/`)

- **Parser**: `charCode()` checks instead of regex, pre-allocated token buffer
- **SSA**: Pre-allocated instruction buffer
- **Optimizer**: DCE + static folding
- **Codegen**: `parts[] + join()` instead of string concat

---

## Benchmark Results

Real browser benchmarks via **Playwright + Chrome DevTools Protocol** on Chromium.

| Benchmark | Result | Throughput |
|-----------|--------|-----------|
| Signal creation (100k/batch) | 367 ops/sec | **36.7M signals/sec** |
| Signal read (100k/batch) | 441 ops/sec | **44.1M reads/sec** |
| Signal write (100k/batch) | 520 ops/sec | **52M writes/sec** |
| Effect creation (10k/batch) | 1,317 ops/sec | **13.2M effects/sec** |
| Effect re-run (10k/batch) | 435 ops/sec | **4.35M re-runs/sec** |
| Batch update (10k/batch) | 447 ops/sec | **4.47M batched updates/sec** |
| Computed chain (1000 deep) | 3.4M ops/sec | Chain propagation |
| DOM create (10k/batch) | 60 ops/sec | **600K elements/sec** |
| DOM update (5k/batch) | 140 ops/sec | **700K updates/sec** |
| Full pipeline (5k signal→effect→DOM) | 154 ops/sec | **770K updates/sec** |
| Batch stress (10k) | 380 ops/sec | **3.8M batched/s** |
| **3000-particle sim (5s sustained)** | **496 FPS** | **~2ms/frame** |

### CDP Browser Metrics

| Metric | Value |
|--------|-------|
| DOM Nodes (final) | 40,220 |
| JS Event Listeners | 13 |
| JS Heap (before) | 0.51 MB |
| JS Heap (after) | 140.16 MB |
| Script Duration | 28.23s total |
| Layout Duration | 0.048s total |
| Layout Count | 13 |

### Key Numbers

- **52M** signal writes per second
- **4.35M** effect re-runs per second
- **770K** full pipeline (signal → effect → DOM) updates per second
- **496 FPS** sustained with 3000 particles over 5 seconds (~2ms per frame)
- **13** total DOM event listeners (delegated from root)
- **13** layout passes across entire benchmark suite

---

## Package Structure

```
dominator/
├── packages/
│   └── core/
│       └── src/
│           ├── compiler/    parse.ts, ssa.ts, optimize.ts, codegen.ts, vite-plugin.ts
│           ├── __tests__/   91 tests across 9 test files
│           ├── signal.ts    Flat-array reactive core (BARE METAL v8)
│           ├── subs-flat.ts WASM-backed subscriber arrays
│           ├── events.ts    Integer-ID event delegation
│           ├── dom-cmd.ts   Zero-allocation DOM command buffer
│           ├── css-batch.ts Zero-allocation style pipeline
│           ├── pool.ts      Ring buffer pool
│           ├── router.ts    Trie-based router
│           ├── ssr.ts       Server-side rendering
│           ├── arena.ts     WASM-backed typed arena allocator
│           ├── dom-pool.ts  Pre-allocated DOM node pool
│           ├── wasm-glue.ts WASM initialization bridge
│           ├── ultra-scene-editor.ts ECS-based DOM inspector
│           ├── index.ts     Public API
│           └── engine/      HPC ECS engine with frame pipeline
├── bench/
│   ├── index.html           Benchmark page (inlined framework)
│   ├── run.mts              Playwright + CDP benchmark runner
│   └── results/             JSON benchmark reports
├── vitest.config.ts         Test configuration
└── ARCHITECTURE.md          This file
```
