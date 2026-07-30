import { defineConfig } from 'vite';
// @ts-ignore — module resolves at build time via workspaces
import { dominatorPlugin } from '../../core/src/compiler/vite-plugin';

export default defineConfig({
    plugins: [dominatorPlugin()],
});
