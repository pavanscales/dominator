/**
 * WASM Test Setup: Loads Zig WASM modules for tests.
 * Runs in Node.js context (vitest setupFiles).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export default function setup() {
    const wasmPath = join(process.cwd(), 'packages', 'core', 'dist', 'zig', 'dominator_core.wasm');

    if (!existsSync(wasmPath)) {
        console.warn('[dominator] WASM binary not found at', wasmPath, '— tests will fail without WASM backend');
        return;
    }

    try {
        const wasmBytes = readFileSync(wasmPath);
        const module = new WebAssembly.Module(wasmBytes);
        const memory = new WebAssembly.Memory({ initial: 1024, maximum: 8192 });
        const instance = new WebAssembly.Instance(module, { env: { memory } });

        // Place on globalThis so wasm-glue.ts getCore() finds it
        (globalThis as any).__DOMINATOR_WASM_INSTANCE__ = instance;
        (globalThis as any).__DOMINATOR_WASM_MEMORY__ = memory;
    } catch (err) {
        console.error('[dominator] Failed to load WASM:', err);
    }
}
