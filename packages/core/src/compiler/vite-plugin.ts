import { parse } from './parse';
import { ssa } from './ssa';
import { optimize } from './optimize';
import { codegen } from './codegen';

export interface DominatorPluginOptions {
    stateImportPath?: string;
}

interface VitePluginContext {
    error(msg: string): never;
}

export function dominatorPlugin(options: DominatorPluginOptions = {}) {
    return {
        name: 'vite-plugin-dominator',
        transform(this: VitePluginContext, code: string, id: string): { code: string; map: null } | null {
            if (!id.endsWith('.dnr')) return null;

            try {
                const ast = parse(code);
                const instructions = ssa(ast);
                const optimized = optimize(instructions);
                const result = codegen(optimized, {
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
