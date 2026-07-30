import { defineConfig } from 'vite';
import path from 'node:path';
import { dominatorPlugin } from '../core/src/compiler/vite-plugin.ts';

export default defineConfig({
    plugins: [dominatorPlugin()],
    resolve: {
        alias: {
            '@dominator/core': path.resolve(__dirname, '../core/src/index.ts')
        }
    }
});
