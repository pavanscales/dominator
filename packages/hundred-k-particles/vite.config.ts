import { defineConfig } from 'vite';
// @ts-ignore — module resolves at build time via workspaces
import { dominatorPlugin } from '../core/src/compiler/vite-plugin.ts';

export default defineConfig({
    plugins: [dominatorPlugin({ buildWasm: false })],
    server: {
        port: 5174,
        headers: {
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
        },
    },
});
