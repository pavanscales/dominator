# Changelog

## v0.3.0 - Production Hardening & Performance Optimization

### Performance (signal.ts)

**Reactive engine nuclear optimization:**
- Dirty tracking: `Uint8Array[65536]` bitmap replaces `Uint8Array[8192]` — covers virtually all apps, eliminates Set fallback for IDs >= 8192
- Batch draining: buffer-swap instead of copy+clear — swap two pointers instead of copying 65536 bytes per drain
- Snapshot buffer: inline `_snapBuf` (`Uint32Array`) replaces `.slice()` — zero allocation on every effect flush
- Dep array pooling: `_depPool` reuses `number[]` arrays — avoids GC pressure during effect re-creation
- Running effects bitmap: `Uint8Array[65536]` replaces `Set<number>` — zero hash overhead for deduplication
- Effect generation tracking: `Int32Array` replaces regular array

**Before → After (measured):**

| Benchmark | Before | After | Improvement |
|---|---|---|---|
| `signal.set()` x100K (no effects) | 5.1M ops/s | 9.3M ops/s | 1.8x |
| `set() + 1 effect` x100K | 0.4M ops/s | 1.5M ops/s | 3.8x |
| `3 computed chain` x100K | 0.1M ops/s | 0.5M ops/s | 5x |
| `batch(3000)` x100 | 5.4M ops/s | 15.3M ops/s | 2.8x |
| Viewport batching | 27K/s | 64K/s | 2.4x |
| Signal creation | 281/ms | 1443/ms | 5.1x |
| 10K signals bitmap | 18.5ms | 8.0ms | 57% faster |
| `computed()` read | 5.4M/s | 41.2M/s | 7.6x |

### Performance (events.ts)

- Event handler storage: flat `string[]` indexed by event type position replaces nested `Map<Function, string>` per type
- Pre-allocated handler arrays with growing strategy — no per-registration allocation
- Dynamic bubble path array (`64 → 1024` max element types) — no fixed upper bound
- `removeAllEventListeners()` for full cleanup

### Security

- **Compiler expression validation** (`codegen.ts`): blocks `require()`, `eval()`, `Function()`, `__proto__`, `process`, `import()` — rejects at compile time with clear error
- **SSR HTML escaping** (`ssr.ts`): `&`, `<`, `>`, `"`, `'` escaped — prevents XSS in server-rendered markup

### Type Safety (eliminated `any`)

- `vnode.ts`: `VNodeProps` typed as `Record<string, string | number | boolean | ((e: Event) => void) | undefined>`
- `mount.ts`: `_applyProps()` helper — no more `(el as any)[key]`
- `patch.ts`: Uses typed `_applyProps()`, fully typed
- `reconcile.ts`: Generic `ReconcileItem<T>`, indexed loops instead of `Map.forEach`
- `parse.ts`: `attributes` typed as `Record<string, string | boolean>`
- `compiler/ssa.ts`: `Instruction.args` typed as `(string | number | boolean)[]` instead of `any[]`
- `signal.ts`: All internal buffers typed (`Uint8Array`, `Uint32Array`, `Int32Array`)

### Compiler Improvements

- `codegen.ts`: configurable `stateImportPath` and `functionName` options
- `codegen.ts`: fixed identifier collector regex (was false-positiving on property chains)
- `optimize.ts`: real constant folding — arithmetic on numeric literals, boolean/string literals, adjacent text merging
- `vite-plugin.ts`: proper error handling

### Reactivity

- `signal()`: returns `Signal<T>` object with `.set()`, `.update()`, `.subscribe()` — `.set()` returns `boolean` (whether effect was scheduled)
- `EffectScope`: `effect()` returns `{ dispose() }` API
- Bounds checking on signal/effect IDs with dev-mode warnings (warn once per threshold)
- `getSignalCount()` / `getEffectCount()` introspection
- `batch()` synchronous execution — runs fn inline, flushes after

### Testing (183 tests, 14 files)

| Test File | Tests | Coverage |
|---|---|---|
| `signal.test.ts` | 21 | Read/write, effects, computed, batch, subscribe, dispose, multiple subscribers |
| `optimize.test.ts` | 9 | Dead code, constant folding, unused declarations |
| `pipeline.test.ts` | 21 | SSA, codegen, full pipeline, security validation, error handling |
| `perf.test.ts` | 18 | Time-based benchmarks: signal I/O, effects, computed, batch, memory/GC, extreme scale, dedup |
| `compiler.test.ts` | 21 | Parse, SSA, optimize, codegen, vite plugin |
| `stress-grid.test.ts` | 35 | Integration: DOM rendering, viewport updates, batch correctness |
| `ssr.test.ts` | 9 | Server rendering, hydration markers, HTML escaping |
| `events.test.ts` | 6 | Delegation, bubbling, capture, one-shot, dynamic elements |
| `reconcile.test.ts` | 6 | Diffing, keyed, children, typed interface |
| `patch.test.ts` | 8 | Props, events, styles, conditional |
| `vnode.test.ts` | 6 | Element/text/comment creation, props, children |
| `mount.test.ts` | 6 | Mount, props, events, children, namespace |
| `pool.test.ts` | 8 | Reuse, pre-allocation, return, type filtering |
| `core-benchmark.test.ts` | 9 | Stress grid benchmarks (3000 signals, viewport, fan-out, bitmap) |

### Infrastructure

- `packages/core/package.json`: npm-publishable config — `exports`, `types`, `files`, `sideEffects`, keywords, MIT license
- `.gitignore`: comprehensive — `generated/` dirs, IDE, coverage, artifacts
- `.github/workflows/ci.yml`: lint → test → build pipeline
- `tsconfig.base.json` + `stress-grid/tsconfig.json`: shared base config
- Root `package.json`: `clean`/`typecheck`/`lint` scripts
- Removed `nul` artifact files

### Bug Fixes

- `pixel-canvas/state.ts`: timer cleanup (`startRandomPaint`/`stopRandomPaint`), fixed `_drawAt` type casting
- `ralph-loop/state.ts`: responsive dimensions — uses `getWidth()`/`getHeight()` functions
- `events.ts`: cleanup of bubble path entries after traversal

---

## v0.2.0 - Compiler Pipeline

- SSA-based compiler pipeline: parse `.dnr` → SSA → optimize → codegen
- Vite plugin for `.dnr` files
- Dead code elimination, unused variable removal
- Event delegation system with automatic bubble/capture detection

## v0.1.0 - Initial

- Core reactive primitives: `signal()`, `effect()`, `computed()`, `batch()`
- DOM runtime: `mount()`, `patch()`, `reconcile()`
- VNode system with typed props
- SSR support
- Object pooling for signal/effect reuse
