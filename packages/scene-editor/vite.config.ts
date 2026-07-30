import { defineConfig } from 'vite';
// @ts-ignore — module resolves at build time via workspaces
import { dominatorPlugin } from '../../core/src/compiler/vite-plugin';
import path from 'path';

export default defineConfig({
    plugins: [dominatorPlugin()],
    resolve: {
        alias: {
            '@dominator/core': path.resolve(__dirname, '../core/src/index.ts'),
        },
    },
    server: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
});
