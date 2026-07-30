/**
 * Vitest global setup — runs ONCE in Node.js before all test suites.
 * Encodes WASM as base64 for the per-file setup.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export default async function globalSetup() {
    const wasmPath = join(process.cwd(), 'packages', 'core', 'dist', 'zig', 'dominator_core.wasm');
    const outDir = join(process.cwd(), 'packages', 'core', 'dist', 'zig');

    if (!existsSync(wasmPath)) {
        console.warn('[dominator] WASM not found, tests will not have WASM backend');
        // Write empty marker
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'test_ready.flag'), 'no-wasm');
        return;
    }

    const wasmBytes = readFileSync(wasmPath);
    const b64 = wasmBytes.toString('base64');

    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'dominator_core.b64'), b64);
    writeFileSync(join(outDir, 'test_ready.flag'), 'ready');
    console.log('[dominator] WASM ready for tests (' + wasmBytes.length + ' bytes)');
}
