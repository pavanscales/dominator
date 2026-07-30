/**
 * WASM Glue: Loads and interfaces with the Zig WASM modules.
 *
 * Auto-initializes from the WASM binary on first getCore() call.
 * Falls back to checking globalThis.__DOMINATOR_WASM_INSTANCE__ for test env.
 *
 * PERFORMANCE: Cached TextEncoder, direct memory writes, zero-allocation paths.
 */

export interface CoreExports {
    init(): void;
    full_reset(): void;
    heap_base(): number;
    heap_grow(extra_words: number): number;
    heap_capacity(): number;
    heap_used(): number;
    arena_alloc_num(value: number): number;
    arena_alloc_bool(value: number): number;
    arena_alloc_obj(object_id: number): number;
    arena_alloc_str(byte_ptr: number, byte_len: number): number;
    arena_read_num(id: number): number;
    arena_read_tag(id: number): number;
    arena_read_bool(id: number): number;
    arena_write_num(id: number, value: number): number;
    arena_write_bool(id: number, value: number): number;
    arena_write_obj(id: number, object_id: number): number;
    arena_size(): number;
    arena_capacity(): number;
    arena_reset(): void;
    subs_init(signal_id: number): void;
    subs_add(signal_id: number, effect_id: number): void;
    subs_remove(signal_id: number, effect_id: number): void;
    subs_get_length(signal_id: number): number;
    subs_get_at(signal_id: number, index: number): number;
    subs_snapshot(signal_id: number, max_len: number): number;
    signal_track(signal_id: number): void;
    signal_mark_dirty(id: number): void;
    signal_flush_immediate(id: number): number;
    signal_flush_dirty(): number;
    batch_begin(): void;
    batch_depth(): number;
    batch_end(): number;
    effect_create(): number;
    effect_begin(id: number): void;
    effect_end(id: number): void;
    effect_dispose(id: number): void;
    effect_is_disposed(id: number): number;
    effect_count(): number;
    arena_compact(live_bitmap: number): number;
}

// Memory layout constants (matching Zig module — bit-packed dirty bitmap saves 63K words)
export const NUM_WORDS = 8192;
export const TAG_START = 8192;
export const BOOL_START = 12288;
export const SUB_OFFSET_START = 24576;
export const SUB_LENGTH_START = 28672;
export const DIRTY_BITMAP_START = 53248;
// Bit-packed: 65536 signals / 32 bits per word = 2048 words (was 65536 words)
export const SNAPSHOT_BUF_START = 55296;
export const DYNAMIC_START = 55808;

// Tag constants
export const TAG_NUMBER = 0;
export const TAG_STRING = 1;
export const TAG_BOOLEAN = 2;
export const TAG_OBJECT = 3;

let _core: CoreExports | null = null;
let _memory: WebAssembly.Memory | null = null;
let _f64View: Float64Array | null = null;
let _u32View: Uint32Array | null = null;
let _u8View: Uint8Array | null = null;
let _i32View: Int32Array | null = null;

// Cached encoder — never allocate a new one
const _encoder = new TextEncoder();

// Reusable buffer for string writing (grows if needed)
let _strWriteBuf: Uint8Array = new Uint8Array(256);

function _setupViews(): void {
    if (!_core || !_memory) return;
    // Must init() first to initialize the dynamic heap pointer
    _core.init();
    const buf = _memory.buffer;
    const offset = _core.heap_base();
    _f64View = new Float64Array(buf, offset);
    _u32View = new Uint32Array(buf, offset);
    _u8View = new Uint8Array(buf, offset);
    _i32View = new Int32Array(buf, offset);
}

function _trySyncLoad(): boolean {
    try {
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const cwd = process.cwd();
        const wasmPath = path.join(cwd, 'packages', 'core', 'dist', 'zig', 'dominator_core.wasm');
        if (!fs.existsSync(wasmPath)) return false;

        const wasmBytes = fs.readFileSync(wasmPath);
        const wasmModule = new WebAssembly.Module(wasmBytes);
        _memory = new WebAssembly.Memory({ initial: 1024, maximum: 8192 });
        const instance = new WebAssembly.Instance(wasmModule, { env: { memory: _memory } });
        _core = instance.exports as unknown as CoreExports;
        _setupViews();
        return true;
    } catch {
        return false;
    }
}

