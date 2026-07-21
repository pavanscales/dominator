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

### Signal (`signal.ts`)

All state in parallel flat arrays. Signal = integer ID into `_values[]`. Effect = integer ID into `_effectFns[]`.

```
_values:     any[]       ← signal values
_subs:       number[][]  ← signalId → effectId[]
_effectFns:  Function[]  ← effect functions
_effectDeps: number[][]  ← effectId → signalId[]
```

- **Read**: `_values[id]` — single array access
- **Write**: Direct set + dirty bitmap dedup (`Uint8Array[8192]`)
- **Batch**: `_batchDepth` counter, deferred notification, O(1) nesting
- **Cleanup**: Swap-remove on effect re-run — no unbounded subscriber growth

### Events (`events.ts`)

Integer node IDs via `WeakMap<Node, number>` + `Map<number, Map<string, Fn>>` handler table. Pre-allocated `Node[64]` bubble path.

### Pool (`pool.ts`)

Power-of-2 ring buffer with bitmask wrap. O(1) get/release, no `Array.shift()`.

### Reconcile (`reconcile.ts`)

Reusable `Map` with `.clear()` between calls. Pre-allocated result arrays.

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
│           ├── signal.ts    Flat-array reactive core
│           ├── batch.ts     Re-export
│           ├── events.ts    Integer-ID event delegation
│           ├── vnode.ts     VNode types + text cache
│           ├── mount.ts     VNode → DOM
│           ├── patch.ts     VNode diffing
│           ├── pool.ts      Ring buffer pool
│           ├── reconcile.ts Keyed list reconciliation
│           ├── router.ts    Trie-based router
│           ├── ssr.ts       Server-side rendering
│           └── index.ts     Public API
├── bench/
│   ├── index.html           Benchmark page (inlined framework)
│   ├── run.mts              Playwright + CDP benchmark runner
│   └── results/             JSON benchmark reports
├── vitest.config.ts         Test configuration
└── ARCHITECTURE.md          This file
```
