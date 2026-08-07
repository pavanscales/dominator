import { parse } from './parse';
import { ssa } from './ssa';
import { optimize } from './optimize';
import { flattenEffects } from './flatten';
import { reorderInstructions } from './reorder';
import { mergeEffectsByTarget } from './mergeEffectsByTarget';
import { hoistEffects } from './hoist';
import { codegen } from './codegen';
import { execSync } from 'node:child_process';
import path from 'node:path';

export interface DominatorPluginOptions {
    stateImportPath?: string;
    enableReorder?: boolean;
    enableHoisting?: boolean;
    buildWasm?: boolean;
}

interface VitePluginContext {
    error(msg: string): never;
}

let _wasmBuilt = false;

function buildZigWasm(zigDir: string): void {
    if (_wasmBuilt) return;
    try {
        const distDir = path.resolve(zigDir, '../../dist/zig');
        execSync(`mkdir -p "${distDir}"`, { stdio: 'pipe' });

        // Build core module (must match root build:wasm script — freestanding + wasm-ld)
        execSync(
            `zig build-obj -target wasm32-freestanding -fno-entry --name dominator_core "${path.join(zigDir, 'dominator_core.zig')}" -femit-bin="${path.join(distDir, 'dominator_core.o')}"`,
            { cwd: zigDir, stdio: 'pipe', timeout: 30000 }
        );
        execSync(
            `zig wasm-ld --no-entry --import-memory --export-all "${path.join(distDir, 'dominator_core.o')}" -o "${path.join(distDir, 'dominator_core.wasm')}"`,
            { cwd: zigDir, stdio: 'pipe', timeout: 30000 }
        );

        // Build physics module (same target + linker)
        execSync(
            `zig build-obj -target wasm32-freestanding -fno-entry --name physics "${path.join(zigDir, 'physics.zig')}" -femit-bin="${path.join(distDir, 'physics.o')}"`,
            { cwd: zigDir, stdio: 'pipe', timeout: 30000 }
        );
        execSync(
            `zig wasm-ld --no-entry --import-memory --export-all "${path.join(distDir, 'physics.o')}" -o "${path.join(distDir, 'physics.wasm')}"`,
            { cwd: zigDir, stdio: 'pipe', timeout: 30000 }
        );

        _wasmBuilt = true;
    } catch (err) {
        console.warn('[dominator] Zig WASM build failed:', err);
    }
}

export function dominatorPlugin(options: DominatorPluginOptions = {}) {
    const enableReorder = options.enableReorder !== false;
    const enableHoisting = options.enableHoisting !== false;
    const buildWasm = options.buildWasm !== false;

    return {
        name: 'vite-plugin-dominator',

// Build Zig WASM modules on server start
        buildStart() {
            if (buildWasm) {
                const zigDir = path.resolve(__dirname, '../../src/zig');
                buildZigWasm(zigDir);
            }
        },

        transform(this: VitePluginContext, code: string, id: string): { code: string; map: null } | null {
            if (!id.endsWith('.dnr')) return null;

            try {
                const ast = parse(code);
                let instructions = ssa(ast);
                instructions = optimize(instructions);
                instructions = flattenEffects(instructions);

                if (enableReorder) {
                    instructions = reorderInstructions(instructions);
                }

                // Dependency-aware merge: ALL effects on same target → single effect
                instructions = mergeEffectsByTarget(instructions);

                if (enableHoisting) {
                    instructions = hoistEffects(instructions);
                }

                const result = codegen(instructions, {
                    stateImportPath: options.stateImportPath,
                });
                return { code: result, map: null };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.error(`[dominator] Failed to compile ${id}: ${msg}`);
            }
        },
    };
}
