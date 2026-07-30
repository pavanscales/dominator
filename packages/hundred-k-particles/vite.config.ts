import { defineConfig } from 'vite';
import { dominatorPlugin } from '@dominator/core/dist/compiler/vite-plugin';

export default defineConfig({
    plugins: [dominatorPlugin()],
});