export function getCore(): CoreExports {
    if (_core) return _core;

    // Check globalThis for pre-loaded instance (test setup via vitest.setup.ts)
    const globalInstance = (globalThis as any).__DOMINATOR_WASM_INSTANCE__;
    if (globalInstance) {
        _memory = (globalInstance as any).env?.memory ?? (globalThis as any).__DOMINATOR_WASM_MEMORY__;
        _core = globalInstance.exports as unknown as CoreExports;
        if (!_memory) {
            _memory = (globalThis as any).__DOMINATOR_WASM_MEMORY__;
        }
        _setupViews();
        return _core!;
    }

    // Try synchronous filesystem load (Node.js / vitest)
    if (_trySyncLoad()) return _core!;

    throw new Error('[dominator] WASM core module not loaded. Call initCore() first.');
}

export function getMemory(): WebAssembly.Memory {
    if (!_memory) getCore();
    return _memory!;
}

export function getF64View(): Float64Array {
    if (!_f64View) getCore();
    return _f64View!;
}

export function getU32View(): Uint32Array {
    if (!_u32View) getCore();
    return _u32View!;
}

export function getU8View(): Uint8Array {
    if (!_u8View) getCore();
    return _u8View!;
}

export function getI32View(): Int32Array {
    if (!_i32View) getCore();
    return _i32View!;
}

/**
 * Initialize the WASM core module from a WebAssembly.Module or source URL.
 */
export async function initCore(source?: WebAssembly.Module | string | URL): Promise<CoreExports> {
    let wasmModule: WebAssembly.Module;

    if (source instanceof WebAssembly.Module) {
        wasmModule = source;
    } else if (typeof source === 'string' || source instanceof URL) {
        const response = await fetch(source instanceof URL ? source : source);
        wasmModule = await WebAssembly.compileStreaming(response);
    } else {
        const response = await fetch('/zig/dominator_core.wasm');
        wasmModule = await WebAssembly.compileStreaming(response);
    }

    _memory = new WebAssembly.Memory({ initial: 1024, maximum: 8192 });
    const imports = { env: { memory: _memory } };
    const instance = await WebAssembly.instantiate(wasmModule, imports);
    _core = instance.exports as unknown as CoreExports;
    _setupViews();
    return _core!;
}

/**
 * Initialize with a pre-instantiated module (for testing).
 */
export function initCoreSync(instance: WebAssembly.Instance, memory?: WebAssembly.Memory): CoreExports {
    _memory = memory ?? null;
    _core = instance.exports as unknown as CoreExports;
    if (!_memory) {
        _memory = (globalThis as any).__DOMINATOR_WASM_MEMORY__ ?? null;
    }
    _setupViews();
    return _core!;
}

/**
 * Refresh typed views after memory growth.
 */
export function refreshViews(): void {
    if (_core && _memory) _setupViews();
}

/**
 * Write a UTF-8 string into WASM memory at a temporary region.
 * Returns a word index (not byte offset) that can be passed to arena_alloc_str.
 *
 * PERFORMANCE: Uses encodeInto for zero-allocation encoding into reusable buffer,
 * then single bulk copy to WASM memory.
 */
export function writeStringToWasm(str: string): { ptr: number; len: number } {
    // Grow reusable buffer if needed
    if (str.length > _strWriteBuf.length) {
        _strWriteBuf = new Uint8Array(Math.max(str.length * 3, _strWriteBuf.length * 2));
    }

    // encodeInto writes directly into reusable buffer — zero intermediate allocation
    const { written } = _encoder.encodeInto(str, _strWriteBuf);
    const byteLen = written!;

    const u8 = getU8View();
    const ptr = DYNAMIC_START;

    // Bulk copy — single TypedArray.set call
    u8.set(_strWriteBuf.subarray(0, byteLen), ptr * 4);

    return { ptr, len: byteLen };
}
